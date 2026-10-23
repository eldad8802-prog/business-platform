/**
 * Bank of Israel SDMX client — one GET per series, for a window of days. No API key, no account.
 *
 *   - timeout     AbortSignal.timeout (default 10 s) per request; no retry inside a run (the next scheduled
 *                 run is the retry, and it back-fills the whole 10-day window);
 *   - redirects   never followed (`redirect: "manual"`): any 3xx is a failure, so a response can only come
 *                 from the host that was asked;
 *   - origin      the Bank of Israel origin only; a loopback origin is accepted solely so the CI lab can serve
 *                 recorded fixtures — the cron route never passes an origin;
 *   - size        Content-Length and the streamed body are both capped (default 256 KiB);
 *   - type        Content-Type must be text/csv; the body must be valid UTF-8.
 *
 * Returns the raw CSV text or a typed failure; parsing is lib/fx/boi-parser.ts.
 */
import { boiSeriesCode, type BoiBase } from "./boi-parser";

export const BOI_ORIGIN = "https://edge.boi.org.il";
export const BOI_DATA_PATH = "/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/";
export const BOI_TIMEOUT_MS = 10_000;
export const BOI_MAX_BYTES = 256 * 1024;

export type BoiFetchFailure =
  | "ORIGIN_NOT_ALLOWED"
  | "TIMEOUT"
  | "NETWORK"
  | "REDIRECT"
  | "HTTP_STATUS"
  | "CONTENT_TYPE"
  | "TOO_LARGE"
  | "NOT_UTF8";

export type BoiFetchResult =
  | { readonly ok: true; readonly url: string; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly url: string; readonly failure: BoiFetchFailure; readonly status?: number };

export type BoiFetchOptions = {
  readonly origin?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
};

/** The Bank of Israel origin, or a loopback http(s) origin (CI lab fixtures). Anything else is refused. */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === BOI_ORIGIN) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.pathname === "/" && !u.search && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function boiSeriesUrl(base: BoiBase, startPeriod: string, endPeriod: string, origin: string = BOI_ORIGIN): string {
  const q = new URLSearchParams({ startperiod: startPeriod, endperiod: endPeriod, format: "csv" });
  return `${origin}${BOI_DATA_PATH}${boiSeriesCode(base)}?${q.toString()}`;
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function fetchBoiSeries(base: BoiBase, startPeriod: string, endPeriod: string, opts: BoiFetchOptions = {}): Promise<BoiFetchResult> {
  const origin = opts.origin ?? BOI_ORIGIN;
  const url = boiSeriesUrl(base, startPeriod, endPeriod, isAllowedOrigin(origin) ? origin : BOI_ORIGIN);
  if (!isAllowedOrigin(origin)) return { ok: false, url, failure: "ORIGIN_NOT_ALLOWED" };
  const maxBytes = opts.maxBytes ?? BOI_MAX_BYTES;
  const doFetch = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? BOI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(url, { method: "GET", redirect: "manual", cache: "no-store", headers: { accept: "text/csv" }, signal });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, url, failure: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK" };
  }
  const drain = () => res.body?.cancel().catch(() => undefined);
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    await drain();
    return { ok: false, url, failure: "REDIRECT", status: res.status };
  }
  if (res.status !== 200) {
    await drain();
    return { ok: false, url, failure: "HTTP_STATUS", status: res.status };
  }
  const type = res.headers.get("content-type") ?? "";
  if (!/^text\/csv(\s*;|$)/i.test(type.trim())) {
    await drain();
    return { ok: false, url, failure: "CONTENT_TYPE", status: res.status };
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await drain();
    return { ok: false, url, failure: "TOO_LARGE", status: res.status };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res, maxBytes);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, url, failure: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "NETWORK", status: res.status };
  }
  if (!bytes) return { ok: false, url, failure: "TOO_LARGE", status: res.status };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, url, failure: "NOT_UTF8", status: res.status };
  }
  return { ok: true, url, text, bytes: bytes.byteLength };
}
