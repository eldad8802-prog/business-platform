/**
 * Persistent login — the cookie, and the CSRF defence that has to come with it.
 *
 * A refresh credential in a cookie is sent by the browser automatically. That is
 * the point of it, and it is also the entire risk: without a defence, any site
 * could POST to the refresh endpoint and receive a fresh access token for the
 * victim. The bearer token this product already uses has no such exposure
 * because it is never sent automatically.
 *
 * FOUR DEFENCES, and the reason none of them is dropped:
 *
 *   1. SameSite=Strict — the structural one. The browser does not attach the
 *      cookie to a cross-site request at all, so the endpoint never sees it.
 *   2. Origin equality — checked, not assumed. Strict is enforced by the
 *      browser, and an endpoint that trusts the browser to have done its job has
 *      no answer for a client that is not one. A same-origin POST from a browser
 *      always carries Origin.
 *   3. Sec-Fetch-Site corroboration — a second, independently-sourced signal.
 *      When present it must say `same-origin`. It is not required, because a
 *      non-browser client legitimately omits it.
 *   4. POST only — a GET could be triggered by an image tag.
 *
 * COOKIE `Path` IS EXPLICITLY NOT A CSRF DEFENCE and is not counted as one. It
 * narrows where the credential is sent, which is worth having, but any page on
 * this origin can reach any path on it.
 *
 * The cookie is HttpOnly, so no script can read the credential, and Secure, so
 * it is never sent in the clear. `__Host-` is deliberately NOT used as a prefix:
 * it would force `Path=/`, and sending this credential on every request to the
 * origin is the opposite of what the Path narrowing is for.
 */

/** One name, one place. Renaming it signs everyone out, so it is a decision. */
export const REFRESH_COOKIE_NAME = "dz_refresh";

/**
 * The credential is only ever sent to the auth endpoints that consume it.
 * Narrowing, not a defence — see the header.
 */
export const REFRESH_COOKIE_PATH = "/api/auth";

export type CsrfVerdict = { ok: true } | { ok: false; reason: "origin_missing" | "origin_mismatch" | "cross_site" };

/**
 * The request's own origin, from the headers a proxy actually sets. `req.url` is
 * not usable here: behind Vercel it carries the internal host, which would never
 * equal the Origin the browser sends.
 */
function selfOrigin(req: Request): string | null {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = forwardedHost ?? req.headers.get("host");
  if (!host) return null;
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`.toLowerCase();
}

/**
 * Fail-closed CSRF check. A missing Origin is a REFUSAL, not a pass: every
 * browser sends it on a cross-origin POST and on a same-origin POST, so its
 * absence means the caller is not the browser this defence is written for.
 */
export function verifyRefreshCsrf(req: Request): CsrfVerdict {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    // `none` is a direct navigation, which cannot be a cross-site POST.
    return { ok: false, reason: "cross_site" };
  }

  const origin = req.headers.get("origin");
  if (!origin) {
    return { ok: false, reason: "origin_missing" };
  }
  const self = selfOrigin(req);
  if (!self || origin.toLowerCase() !== self) {
    return { ok: false, reason: "origin_mismatch" };
  }
  return { ok: true };
}

/**
 * Serialize the Set-Cookie value.
 *
 * `maxAgeSeconds === 0` is the clearing form: an immediate expiry with an empty
 * value, and it MUST carry the same Path and SameSite as the cookie it clears or
 * the browser keeps the original.
 */
export function serializeRefreshCookie(value: string, maxAgeSeconds: number): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${value}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  return parts.join("; ");
}

/** The clearing form. Used on logout and whenever a credential is refused. */
export function clearRefreshCookie(): string {
  return serializeRefreshCookie("", 0);
}

/**
 * Read the cookie without pulling in a parser. Split on ";" only — a cookie
 * VALUE cannot contain ";" or "," unquoted, and ours is base64url plus one dot.
 */
export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
