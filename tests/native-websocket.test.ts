import { afterEach, describe, expect, test } from "bun:test";
import { NativeWebSocketRelay, type NativeWebSocketRelayOptions, type RelayData } from "../src/native-websocket";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

/** A fake ChatGPT Codex backend: records the handshake headers and answers each response.create. */
function fakeUpstream() {
  const seen: { headers?: Record<string, string>; messages: unknown[] } = { messages: [] };
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      seen.headers = Object.fromEntries(req.headers);
      return srv.upgrade(req) ? undefined : new Response("no", { status: 500 });
    },
    websocket: {
      message(ws, message) {
        const parsed = JSON.parse(String(message));
        seen.messages.push(parsed);
        ws.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${seen.messages.length}` } }));
      },
    },
  });
  servers.push(server);
  return { seen, url: `ws://127.0.0.1:${server.port}` };
}

function bridge(options: NativeWebSocketRelayOptions) {
  const logs: string[] = [];
  const relay = new NativeWebSocketRelay({ routeIsDirect: async () => true, enabled: () => true, log: m => logs.push(m), ...options });
  const server = Bun.serve<RelayData, never>({
    port: 0,
    websocket: relay.handlers,
    async fetch(req, srv) {
      return await relay.upgrade(req, srv);
    },
  });
  servers.push(server);
  return { relay, logs, url: `ws://127.0.0.1:${server.port}/v1/responses`, http: `http://127.0.0.1:${server.port}/v1/responses` };
}

const codexHeaders = (thread = "thread-1") => ({
  authorization: "Bearer test-token",
  "chatgpt-account-id": "acct",
  "openai-beta": "responses_websockets=2026-02-06",
  "thread-id": thread,
  "session-id": thread,
});

function connect(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const received: unknown[] = [];
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    ws.onclose = event => resolve({ code: event.code, reason: event.reason });
  });
  ws.onmessage = event => received.push(JSON.parse(String(event.data)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("handshake failed"));
  });
  return { ws, received, closed, opened };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
};

describe("native Responses WebSocket relay", () => {
  test("relays native-model messages both ways with Codex's auth and thread headers", async () => {
    const upstream = fakeUpstream();
    const { url, logs } = bridge({ connect: (_url, headers) => new WebSocket(upstream.url, { headers } as unknown as string[]) as never });
    const client = connect(url, codexHeaders());
    await client.opened;
    client.ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: [{ type: "message" }], generate: false }));
    client.ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", previous_response_id: "resp_1", input: [] }));
    await until(() => client.received.length === 2);
    expect(client.received).toEqual([
      { type: "response.completed", response: { id: "resp_1" } },
      { type: "response.completed", response: { id: "resp_2" } },
    ]);
    expect(upstream.seen.headers?.authorization).toBe("Bearer test-token");
    expect(upstream.seen.headers?.["thread-id"]).toBe("thread-1");
    expect(upstream.seen.headers?.["openai-beta"]).toBe("responses_websockets=2026-02-06");
    expect((upstream.seen.messages[1] as { previous_response_id: string }).previous_response_id).toBe("resp_1");
    client.ws.close(1000);
    await until(() => logs.some(line => line.includes("messages=2 incremental=1")));
  });

  test("a ChatGPT Web model closes the socket and the thread's next handshake is declined", async () => {
    const { url, http } = bridge({ connect: () => { throw new Error("must not dial upstream"); } });
    const client = connect(url, codexHeaders("web-thread"));
    await client.opened;
    client.ws.send(JSON.stringify({ type: "response.create", model: "chatgpt-web/high", input: [], generate: false }));
    expect((await client.closed).code).toBe(1012);
    const retry = await fetch(http, { headers: { ...codexHeaders("web-thread"), upgrade: "websocket", connection: "Upgrade",
      "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    expect(retry.status).toBe(426);
  });

  test("declines with 426 when the route would need a proxy, lacks auth or a thread, or is switched off", async () => {
    const handshake = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    const proxied = bridge({ routeIsDirect: async () => false });
    expect((await fetch(proxied.http, { headers: { ...codexHeaders(), ...handshake } })).status).toBe(426);
    const open = bridge({});
    const { authorization: _drop, ...noAuth } = codexHeaders();
    expect((await fetch(open.http, { headers: { ...noAuth, ...handshake } })).status).toBe(426);
    expect((await fetch(open.http, { headers: { authorization: "Bearer x", ...handshake } })).status).toBe(426);
    const off = bridge({ enabled: () => false });
    expect((await fetch(off.http, { headers: { ...codexHeaders(), ...handshake } })).status).toBe(426);
  });

  test("an upstream close reaches the client", async () => {
    const upstream = fakeUpstream();
    let dialed: WebSocket | undefined;
    const { url } = bridge({ connect: (_url, headers) => (dialed = new WebSocket(upstream.url, { headers } as unknown as string[])) as never });
    const client = connect(url, codexHeaders("t2"));
    await client.opened;
    client.ws.send(JSON.stringify({ type: "response.create", model: "gpt-5.6-sol", input: [] }));
    await until(() => client.received.length === 1);
    servers[0]!.stop(true);                                 // the upstream goes away
    const closed = await client.closed;
    expect([1000, 1001, 1011]).toContain(closed.code);
    expect(dialed).toBeDefined();
  });
});
