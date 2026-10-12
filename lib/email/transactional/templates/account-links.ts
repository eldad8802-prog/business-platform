/**
 * EMAIL_VERIFY and PASSWORD_RESET — the two account-link emails.
 *
 * Same frame as WELCOME (Hebrew, RTL, table-based, inline styles, single column, max 560px, a
 * plain-text part with the same words and the same link). The payload holds the token id and the first
 * name only; the link's secret is derived at render time (lib/auth/email-link.ts) and never stored.
 */

import { buildEmailLink, type EmailTokenPurpose } from "@/lib/auth/email-link";

import { firstNameOf, greeting, type RenderedEmail } from "./welcome";

export type AccountLinkPayload = { tokenId: string; firstName: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseAccountLinkPayload(value: unknown): AccountLinkPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "tokenId" && k !== "firstName")) return null;
  const { tokenId, firstName } = value as { tokenId?: unknown; firstName?: unknown };
  if (typeof tokenId !== "string" || !UUID.test(tokenId)) return null;
  if (firstName !== undefined && firstName !== null && typeof firstName !== "string") return null;
  return { tokenId, firstName: typeof firstName === "string" ? firstNameOf(firstName) : null };
}

type Copy = {
  subject: string;
  preheader: string;
  lines: string[];
  cta: string;
  after: string[];
  reason: string;
};

export const EMAIL_VERIFY_COPY: Copy = {
  subject: "אימות כתובת האימייל שלך ב־Dubiz",
  preheader: "לחיצה אחת כדי לאשר שזו הכתובת שלך.",
  lines: ["כדי לוודא שהכתובת הזו שייכת לך, נשאר רק ללחוץ על הכפתור."],
  cta: "אימות הכתובת",
  after: ["הקישור בתוקף ל־24 שעות ואפשר להשתמש בו פעם אחת."],
  reason: "קיבלת את המייל הזה כי נפתח חשבון Dubiz עם הכתובת הזו. אם לא ביקשת לפתוח חשבון — אפשר להתעלם ממנו.",
};

export const PASSWORD_RESET_COPY: Copy = {
  subject: "בחירת סיסמה חדשה ל־Dubiz",
  preheader: "הקישור לבחירת סיסמה חדשה בתוקף לשעה.",
  lines: ["קיבלנו בקשה לבחור סיסמה חדשה לחשבון שלך."],
  cta: "בחירת סיסמה חדשה",
  after: [
    "הקישור בתוקף לשעה אחת ואפשר להשתמש בו פעם אחת. אחרי שינוי הסיסמה ננתק את כל המכשירים המחוברים לחשבון.",
  ],
  reason: "אם לא ביקשת לשנות סיסמה — אפשר להתעלם מהמייל. הסיסמה הנוכחית נשארת כמו שהיא.",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(copy: Copy, firstName: string | null, link: string): RenderedEmail {
  const hello = greeting(firstName);
  const text = [hello, "", ...copy.lines, "", `${copy.cta}: ${link}`, "", ...copy.after, "", "צוות Dubiz", "", "—", copy.reason].join("\n");

  const C = { page: "#f4f5f0", card: "#ffffff", border: "#e3e6de", text: "#23302b", muted: "#566159", brand: "#246966", onBrand: "#ffffff" };
  const font = "Arial, 'Helvetica Neue', Helvetica, sans-serif";
  const p = `margin:0 0 16px 0;font-family:${font};font-size:16px;line-height:1.6;color:${C.text};text-align:right;`;
  const small = `margin:0 0 16px 0;font-family:${font};font-size:14px;line-height:1.6;color:${C.muted};text-align:right;`;

  const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};" dir="rtl">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;" dir="rtl">
<tr><td style="padding:0 4px 20px 4px;text-align:right;font-family:${font};font-size:24px;font-weight:700;letter-spacing:0.2px;color:${C.brand};">Dubiz</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px 28px;text-align:right;" dir="rtl">
<p style="margin:0 0 20px 0;font-family:${font};font-size:22px;line-height:1.4;font-weight:700;color:${C.text};text-align:right;">${escapeHtml(hello)}</p>
${copy.lines.map((l) => `<p style="${p}">${escapeHtml(l)}</p>`).join("\n")}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px 0;"><tr>
<td style="border-radius:10px;background:${C.brand};">
<a href="${escapeHtml(link)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:16px;font-weight:700;line-height:1;color:${C.onBrand};text-decoration:none;border-radius:10px;">${escapeHtml(copy.cta)}</a>
</td></tr></table>
${copy.after.map((l) => `<p style="${small}">${escapeHtml(l)}</p>`).join("\n")}
<p style="margin:0;font-family:${font};font-size:16px;line-height:1.6;color:${C.text};text-align:right;">צוות Dubiz</p>
</td></tr>
<tr><td style="padding:20px 4px 0 4px;text-align:right;font-family:${font};font-size:13px;line-height:1.6;color:${C.muted};">${escapeHtml(copy.reason)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject: copy.subject, html, text };
}

function renderFor(purpose: EmailTokenPurpose, copy: Copy) {
  return (payload: AccountLinkPayload, ctx: { appBaseUrl: string }): RenderedEmail =>
    render(copy, payload.firstName, buildEmailLink(ctx.appBaseUrl, payload.tokenId, purpose));
}

export const renderEmailVerify = renderFor("EMAIL_VERIFY", EMAIL_VERIFY_COPY);
export const renderPasswordReset = renderFor("PASSWORD_RESET", PASSWORD_RESET_COPY);
