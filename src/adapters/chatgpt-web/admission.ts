import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";

/**
 * Account-level admission for ChatGPT Web turns.
 *
 * Every browser host in the launcher pool drives the same ChatGPT account, and ChatGPT throttles
 * that account on how many prompts it receives, whichever host or Codex task sent them. On Mars
 * two goals resumed together sent 109 requests in 18 minutes and both failed with
 * "too many requests"; one goal alone hit it at 33 requests in 10 minutes. Codex tasks, the
 * desktop app's own goal continuation and anything else a user starts all arrive here, so this is
 * the one place that can pace them.
 *
 * A turn waits in a fair queue until the account has budget and a host is free. The adapter keeps
 * heartbeating while it waits, so Codex sees a slow turn, never an error. A throttle observed by the
 * browser starts a cooldown and tightens the budget; retries of the throttled turn then wait out
 * the cooldown here instead of spending Codex's retry budget against a closed door.
 */

export interface AdmissionBudget {
  /** Maximum turns admitted in any 10-minute window. */
  req10: number;
  /** Maximum turns admitted in any 30-minute window. */
  req30: number;
}

export const ADMISSION_SEED: AdmissionBudget = { req10: 14, req30: 30 };
export const ADMISSION_FLOOR: AdmissionBudget = { req10: 6, req30: 15 };
export const ADMISSION_CEILING: AdmissionBudget = { req10: 24, req30: 60 };
const TEN_MINUTES = 10 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;
const COOLDOWN_MS = 20 * 60_000;
const COOLDOWN_CAP_MS = 2 * 60 * 60_000;
const REPEAT_THROTTLE_MS = 2 * 60 * 60_000;
const LOOSEN_AFTER_MS = 30 * 60_000;
const RECENT_MS = 24 * 60 * 60_000;
const RECENT_CAP = 500;

