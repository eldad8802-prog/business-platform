import { buildClientAuthHeaders } from "@/lib/client-session";

/**
 * Authenticated GET with a short in-memory cache and in-flight de-duplication.
 *
 * The shell and the Home screen read some of the same sources (the unread
 * count, the waiting conversations, the collection inbox). Sharing one
 * promise per URL means a source is asked once even when two surfaces mount
 * together, and a quick back-and-forth between routes does not re-ask it.
 *
 * A failure is never cached: the next caller asks again. A non-OK response
 * rejects with the status, so callers keep "failed" apart from "empty".
 */

type Entry = { at: number; promise: Promise<unknown> };

const cache = new Map<string, Entry>();

export class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export function fetchJsonCached<T>(url: string, ttlMs = 30_000): Promise<T> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < ttlMs) return hit.promise as Promise<T>;

  const promise = fetch(url, { cache: "no-store", headers: buildClientAuthHeaders() }).then(
    async (res) => {
      if (!res.ok) throw new HttpStatusError(res.status);
      return (await res.json()) as T;
    },
  );
  cache.set(url, { at: now, promise });
  promise.catch(() => {
    if (cache.get(url)?.promise === promise) cache.delete(url);
  });
  return promise;
}

/** Forget a cached source, e.g. after the owner acted on it. */
export function invalidateCachedJson(url: string): void {
  cache.delete(url);
}
