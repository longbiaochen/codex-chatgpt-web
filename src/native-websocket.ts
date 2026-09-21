import type { Server, ServerWebSocket } from "bun";
import { isChatGptWebModelSlug } from "./chatgpt-web-models";
import { nativeRouteIsDirect } from "./native-network";
import { scrubBridgeArtifactsForNative } from "./native-passthrough";

/**
 * Responses WebSocket transport for native (passthrough) models.
 *
 * Over HTTP every Codex request re-sends the whole conversation; over the Responses WebSocket
 * Codex sends only the items added since the previous response on the same connection
 * (`previous_response_id`). For native models the bridge relays each Codex connection one-to-one
 * to ChatGPT's Codex WebSocket, so that incremental protocol reaches the real backend intact.
 *
 * The handshake does not name a model; the first `response.create` does. A ChatGPT Web model
 * cannot use this transport, so its connection is closed as soon as that message arrives and the
 * thread is remembered. Codex reconnects, the bridge answers 426, and Codex switches that session
 * to HTTP for good (it only falls back on a 426 handshake), where the browser path runs as before.
 */

export const NATIVE_CODEX_WEBSOCKET = "wss://chatgpt.com/backend-api/codex/responses";
const WEB_THREAD_TTL_MS = 24 * 60 * 60_000;
const WEB_THREAD_CAP = 2_000;
const NOT_FORWARDED = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length", "content-encoding",
]);

