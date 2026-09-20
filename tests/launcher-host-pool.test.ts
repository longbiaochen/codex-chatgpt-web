import { afterEach, expect, test } from "bun:test";
import {
  availableLauncherHosts,
  clearLauncherHostAffinity,
  launcherHostForConversation,
  rememberLauncherHostAffinity,
  selectLauncherHost,
} from "../src/adapters/chatgpt-web/launcher-host-pool";

afterEach(() => clearLauncherHostAffinity());

const alive = new Set(["/hosts/alpha.json", "/hosts/beta.json", "/hosts/gamma.json"]);
const read = (path: string) => {
  if (!alive.has(path)) throw new Error(`descriptor is not live: ${path}`);
  return {};
};

test("every launcher, primary included, is available only while its descriptor is live", () => {
  expect(availableLauncherHosts("/hosts/alpha.json", ["/hosts/beta.json", "/hosts/dead.json", "/hosts/alpha.json"], read))
    .toEqual(["/hosts/alpha.json", "/hosts/beta.json"]);
  expect(availableLauncherHosts("/hosts/dead-primary.json", [], read)).toEqual(["/hosts/dead-primary.json"]);
});

test("a dead primary hands its turns to a live pool member", () => {
  expect(availableLauncherHosts("/hosts/dead-primary.json", ["/hosts/beta.json", "/hosts/gamma.json"], read))
    .toEqual(["/hosts/beta.json", "/hosts/gamma.json"]);
  expect(selectLauncherHost({
    primary: "/hosts/dead-primary.json",
    pool: ["/hosts/beta.json", "/hosts/gamma.json"],
    activeTurns: host => (host === "/hosts/beta.json" ? 2 : 0),
    read,
  })).toBe("/hosts/gamma.json");
});

test("a conversation pinned to a launcher that died falls back to a live one", () => {
  rememberLauncherHostAffinity("conversation-dead", "/hosts/dead-primary.json");
  expect(selectLauncherHost({
    primary: "/hosts/dead-primary.json",
    pool: ["/hosts/beta.json"],
    activeTurns: () => 0,
    conversationKey: "conversation-dead",
    read,
  })).toBe("/hosts/beta.json");
});

test("a new turn goes to the launcher with the fewest turns in flight, preferring the primary on ties", () => {
  const load: Record<string, number> = { "/hosts/alpha.json": 1, "/hosts/beta.json": 0, "/hosts/gamma.json": 0 };
  const pick = () => selectLauncherHost({
    primary: "/hosts/alpha.json",
    pool: ["/hosts/beta.json", "/hosts/gamma.json"],
    activeTurns: host => load[host] ?? 0,
    read,
  });
  expect(pick()).toBe("/hosts/beta.json");
  load["/hosts/alpha.json"] = 0;
  expect(pick()).toBe("/hosts/alpha.json");
});

test("a retained conversation stays on its launcher while that launcher is live", () => {
  rememberLauncherHostAffinity("conversation-1", "/hosts/gamma.json");
  expect(launcherHostForConversation("conversation-1")).toBe("/hosts/gamma.json");
  const select = () => selectLauncherHost({
    primary: "/hosts/alpha.json",
    pool: ["/hosts/beta.json", "/hosts/gamma.json"],
    activeTurns: host => (host === "/hosts/gamma.json" ? 3 : 0),
    conversationKey: "conversation-1",
    read,
  });
  expect(select()).toBe("/hosts/gamma.json");
  alive.delete("/hosts/gamma.json");
  try {
    expect(select()).toBe("/hosts/alpha.json");
  } finally {
    alive.add("/hosts/gamma.json");
  }
});
