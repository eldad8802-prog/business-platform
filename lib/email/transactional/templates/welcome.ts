/**
 * WELCOME — the first transactional email, sent once after a NEW SUCCESSFUL SIGNUP.
 *
 * Copy: the owner-approved draft, verbatim. Hebrew, RTL. The HTML is table-based with inline
 * styles (what mail clients actually render), single column, max 560px, so it reads the same on
 * a phone and on a desktop client; the plain-text part carries the same words and the same link.
 *
 * The only personal value is the first name, escaped for HTML. No business data, no figures.
 */

export type WelcomePayload = {
  /** First word of the name the owner typed at signup. Absent → a greeting without a name. */
  firstName: string | null;
};

export type RenderedEmail = { subject: string; html: string; text: string };

export const WELCOME_SUBJECT = "ברוכים הבאים ל־Dubiz 👋";
export const WELCOME_CTA_LABEL = "כניסה ל־Dubiz";
/** Where the CTA goes, relative to APP_BASE_URL. Login forwards a signed-in owner to Home. */
export const WELCOME_CTA_PATH = "/login";

export const WELCOME_LINES = {
  thanks: "כיף שהצטרפת ל־Dubiz.",
  value: "מעכשיו יש לך מקום אחד לנהל את העסק — הכנסות והוצאות, לקוחות, מסמכים, גבייה ועוד.",
  noSetup:
    "אין צורך להגדיר הכול מראש. פשוט מתחילים לעבוד, ו־Dubiz ילמד את העסק תוך כדי ויעזור לך לראות מה חשוב ומה דורש תשומת לב.",
  signature: "צוות Dubiz",
  /** Not in the approved draft — proposed for review: why the recipient is getting this. */
  reason: "קיבלת את המייל הזה כי נפתח חשבון Dubiz עם הכתובת הזו.",
} as const;

const MAX_FIRST_NAME = 60;

/** The first whitespace-separated word of a display name; null when there is nothing usable. */
export function firstNameOf(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").trim();
  const first = cleaned.split(/\s+/)[0] ?? "";
  if (!first) return null;
  return first.slice(0, MAX_FIRST_NAME);
}

/** Validates a stored payload. Anything but the declared shape is refused (→ a permanent failure). */
export function parseWelcomePayload(value: unknown): WelcomePayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "firstName")) return null;
  const firstName = (value as { firstName?: unknown }).firstName;
  if (firstName === undefined || firstName === null) return { firstName: null };
  if (typeof firstName !== "string") return null;
  return { firstName: firstNameOf(firstName) };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function greeting(firstName: string | null): string {
  return firstName ? `היי ${firstName},` : "היי,";
}

export function renderWelcome(payload: WelcomePayload, ctx: { appBaseUrl: string }): RenderedEmail {
  const ctaUrl = `${ctx.appBaseUrl}${WELCOME_CTA_PATH}`;
  const hello = greeting(payload.firstName);

  const text = [
    hello,
    "",
    WELCOME_LINES.thanks,
    WELCOME_LINES.value,
    "",
    WELCOME_LINES.noSetup,
    "",
    `${WELCOME_CTA_LABEL}: ${ctaUrl}`,
    "",
    WELCOME_LINES.signature,
    "",
    "—",
    WELCOME_LINES.reason,
  ].join("\n");

  const C = {
    page: "#f4f5f0",
    card: "#ffffff",
    border: "#e3e6de",
    text: "#23302b",
    muted: "#566159",
    brand: "#246966",
    onBrand: "#ffffff",
  };
  const font = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
  const p = `margin:0 0 16px 0;font-family:${font};font-size:16px;line-height:1.6;color:${C.text};text-align:right;`;

  const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(WELCOME_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};" dir="rtl">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(WELCOME_LINES.value)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;" dir="rtl">
<tr><td style="padding:0 4px 20px 4px;text-align:right;font-family:${font};font-size:24px;font-weight:700;letter-spacing:0.2px;color:${C.brand};">Dubiz</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px 28px;text-align:right;" dir="rtl">
<p style="margin:0 0 20px 0;font-family:${font};font-size:22px;line-height:1.4;font-weight:700;color:${C.text};text-align:right;">${escapeHtml(hello)}</p>
<p style="${p}">${escapeHtml(WELCOME_LINES.thanks)}<br>${escapeHtml(WELCOME_LINES.value)}</p>
<p style="${p}">${escapeHtml(WELCOME_LINES.noSetup)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px 0;"><tr>
<td style="border-radius:10px;background:${C.brand};">
<a href="${escapeHtml(ctaUrl)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:16px;font-weight:700;line-height:1;color:${C.onBrand};text-decoration:none;border-radius:10px;">${escapeHtml(WELCOME_CTA_LABEL)}</a>
</td></tr></table>
<p style="margin:0;font-family:${font};font-size:16px;line-height:1.6;color:${C.text};text-align:right;">${escapeHtml(WELCOME_LINES.signature)}</p>
</td></tr>
<tr><td style="padding:20px 4px 0 4px;text-align:right;font-family:${font};font-size:13px;line-height:1.6;color:${C.muted};">${escapeHtml(WELCOME_LINES.reason)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: WELCOME_SUBJECT, html, text };
}
