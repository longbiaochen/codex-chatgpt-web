import { readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

function proxyError(message: string): Error {
  return Object.assign(new Error(message), { code: "NativeProxyConfigurationError" });
}

/** Use the first route selected by Chromium, without guessing another proxy protocol or retrying. */
export function nativeProxyFromPac(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
  const first = value.split(";")[0]!.trim();
  if (first === "DIRECT") return undefined;
  const match = /^(PROXY|HTTPS) ([^\s/;]+)$/.exec(first);
  if (!match) {
    throw proxyError("Native Codex requires an HTTP(S) system proxy; the selected proxy protocol is unsupported");
  }
  try {
    const proxy = new URL(`${match[1] === "HTTPS" ? "https" : "http"}://${match[2]}`);
    if (!proxy.hostname || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error();
    return proxy.href;
  } catch {
    throw proxyError("Launcher returned invalid native proxy configuration");
  }
}

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

const HOST_RESTART_WAIT_MS = 15_000;
const HOST_RESTART_POLL_MS = 500;

/**
 * The browser host restarts with the bridge (systemd PartOf), so for a few seconds after a bridge
 * restart its descriptor names a dead pid or its control port refuses connections. Wait for it
 * instead of failing every native request (and declining every WebSocket) in that window.
 */
function hostRestarting(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return /descriptor is missing|process is not running/.test(message)
    || code === "ConnectionRefused" || code === "ECONNREFUSED";
}

async function launcherProxyFor(descriptorPath: string, url: string, signal?: AbortSignal): Promise<string | undefined> {
  const deadline = Date.now() + HOST_RESTART_WAIT_MS;
  for (;;) {
    try {
      return await launcherProxyOnce(descriptorPath, url, signal);
    } catch (error) {
      if (!hostRestarting(error) || Date.now() >= deadline || signal?.aborted) throw error;
      await Bun.sleep(HOST_RESTART_POLL_MS);
    }
  }
}

async function launcherProxyOnce(descriptorPath: string, url: string, signal?: AbortSignal): Promise<string | undefined> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  const response = await fetch(`${descriptor.control.endpoint}/v1/network/resolve-proxy`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
    body: JSON.stringify({ url }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw proxyError(`Launcher native proxy resolution failed (HTTP ${response.status})`);
  const result = await response.json() as { proxy?: unknown };
  return nativeProxyFromPac(result.proxy);
}

/** Native Codex keeps its own auth and Bun transport, but shares the launcher's OS proxy policy. */
export async function fetchNativeCodex(request: Request): Promise<Response> {
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  // Standalone CLI and explicitly configured proxy environments retain Bun's existing semantics,
  // including NO_PROXY. No proxy variables or machine-wide settings are rewritten.
  if (!descriptorPath || PROXY_ENV.some(key => process.env[key]?.trim())) return fetch(request);
  const proxy = await launcherProxyFor(descriptorPath, request.url, request.signal);
  return fetch(request, proxy ? { proxy } : undefined);
}

/**
 * Whether native traffic to `url` goes out directly. The native WebSocket relay only runs on a
 * direct route; behind any proxy it declines and Codex keeps using HTTP through fetchNativeCodex.
 */
export async function nativeRouteIsDirect(url: string): Promise<boolean> {
  if (PROXY_ENV.some(key => process.env[key]?.trim())) return false;
  const descriptorPath = process.env.CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR?.trim();
  if (!descriptorPath) return true;
  return (await launcherProxyFor(descriptorPath, url)) === undefined;
}