/** One admitted browser turn, kept for a day so a status page can show who used the account. */
export interface AdmissionTurnRecord {
  traceId: string;
  key: string;
  threadId?: string;
  model?: string;
  host?: string;
  queuedAt: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface AdmissionTurnInfo {
  threadId?: string;
  model?: string;
}

interface AdmissionState {
  version: 1;
  budget: AdmissionBudget;
  cooldownUntil: number;
  cooldownMs: number;
  lastThrottleAt: number;
  lastAdjustAt: number;
  admitted: number[];
  recent: AdmissionTurnRecord[];
}

interface Waiter {
  key: string;
  traceId: string;
  enqueuedAt: number;
  info?: AdmissionTurnInfo;
  admit: (release: (error?: string) => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface AdmissionOptions {
  statePath?: string;
  maxConcurrent: number;
  now?: () => number;
  log?: (message: string) => void;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ChatGptAdmission {
  private state: AdmissionState;
  private running = 0;
  /** Waiters per task, served round-robin so one busy task cannot starve the others. */
  private readonly queues = new Map<string, Waiter[]>();
  private readonly order: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly setTimer: NonNullable<AdmissionOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AdmissionOptions["clearTimer"]>;

  constructor(private readonly options: AdmissionOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (message => console.info(message));
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
    this.state = this.read();
  }

  /**
   * Resolve with a release function once the turn may run; reject if its signal aborts first.
   * Pass the turn's error message to release when it failed, so the status record shows it.
   */
  acquire(key: string, traceId: string, signal?: AbortSignal, info?: AdmissionTurnInfo): Promise<(error?: string) => void> {
    if (signal?.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, traceId, enqueuedAt: this.now(), info, admit: resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.remove(waiter);
          reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (!this.queues.has(key)) {
        this.queues.set(key, []);
        this.order.push(key);
      }
      this.queues.get(key)!.push(waiter);
      this.write();
      this.pump();
    });
  }

  /** Record which pool host an admitted turn landed on. */
  noteHost(traceId: string, host: string): void {
    const record = this.findRecord(traceId);
    if (!record) return;
    record.host = host;
    this.write();
  }

  /** The browser saw ChatGPT refuse a prompt for rate: cool down and tighten. */
  noteThrottle(): void {
    const now = this.now();
    const repeat = this.state.lastThrottleAt > 0 && now - this.state.lastThrottleAt < REPEAT_THROTTLE_MS;
    this.state.cooldownMs = repeat ? Math.min(COOLDOWN_CAP_MS, this.state.cooldownMs * 2) : COOLDOWN_MS;
    this.state.cooldownUntil = now + this.state.cooldownMs;
    this.state.lastThrottleAt = now;
    this.state.lastAdjustAt = now;
    this.state.budget = {
      req10: Math.max(ADMISSION_FLOOR.req10, Math.floor(this.state.budget.req10 * 0.7)),
      req30: Math.max(ADMISSION_FLOOR.req30, Math.floor(this.state.budget.req30 * 0.7)),
    };
    this.write();
    this.log(`[chatgpt-web] admission throttled: cooldown ${Math.round(this.state.cooldownMs / 60_000)}m, `
      + `budget ${this.state.budget.req10}/10m ${this.state.budget.req30}/30m`);
    this.schedule();
  }

  snapshot(): { budget: AdmissionBudget; running: number; queued: number; cooldownUntil: number; recent10: number; recent30: number } {
    const now = this.now();
    this.prune(now);
    return {
      budget: { ...this.state.budget },
      running: this.running,
      queued: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
      cooldownUntil: this.state.cooldownUntil,
      recent10: this.state.admitted.filter(at => at > now - TEN_MINUTES).length,
      recent30: this.state.admitted.length,
    };
  }

  private pump(): void {
    const now = this.now();
    this.prune(now);
    this.loosen(now);
    while (this.canAdmit(now)) {
      const waiter = this.next();
      if (!waiter) break;
      this.running += 1;
      this.state.admitted.push(now);
      const record: AdmissionTurnRecord = {
        traceId: waiter.traceId, key: waiter.key, queuedAt: waiter.enqueuedAt, startedAt: now,
        ...(waiter.info?.threadId ? { threadId: waiter.info.threadId } : {}),
        ...(waiter.info?.model ? { model: waiter.info.model } : {}),
      };
      this.state.recent.push(record);
      this.write();
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      const waited = now - waiter.enqueuedAt;
      if (waited >= 1_000) {
        this.log(`[chatgpt-web] admission turn ${waiter.traceId} admitted after ${Math.round(waited / 1_000)}s`);
      }
      let released = false;
      waiter.admit(error => {
        if (released) return;
        released = true;
        this.running -= 1;
        record.endedAt = this.now();
        if (error) record.error = error.slice(0, 200);
        this.write();
        this.pump();
      });
    }
    this.schedule();
  }

  private findRecord(traceId: string): AdmissionTurnRecord | undefined {
    for (let index = this.state.recent.length - 1; index >= 0; index -= 1) {
      if (this.state.recent[index]!.traceId === traceId) return this.state.recent[index];
    }
    return undefined;
  }

  private canAdmit(now: number): boolean {
    if (this.running >= this.options.maxConcurrent || now < this.state.cooldownUntil) return false;
    const recent10 = this.state.admitted.filter(at => at > now - TEN_MINUTES).length;
    return recent10 < this.state.budget.req10 && this.state.admitted.length < this.state.budget.req30;
  }

  private next(): Waiter | undefined {
    for (let tries = 0; tries < this.order.length; tries += 1) {
      const key = this.order.shift()!;
      const queue = this.queues.get(key);
      if (!queue?.length) {
        this.queues.delete(key);
        continue;
      }
      const waiter = queue.shift()!;
      if (queue.length) this.order.push(key);
      else this.queues.delete(key);
      return waiter;
    }
    return undefined;
  }

  private remove(waiter: Waiter): void {
    const queue = this.queues.get(waiter.key);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) {
      this.queues.delete(waiter.key);
      const at = this.order.indexOf(waiter.key);
      if (at >= 0) this.order.splice(at, 1);
    }
    this.write();
  }

  /** Wake exactly when budget or the cooldown next frees up, if anyone is waiting. */
  private schedule(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    if (!this.queues.size || this.running >= this.options.maxConcurrent) return;
    const now = this.now();
    const candidates: number[] = [];
    if (now < this.state.cooldownUntil) candidates.push(this.state.cooldownUntil);
    const recent10 = this.state.admitted.filter(at => at > now - TEN_MINUTES);
    if (recent10.length >= this.state.budget.req10) candidates.push(recent10[recent10.length - this.state.budget.req10]! + TEN_MINUTES);
    if (this.state.admitted.length >= this.state.budget.req30) {
      candidates.push(this.state.admitted[this.state.admitted.length - this.state.budget.req30]! + THIRTY_MINUTES);
    }
    if (!candidates.length) return;
    const at = Math.max(...candidates);
    this.timer = this.setTimer(() => this.pump(), Math.max(50, at - now + 50));
  }

  /** After 30 quiet minutes spent near the limit without a throttle, allow 10% more. */
  private loosen(now: number): void {
    if (now - this.state.lastAdjustAt < LOOSEN_AFTER_MS) return;
    const busy = this.state.admitted.length >= 0.6 * this.state.budget.req30;
    this.state.lastAdjustAt = now;
    if (!busy) return;
    this.state.budget = {
      req10: Math.min(ADMISSION_CEILING.req10, Math.ceil(this.state.budget.req10 * 1.1)),
      req30: Math.min(ADMISSION_CEILING.req30, Math.ceil(this.state.budget.req30 * 1.1)),
    };
    this.write();
  }

  private prune(now: number): void {
    const cutoff = now - THIRTY_MINUTES;
    while (this.state.admitted.length && this.state.admitted[0]! <= cutoff) this.state.admitted.shift();
    const recentCutoff = now - RECENT_MS;
    this.state.recent = this.state.recent
      .filter(record => record.endedAt === undefined || record.endedAt > recentCutoff)
      .slice(-RECENT_CAP);
  }

  private read(): AdmissionState {
    const fresh: AdmissionState = {
      version: 1, budget: { ...ADMISSION_SEED }, cooldownUntil: 0, cooldownMs: COOLDOWN_MS,
      lastThrottleAt: 0, lastAdjustAt: this.now(), admitted: [], recent: [],
    };
    const path = this.options.statePath;
    if (!path || !existsSync(path)) return fresh;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AdmissionState>;
      if (parsed.version !== 1 || !parsed.budget) return fresh;
      const clamp = (value: unknown, key: keyof AdmissionBudget) => typeof value === "number" && Number.isFinite(value)
        ? Math.min(ADMISSION_CEILING[key], Math.max(ADMISSION_FLOOR[key], Math.floor(value))) : ADMISSION_SEED[key];
      return {
        version: 1,
        budget: { req10: clamp(parsed.budget.req10, "req10"), req30: clamp(parsed.budget.req30, "req30") },
        cooldownUntil: typeof parsed.cooldownUntil === "number" ? parsed.cooldownUntil : 0,
        cooldownMs: typeof parsed.cooldownMs === "number" ? parsed.cooldownMs : COOLDOWN_MS,
        lastThrottleAt: typeof parsed.lastThrottleAt === "number" ? parsed.lastThrottleAt : 0,
        lastAdjustAt: typeof parsed.lastAdjustAt === "number" ? parsed.lastAdjustAt : this.now(),
        admitted: Array.isArray(parsed.admitted)
          ? parsed.admitted.filter((at): at is number => typeof at === "number").sort((a, b) => a - b) : [],
        recent: this.readRecent(parsed.recent),
      };
    } catch {
      // A damaged state file must not stop turns; start from the conservative seed.
      return fresh;
    }
  }

