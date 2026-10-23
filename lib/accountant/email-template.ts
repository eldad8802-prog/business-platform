/**
 * The email that carries the accountant package link — the same frame as Dubiz's account emails
 * (Hebrew, RTL, table-based, inline styles, max 560px, a plain-text part with the same words and link).
 *
 * It contains no financial data at all: the business's name, the month, who sent it, the protected link
 * and its expiry. The package itself is reachable only through the link.
 */

import type { RenderedEmail } from "@/lib/email/transactional/templates/welcome";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One line of plain text: no control characters, bounded. */
function clean(s: string, max: number): string {
  return s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function renderAccountantPackageEmail(input: {
  businessName: string;
  recipientName: string;
  periodLabel: string;
  link: string;
  expiresOn: string;
  incomplete: boolean;
}): RenderedEmail {
  const business = clean(input.businessName, 120) || "בעל העסק";
  const recipient = clean(input.recipientName, 120);
  const period = clean(input.periodLabel, 40);
  const subject = `חבילת רואה החשבון של ${business} — ${period}`;
  const hello = recipient ? `שלום ${recipient},` : "שלום,";
  const lines = [
    `${business} שלח/ה לך דרך Dubiz את חבילת המסמכים לחודש ${period}.`,
    "בחבילה: דוח מסכם, המסמכים הסרוקים שאושרו, המסמכים שהופקו בדוביז ורשימת מה שעדיין פתוח.",
  ];
  if (input.incomplete) {
    lines.push("בעל העסק ציין שחלק מהמסמכים לחודש הזה עדיין פתוחים — הפירוט בקובץ הסיכום שבחבילה.");
  }
  const cta = "הורדת החבילה";
  const after = [
    `הקישור בתוקף עד ${input.expiresOn} והוא אישי — אין להעביר אותו הלאה.`,
    "אם הקישור לא נפתח, אפשר לבקש מבעל העסק לשלוח שוב.",
  ];
  const reason = "קיבלת את המייל הזה כי בעל העסק הגדיר אותך כרואה החשבון שלו ב־Dubiz ואישר את השליחה.";

  const text = [hello, "", ...lines, "", `${cta}: ${input.link}`, "", ...after, "", "Dubiz", "", "—", reason].join("\n");

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
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};" dir="rtl">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(`חבילת המסמכים לחודש ${period}`)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;" dir="rtl">
<tr><td style="padding:0 4px 20px 4px;text-align:right;font-family:${font};font-size:24px;font-weight:700;letter-spacing:0.2px;color:${C.brand};">Dubiz</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px 28px;text-align:right;" dir="rtl">
<p style="margin:0 0 20px 0;font-family:${font};font-size:22px;line-height:1.4;font-weight:700;color:${C.text};text-align:right;">${escapeHtml(hello)}</p>
${lines.map((l) => `<p style="${p}">${escapeHtml(l)}</p>`).join("\n")}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px 0;"><tr>
<td style="border-radius:10px;background:${C.brand};">
<a href="${escapeHtml(input.link)}" target="_blank" rel="noreferrer noopener" style="display:inline-block;padding:14px 28px;font-family:${font};font-size:16px;font-weight:700;line-height:1;color:${C.onBrand};text-decoration:none;border-radius:10px;">${escapeHtml(cta)}</a>
</td></tr></table>
${after.map((l) => `<p style="${small}">${escapeHtml(l)}</p>`).join("\n")}
</td></tr>
<tr><td style="padding:20px 4px 0 4px;text-align:right;font-family:${font};font-size:13px;line-height:1.6;color:${C.muted};">${escapeHtml(reason)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject, html, text };
}