export interface UpstreamSocket {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface RelayData {
  relay: "native-responses";
  thread: string;
  headers: Record<string, string>;
  upstream?: UpstreamSocket;
  pending: Array<string | Uint8Array>;
  closed: boolean;
  messages: number;
  incremental: number;
  bytes: number;
}

export interface NativeWebSocketRelayOptions {
  connect?: (url: string, headers: Record<string, string>) => UpstreamSocket;
  routeIsDirect?: (url: string) => Promise<boolean>;
  enabled?: () => boolean;
  now?: () => number;
  log?: (message: string) => void;
}

const OPEN = 1;

function declined(reason: string): Response {
  return new Response(`Responses WebSocket declined: ${reason}; use HTTP`, {
    status: 426,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Close codes a server may send; reserved ones (1005/1006/1015) and garbage become 1011. */
function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006)) return code;
  if (code >= 3000 && code <= 4999) return code;
  return code === 1005 ? 1000 : 1011;
}

export class NativeWebSocketRelay {
  private readonly webThreads = new Map<string, number>();
  private readonly connect: NonNullable<NativeWebSocketRelayOptions["connect"]>;
  private readonly routeIsDirect: NonNullable<NativeWebSocketRelayOptions["routeIsDirect"]>;
  private readonly enabled: NonNullable<NativeWebSocketRelayOptions["enabled"]>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: NativeWebSocketRelayOptions = {}) {
    this.connect = options.connect
      ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]) as unknown as UpstreamSocket);
    this.routeIsDirect = options.routeIsDirect ?? nativeRouteIsDirect;
    this.enabled = options.enabled ?? (() => process.env.CODEX_CHATGPT_WEB_NATIVE_WEBSOCKET?.trim().toLowerCase() !== "off");
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (message => console.info(message));
  }

  /** Upgrade the request, or return the 426 that sends Codex to HTTP. */
  async upgrade(req: Request, server: Pick<Server<RelayData>, "upgrade">): Promise<Response | undefined> {
    if (!this.enabled()) return declined("disabled on this bridge");
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
      return declined("no Bearer authorization");
    }
    const thread = req.headers.get("thread-id") ?? req.headers.get("session-id") ?? "";
    // Without a thread the web-model detour could not be remembered and would reconnect forever.
    if (!thread) return declined("no thread id");
    if (this.isWebThread(thread)) return declined("ChatGPT Web model thread");
    try {
      if (!(await this.routeIsDirect(NATIVE_CODEX_WEBSOCKET.replace(/^wss:/, "https:")))) {
        return declined("native route uses a proxy");
      }
    } catch {
      return declined("native route unresolved");
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of req.headers) {
      const lower = name.toLowerCase();
      if (!NOT_FORWARDED.has(lower) && !lower.startsWith("sec-websocket-")) headers[name] = value;
    }
    const data: RelayData = {
      relay: "native-responses", thread, headers, pending: [], closed: false, messages: 0, incremental: 0, bytes: 0,
    };
    return (server.upgrade as (req: Request, options: { data: RelayData }) => boolean)(req, { data })
      ? undefined
      : declined("upgrade failed");
  }

  readonly handlers = {
    message: (ws: ServerWebSocket<RelayData>, raw: string | Buffer) => this.onMessage(ws, raw),
    close: (ws: ServerWebSocket<RelayData>, code: number, reason: string) => this.onClientClose(ws, code, reason),
  };

  isWebThread(thread: string): boolean {
    const expiresAt = this.webThreads.get(thread);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.now()) return true;
    this.webThreads.delete(thread);
    return false;
  }

  private rememberWebThread(thread: string): void {
    this.webThreads.delete(thread);
    this.webThreads.set(thread, this.now() + WEB_THREAD_TTL_MS);
    while (this.webThreads.size > WEB_THREAD_CAP) this.webThreads.delete(this.webThreads.keys().next().value!);
  }

  private onMessage(ws: ServerWebSocket<RelayData>, raw: string | Buffer): void {
    const data = ws.data;
    if (data.closed) return;
    let outgoing: string | Uint8Array = typeof raw === "string" ? raw : new Uint8Array(raw);
    let message: unknown;
    if (typeof raw === "string") {
      try {
        message = JSON.parse(raw);
      } catch {
        message = undefined;
      }
    }
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "response.create") {
      const model = (message as { model?: unknown }).model;
      if (typeof model === "string" && isChatGptWebModelSlug(model)) {
        this.rememberWebThread(data.thread);
        this.log(`[codex-chatgpt-web] native_websocket web_model thread=${data.thread} model=${model}: `
          + "closing so Codex reconnects and falls back to HTTP");
        this.closeBoth(ws, 1012, "ChatGPT Web model: reconnect over HTTP");
        return;
      }
      const scrubbed = scrubBridgeArtifactsForNative(message);
      if (scrubbed.changed) outgoing = JSON.stringify(scrubbed.value);
      data.messages += 1;
      if ((message as { previous_response_id?: unknown }).previous_response_id) data.incremental += 1;
    }
    data.bytes += typeof outgoing === "string" ? outgoing.length : outgoing.byteLength;
    if (!data.upstream) this.openUpstream(ws);
    if (data.upstream!.readyState === OPEN) data.upstream!.send(outgoing);
    else data.pending.push(outgoing);
  }

  private openUpstream(ws: ServerWebSocket<RelayData>): void {
    const data = ws.data;
    const upstream = this.connect(NATIVE_CODEX_WEBSOCKET, data.headers);
    data.upstream = upstream;
    upstream.onopen = () => {
      for (const message of data.pending.splice(0)) upstream.send(message);
    };
    upstream.onmessage = event => {
      if (data.closed) return;
      const payload = event.data;
      ws.send(typeof payload === "string" ? payload : new Uint8Array(payload as ArrayBuffer));
    };
    upstream.onerror = () => {
      this.log(`[codex-chatgpt-web] native_websocket upstream_error thread=${data.thread}`);
    };
    upstream.onclose = event => {
      if (data.closed) return;
      data.closed = true;
      this.summarize(data, `upstream_close code=${event.code}`);
      try {
        ws.close(sendableCloseCode(event.code), event.reason);
      } catch {
        // The client is already gone.
      }
    };
  }

  private onClientClose(ws: ServerWebSocket<RelayData>, code: number, _reason: string): void {
    const data = ws.data;
    if (data.closed) return;
    data.closed = true;
    if (data.upstream) this.summarize(data, `client_close code=${code}`);
    try {
      data.upstream?.close(1000);
    } catch {
      // Closing a socket that never connected is not an error worth reporting.
    }
  }

  private closeBoth(ws: ServerWebSocket<RelayData>, code: number, reason: string): void {
    const data = ws.data;
    data.closed = true;
    try {
      data.upstream?.close(1000);
    } catch {
      // Upstream never connected.
    }
    ws.close(code, reason);
  }

  private summarize(data: RelayData, how: string): void {
    this.log(`[codex-chatgpt-web] native_websocket ${how} thread=${data.thread} messages=${data.messages} `
      + `incremental=${data.incremental} bytes=${data.bytes}`);
  }
}
