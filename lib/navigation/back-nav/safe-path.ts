/**
 * Safe in-app path validation for every back / return target.
 *
 * Any destination that did not come from a literal in our own code — a
 * `returnTo` / `from` query param, a stored trail entry, a caller-provided
 * fallback — passes through {@link toSafeInternalPath} before the router ever
 * sees it. The result is either a same-origin "/path?query" string or null.
 *
 * Rejected:
 *  - anything that is not a string, is empty, or is absurdly long;
 *  - protocol-relative ("//evil.com"), backslash ("/\\evil.com") and any
 *    scheme ("https:", "javascript:") — i.e. everything that can leave Dubiz;
 *  - control characters (header/log injection, CR/LF tricks);
 *  - technical / auth surfaces that must never be a "previous screen":
 *    /api, /_next, /login, /register, /logout, /auth, /onboarding, static files.
 *
 * The hash is dropped: it never identifies a screen in this app.
 */

const PARSE_BASE = "https://dubiz.invalid";
const MAX_LENGTH = 2048;

/** Path prefixes that are never a valid back / return destination. */
const TECHNICAL_PREFIXES = [
  "/api",
  "/_next",
  "/login",
  "/register",
  "/logout",
  "/auth",
  "/onboarding",
] as const;

function hasPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** True for auth / framework / static-asset paths (never a screen to return to). */
export function isTechnicalPath(pathname: string): boolean {
  if (TECHNICAL_PREFIXES.some((p) => hasPrefix(pathname, p))) return true;
  // Static assets ("/favicon.ico", "/manifest.webmanifest", "/x.png").
  const last = pathname.split("/").pop() ?? "";
  return /\.[a-z0-9]{2,5}$/i.test(last);
}

/**
 * Returns a normalized same-origin "/path?query" or null when `raw` is not a
 * safe in-app screen path.
 */
export function toSafeInternalPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.includes("\\")) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(value, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE) return null;
  // A path that decodes to a protocol-relative form is refused as well.
  let decoded = url.pathname;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\")) return null;
  if (isTechnicalPath(url.pathname)) return null;

  return `${url.pathname}${url.search}`;
}

/** Pathname part of an in-app URL ("/a/b?x=1" → "/a/b"); "" when unparsable. */
export function pathnameOf(url: string): string {
  try {
    return new URL(url, PARSE_BASE).pathname;
  } catch {
    return "";
  }
}
