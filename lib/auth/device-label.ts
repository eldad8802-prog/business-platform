/**
 * A human name for a device, derived from the User-Agent at read time.
 *
 * WHY DERIVED AND NOT STORED
 *
 * Parsing rules improve. A label written into the row on the day the session was
 * created would freeze whatever the parser believed then, and re-deriving costs
 * nothing. The raw header stays server-side; only the output of this function is
 * ever sent to a client.
 *
 * WHY THE OUTPUT SET IS CLOSED
 *
 * The input is attacker-controlled. Every branch below returns one of a fixed
 * set of strings assembled from constants — no fragment of the header reaches the
 * result, so a hostile User-Agent cannot put text of its choosing on the owner's
 * screen. That is a stronger guarantee than escaping, because there is nothing to
 * escape.
 *
 * WHAT THIS DELIBERATELY IS NOT
 *
 * Not fingerprinting. It reads one header the browser sends to every site
 * already, and it identifies a browser and a platform, not a person or a
 * machine. No canvas, no hardware id, no IP, no location.
 *
 * It is also honest about its limits: a User-Agent can be absent, spoofed or
 * simply unfamiliar, and all three end at "מכשיר לא מזוהה" rather than a guess
 * dressed up as a fact.
 */

export const UNKNOWN_DEVICE = "מכשיר לא מזוהה";

/** The longest header we will ever store. Enforced before the insert, not after. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * Truncate before the database sees it.
 *
 * The column is varchar(512), so an oversized header would otherwise raise an
 * error inside login's session issuance — and under the Phase 3.3 contract a
 * failed issuance fails the login. A hostile header must cost its sender an ugly
 * label, not cost the owner their sign-in.
 */
export function normalizeUserAgent(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, USER_AGENT_MAX_LENGTH);
}

type Browser = "Chrome" | "Edge" | "Safari" | "Firefox" | "Opera" | "Samsung Internet" | null;
type Platform = "Windows" | "Mac" | "iPhone" | "iPad" | "Android" | "Linux" | null;

/**
 * Order matters here and the comments say why, because every one of these is a
 * substring of something else.
 */
function readBrowser(ua: string): Browser {
  // Edge and Opera both still say "Chrome"; Chrome must be last of the three.
  if (/\bEdg[A-Z]?\//.test(ua)) return "Edge";
  if (/\bOPR\//.test(ua) || /\bOpera\b/.test(ua)) return "Opera";
  if (/\bSamsungBrowser\//.test(ua)) return "Samsung Internet";
  if (/\bFirefox\//.test(ua) || /\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bCriOS\//.test(ua)) return "Chrome"; // Chrome on iOS
  if (/\bChrome\//.test(ua) || /\bChromium\//.test(ua)) return "Chrome";
  // Safari claims to be like every other browser, so it is only Safari when
  // nothing above matched AND it says Version/x Safari.
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Safari";
  return null;
}

function readPlatform(ua: string): Platform {
  // iPadOS reports itself as Macintosh, so iPad has to be tested first.
  if (/\biPad\b/.test(ua)) return "iPad";
  if (/\biPhone\b/.test(ua) || /\biPod\b/.test(ua)) return "iPhone";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b/.test(ua) || /\bMacintosh\b/.test(ua)) return "Mac";
  if (/\bLinux\b/.test(ua) || /\bX11\b/.test(ua)) return "Linux";
  return null;
}

const PLATFORM_HE: Record<NonNullable<Platform>, string> = {
  Windows: "Windows",
  Mac: "Mac",
  iPhone: "iPhone",
  iPad: "iPad",
  Android: "Android",
  Linux: "Linux",
};

/**
 * The label the owner reads. One of a closed set, assembled from the constants
 * above and nothing from the header itself.
 */
export function deviceLabel(rawUserAgent: string | null | undefined): string {
  const ua = normalizeUserAgent(rawUserAgent);
  if (ua === null) return UNKNOWN_DEVICE;

  const browser = readBrowser(ua);
  const platform = readPlatform(ua);

  if (browser !== null && platform !== null) return `${browser} · ${PLATFORM_HE[platform]}`;
  if (browser !== null) return browser;
  if (platform !== null) return PLATFORM_HE[platform];
  return UNKNOWN_DEVICE;
}
