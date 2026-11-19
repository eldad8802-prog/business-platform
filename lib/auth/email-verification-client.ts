/**
 * Settings → Security → email address: the client side of the owner's own verification state.
 *
 * Pure and injectable (fetch, event targets) so the suite drives it without a browser. The server owns every
 * rule — who is asked to verify (GET /api/auth/email/status), the resend limits (POST /api/auth/email/resend,
 * 3 / hour per user + the database's ceiling) and the link itself (/verify-email). Nothing here decides, stores
 * or skips verification; it only reads the state and asks for a new link.
 *
 * It replaces the shell-wide banner (2026-11-10): the state now lives in account settings, and nothing outside
 * settings tells a signed-in owner about it.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 *   hidden     — verification is off here, or this account was never asked to verify (opened before it
 *                existed): nothing to show.
 *   verified   — the address is verified (by its link, a password reset or Google).
 *   unverified — the account was opened with verification and the address is not verified yet.
 *   signedOut  — the session is gone (401): the caller sends the person to sign in.
 *   error      — the state could not be read right now.
 */
export type EmailVerificationView =
  | { kind: "hidden" }
  | { kind: "verified" }
  | { kind: "unverified" }
  | { kind: "signedOut" }
  | { kind: "error" };

export async function fetchEmailVerificationView(fetchImpl: FetchLike, headers: HeadersInit): Promise<EmailVerificationView> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/email/status", { headers, cache: "no-store" });
  } catch {
    return { kind: "error" };
  }
  if (res.status === 401) return { kind: "signedOut" };
  if (!res.ok) return { kind: "error" };
  const d = (await res.json().catch(() => null)) as { verificationEnabled?: unknown; required?: unknown; verified?: unknown } | null;
  if (!d || d.verificationEnabled !== true) return { kind: "hidden" };
  if (d.verified === true) return { kind: "verified" };
  if (d.required === true) return { kind: "unverified" };
  return { kind: "hidden" };
}

/**
 * What "send the link again" ended in. `message` is the server's own sentence when it gave one (already in
 * the interface language); the screen falls back to its own text otherwise.
 *
 *   sent           — a new link was issued (delivery runs after the response; the sweep retries it).
 *   alreadyVerified — the address was verified meanwhile (e.g. the link was opened in Chrome).
 *   notRequired    — this account is not asked to verify.
 *   rateLimited    — the per-user limit or the database's hourly ceiling.
 *   unavailable    — verification was turned off here.
 *   signedOut      — 401.
 *   failed         — the server could not issue it.
 *   offline        — no answer at all.
 */
export type ResendOutcome =
  | { kind: "sent"; message: string | null }
  | { kind: "alreadyVerified"; message: string | null }
  | { kind: "notRequired" }
  | { kind: "rateLimited"; message: string | null }
  | { kind: "unavailable"; message: string | null }
  | { kind: "signedOut" }
  | { kind: "failed"; message: string | null }
  | { kind: "offline" };

export async function requestVerificationLink(fetchImpl: FetchLike, headers: HeadersInit): Promise<ResendOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/auth/email/resend", { method: "POST", headers });
  } catch {
    return { kind: "offline" };
  }
  const d = (await res.json().catch(() => ({}))) as { alreadyVerified?: unknown; notRequired?: unknown; message?: unknown; error?: unknown; code?: unknown };
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  if (res.status === 401) return { kind: "signedOut" };
  if (res.ok) {
    if (d.alreadyVerified === true) return { kind: "alreadyVerified", message: text(d.message) };
    if (d.notRequired === true) return { kind: "notRequired" };
    return { kind: "sent", message: text(d.message) };
  }
  if (res.status === 429 || d.code === "RATE_LIMITED") return { kind: "rateLimited", message: text(d.error) };
  if (res.status === 404 || d.code === "FEATURE_DISABLED") return { kind: "unavailable", message: text(d.error) };
  return { kind: "failed", message: text(d.error) };
}

type Listenable = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

/**
 * Calls `onReturn` when the screen comes back into view: the app returning from Chrome (Android WebView
 * fires visibilitychange on resume), a tab regaining focus, a page restored from the back/forward cache.
 * The three often fire together, so calls within `minGapMs` collapse into one. Returns the unsubscribe.
 */
export function watchReturnToScreen(
  targets: { document: Listenable & { visibilityState?: string }; window: Listenable },
  onReturn: () => void,
  opts: { minGapMs?: number; now?: () => number } = {}
): () => void {
  const minGap = opts.minGapMs ?? 1500;
  const now = opts.now ?? Date.now;
  let last = -Infinity;
  const fire = () => {
    if (targets.document.visibilityState && targets.document.visibilityState !== "visible") return;
    const t = now();
    if (t - last < minGap) return;
    last = t;
    onReturn();
  };
  targets.document.addEventListener("visibilitychange", fire);
  targets.window.addEventListener("focus", fire);
  targets.window.addEventListener("pageshow", fire);
  return () => {
    targets.document.removeEventListener("visibilitychange", fire);
    targets.window.removeEventListener("focus", fire);
    targets.window.removeEventListener("pageshow", fire);
  };
}
