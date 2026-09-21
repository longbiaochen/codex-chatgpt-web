import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMISSION_FLOOR,
  ADMISSION_SEED,
  ChatGptAdmission,
  isChatGptRateLimitError,
} from "../src/adapters/chatgpt-web/admission";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function harness(options: { maxConcurrent?: number; statePath?: string; start?: number } = {}) {
  let now = options.start ?? 1_000_000;
  let timer: (() => void) | undefined;
  const logs: string[] = [];
  const admission = new ChatGptAdmission({
    maxConcurrent: options.maxConcurrent ?? 3,
    statePath: options.statePath,
    now: () => now,
    log: message => logs.push(message),
    setTimer: callback => {
      timer = callback;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      timer = undefined;
    },
  });
  return {
    admission,
    logs,
    advance(ms: number) {
      now += ms;
      const fire = timer;
      timer = undefined;
      fire?.();
    },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function admittedKeys(promises: Array<Promise<() => void>>): Promise<boolean[]> {
  const state = promises.map(() => false);
  promises.forEach((promise, index) => void promise.then(() => { state[index] = true; }));
  await settle();
  return state;
}

describe("ChatGPT account admission", () => {
  test("runs at most one turn per pool host and admits the next on release", async () => {
    const { admission } = harness({ maxConcurrent: 2 });
    const turns = [admission.acquire("a", "t1"), admission.acquire("b", "t2"), admission.acquire("c", "t3")];
    expect(await admittedKeys(turns)).toEqual([true, true, false]);
    (await turns[0]!)();
    expect(await admittedKeys(turns)).toEqual([true, true, true]);
  });

  test("holds turns once the 10-minute budget is spent and releases them as it ages out", async () => {
    const { admission, advance } = harness({ maxConcurrent: 100 });
    const releases: Array<() => void> = [];
    for (let index = 0; index < ADMISSION_SEED.req10; index += 1) {
      releases.push(await admission.acquire(`k${index}`, `t${index}`));
    }
    releases.forEach(release => release());
    const waiting = admission.acquire("late", "late");
    expect(await admittedKeys([waiting])).toEqual([false]);
    advance(10 * 60_000 + 100);
    expect(await admittedKeys([waiting])).toEqual([true]);
  });

  test("serves tasks round-robin so one busy task cannot starve another", async () => {
    const { admission } = harness({ maxConcurrent: 1 });
    const order: string[] = [];
    const first = await admission.acquire("busy", "b0");
    const queued = [
      admission.acquire("busy", "b1"), admission.acquire("busy", "b2"), admission.acquire("quiet", "q1"),
    ];
    queued.forEach((promise, index) => void promise.then(release => {
      order.push(["b1", "b2", "q1"][index]!);
      release();
    }));
    first();
    await settle(); await settle(); await settle();
    expect(order).toEqual(["b1", "q1", "b2"]);
  });

  test("a throttle cools the account down, tightens the budget, and doubles on a repeat", async () => {
    const { admission, advance } = harness();
    admission.noteThrottle();
    const cut = admission.snapshot();
    expect(cut.budget.req10).toBe(Math.max(ADMISSION_FLOOR.req10, Math.floor(ADMISSION_SEED.req10 * 0.7)));
    const waiting = admission.acquire("a", "retry");
    expect(await admittedKeys([waiting])).toEqual([false]);           // the retry waits, it does not fail
    advance(20 * 60_000 + 100);
    expect(await admittedKeys([waiting])).toEqual([true]);
    (await waiting)();
    admission.noteThrottle();                                          // within two hours
    expect(admission.snapshot().cooldownUntil).toBeGreaterThanOrEqual(1_000_000 + 20 * 60_000 + 40 * 60_000);
  });

  test("the budget never drops below its floor", () => {
    const { admission } = harness();
    for (let index = 0; index < 20; index += 1) admission.noteThrottle();
    expect(admission.snapshot().budget).toEqual(ADMISSION_FLOOR);
  });

  test("an aborted waiter leaves the queue without consuming budget", async () => {
    const { admission } = harness({ maxConcurrent: 1 });
    const holder = await admission.acquire("a", "a");
    const controller = new AbortController();
    const waiting = admission.acquire("b", "b", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("aborted");
    expect(admission.snapshot().queued).toBe(0);
    holder();
    expect(admission.snapshot().recent10).toBe(1);
  });

  test("learned budget and cooldown survive a bridge restart", () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-admission-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    harness({ statePath }).admission.noteThrottle();
    const reloaded = harness({ statePath }).admission.snapshot();
    expect(reloaded.budget.req10).toBeLessThan(ADMISSION_SEED.req10);
    expect(reloaded.cooldownUntil).toBeGreaterThan(1_000_000);
  });

  test("thirty busy minutes without a throttle loosen the budget", async () => {
    const { admission, advance } = harness({ maxConcurrent: 100 });
    const busy = Math.ceil(ADMISSION_SEED.req30 * 0.6);            // 18: at least 60% of the budget
    advance(60_000);
    for (let index = 0; index < busy / 2; index += 1) (await admission.acquire(`a${index}`, `a${index}`))();
    advance(11 * 60_000);                                          // first batch leaves the 10-minute window
    for (let index = 0; index < busy / 2; index += 1) (await admission.acquire(`b${index}`, `b${index}`))();
    expect(admission.snapshot().budget.req30).toBe(ADMISSION_SEED.req30);   // too early to loosen
    advance(18 * 60_000 + 1);                                      // 30 minutes since the last adjustment
    (await admission.acquire("next", "next"))();
    expect(admission.snapshot().budget.req30).toBeGreaterThan(ADMISSION_SEED.req30);
  });

  test("recognizes the browser's throttle message", () => {
    expect(isChatGptRateLimitError(new Error("ChatGPT rate limit: too many requests. Try again in a few minutes."))).toBe(true);
    expect(isChatGptRateLimitError(new Error("ChatGPT stopped responding"))).toBe(false);
  });

  test("the state file carries a live view of running and queued turns for status pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-admission-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    const { admission } = harness({ statePath, maxConcurrent: 1 });
    const holder = await admission.acquire("task-a", "t1");
    void admission.acquire("task-b", "t2");
    await settle();
    let live = JSON.parse(readFileSync(statePath, "utf8")).live;
    expect(live.running).toBe(1);
    expect(live.maxConcurrent).toBe(1);
    expect(live.queued.map((item: { traceId: string }) => item.traceId)).toEqual(["t2"]);
    holder();
    await settle();
    live = JSON.parse(readFileSync(statePath, "utf8")).live;
    expect(live.queued).toEqual([]);
    expect(live.running).toBe(1);                                  // t2 took the freed slot
  });
});

describe("ChatGPT account admission turn records", () => {
  test("records admitted turns with thread, model, host and outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-admission-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    const { admission } = harness({ statePath });
    const ok = await admission.acquire("k1", "t1", undefined, { threadId: "thread-a", model: "chatgpt-web/high" });
    admission.noteHost("t1", "beta");
    ok();
    const failed = await admission.acquire("k2", "t2", undefined, { threadId: "thread-b" });
    failed("ChatGPT stopped responding");
    await admission.acquire("k3", "t3");                                    // still running at "restart"
    const recent = JSON.parse(readFileSync(statePath, "utf8")).recent;
    expect(recent.map((record: { traceId: string }) => record.traceId)).toEqual(["t1", "t2", "t3"]);
    expect(recent[0]).toMatchObject({ threadId: "thread-a", model: "chatgpt-web/high", host: "beta" });
    expect(recent[0].endedAt).toBeDefined();
    expect(recent[1].error).toBe("ChatGPT stopped responding");
  });

  test("a turn open when the bridge stopped is recorded as interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-admission-"));
    roots.push(root);
    const statePath = join(root, "state.json");
    await harness({ statePath }).admission.acquire("k", "open");
    const { admission } = harness({ statePath });
    (await admission.acquire("k2", "next"))();
    const recent = JSON.parse(readFileSync(statePath, "utf8")).recent;
    expect(recent[0]).toMatchObject({ traceId: "open", error: "bridge restarted" });
  });
});
