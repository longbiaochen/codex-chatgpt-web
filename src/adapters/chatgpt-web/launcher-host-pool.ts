import { readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";

/**
 * Several launcher browser processes can host ChatGPT turns for one bridge. Each launcher is its own
 * Chromium browser, so a renderer that is busy with one turn (for example while ingesting a very
 * large prompt) cannot stall CDP attach, rebinding or rendering for turns running in another one.
 * The broker, tunnel and connector stay single: tool calls are routed by turn token, not by browser.
 */

/** A retained ChatGPT conversation can only resume in the launcher that still owns its tab. */
const LAUNCHER_HOST_AFFINITY_TTL_MS = 6 * 60 * 60_000;
const affinity = new Map<string, { host: string; at: number }>();

export function rememberLauncherHostAffinity(conversationKey: string, host: string, now = Date.now()): void {
  affinity.delete(conversationKey);
  affinity.set(conversationKey, { host, at: now });
  for (const [key, entry] of affinity) {
    if (now - entry.at < LAUNCHER_HOST_AFFINITY_TTL_MS && affinity.size <= 1_024) break;
    affinity.delete(key);
  }
}

export function launcherHostForConversation(conversationKey: string | undefined, now = Date.now()): string | undefined {
  if (!conversationKey) return undefined;
  const entry = affinity.get(conversationKey);
  if (!entry) return undefined;
  if (now - entry.at >= LAUNCHER_HOST_AFFINITY_TTL_MS) {
    affinity.delete(conversationKey);
    return undefined;
  }
  return entry.host;
}

/** Test hook: forget every conversation affinity. */
export function clearLauncherHostAffinity(): void {
  affinity.clear();
}

type DescriptorReader = (path: string) => unknown;

/**
 * The primary launcher is always a candidate (its failures surface exactly as before). Extra pool
 * members are used only while their descriptor is valid: owned by this user, private, and naming a
 * live launcher process.
 */
export function availableLauncherHosts(
  primary: string,
  pool: readonly string[] = [],
  read: DescriptorReader = readLauncherBrowserHostDescriptor,
): string[] {
  const hosts = [primary];
  for (const host of pool) {
    if (hosts.includes(host)) continue;
    try {
      read(host);
      hosts.push(host);
    } catch {
      // An absent, stale or foreign descriptor is simply not available for new turns.
    }
  }
  return hosts;
}

/**
 * Choose the launcher for a new browser turn: the conversation's own launcher when it is still
 * available, otherwise the one with the fewest turns in flight (ties keep the primary first).
 */
export function selectLauncherHost(options: {
  primary: string;
  pool?: readonly string[];
  activeTurns: (host: string) => number;
  conversationKey?: string;
  read?: DescriptorReader;
}): string {
  const hosts = availableLauncherHosts(options.primary, options.pool, options.read);
  const sticky = launcherHostForConversation(options.conversationKey);
  if (sticky && hosts.includes(sticky)) return sticky;
  let best = hosts[0]!;
  for (const host of hosts.slice(1)) {
    if (options.activeTurns(host) < options.activeTurns(best)) best = host;
  }
  return best;
}