  /** Turns still open when the bridge stopped did not finish; close them as such. */
  private readRecent(value: unknown): AdmissionTurnRecord[] {
    if (!Array.isArray(value)) return [];
    const now = this.now();
    return value
      .filter((record): record is AdmissionTurnRecord => Boolean(record) && typeof record === "object"
        && typeof record.traceId === "string" && typeof record.key === "string"
        && typeof record.queuedAt === "number" && typeof record.startedAt === "number")
      .map(record => record.endedAt === undefined ? { ...record, endedAt: now, error: "bridge restarted" } : record)
      .filter(record => record.endedAt! > now - RECENT_MS)
      .slice(-RECENT_CAP);
  }

  /**
   * Persist learning plus a live view for status pages. `live` is informational only: it is
   * rebuilt from nothing after a restart and never read back.
   */
  private write(): void {
    if (!this.options.statePath) return;
    const live = {
      running: this.running,
      maxConcurrent: this.options.maxConcurrent,
      queued: [...this.queues.values()].flat().map(waiter => ({
        key: waiter.key, traceId: waiter.traceId, since: waiter.enqueuedAt,
      })),
      updatedAt: this.now(),
    };
    try {
      atomicWriteFile(this.options.statePath, `${JSON.stringify({ ...this.state, live })}\n`);
    } catch {
      // Losing persistence only resets learning; it must never fail a turn.
    }
  }
}

export function isChatGptRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /too many requests|rate limit/i.test(message);
}
