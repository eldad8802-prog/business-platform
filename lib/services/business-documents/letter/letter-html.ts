/**
 * ר2 — the letter as one self-contained HTML document (RTL, A4, the business's
 * letterhead). Pure: the same input gives the same bytes. Every text value is
 * HTML-escaped; images are accepted only as validated data URLs (no network).
 */
import { formatLetterDate, type LetterInput } from "./letter.contracts";

export type LetterIssuer = {
  displayName: string;
  businessKindLabel: string | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoDataUrl: string | null;
  signatureDataUrl: string | null;
};

export type LetterRecipient = { name: string; address: string };

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i;

export function safeImageDataUrl(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  const t = value.trim();
  return t.length <= 500_000 && IMAGE_DATA_URL.test(t) ? t : null;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Paragraphs split on blank lines; single newlines kept as line breaks. */
export function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("\n");
}

function multiline(value: string): string {
  return value.split("\n").map(escapeHtml).join("<br>");
}

export function buildLetterHtml(args: { input: LetterInput; issuer: LetterIssuer; recipient: LetterRecipient; fontDataUri: string }): string {
  const { input, issuer, recipient, fontDataUri } = args;
  const logo = safeImageDataUrl(issuer.logoDataUrl);
  const signature = input.includeSignatureImage ? safeImageDataUrl(issuer.signatureDataUrl) : null;
  const idLine = [issuer.businessKindLabel, issuer.taxId].filter(Boolean).join(" ");
  const contact = [issuer.address, issuer.phone, issuer.email].filter((x): x is string => Boolean(x && x.trim()));

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.subject)}</title>
<style>
@font-face { font-family: "DubizHebrew"; src: url("${fontDataUri}") format("truetype"); }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "DubizHebrew", sans-serif; color: #1f1b16; font-size: 12.5pt; line-height: 1.65; direction: rtl; }
.page { padding: 22mm 20mm 26mm; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 1.5px solid #8a5a2b; padding-bottom: 10px; }
.issuer-name { font-size: 17pt; font-weight: 700; margin: 0; }
.issuer-line { margin: 2px 0 0; font-size: 10.5pt; color: #4a4239; }
.logo { max-height: 64px; max-width: 160px; object-fit: contain; }
.meta { display: flex; justify-content: space-between; margin-top: 18px; font-size: 11pt; }
.recipient { margin-top: 18px; }
.recipient .label { font-size: 10.5pt; color: #6b6157; }
.recipient .name { font-weight: 700; }
.subject { margin: 22px 0 10px; font-size: 13.5pt; font-weight: 700; }
.subject .label { font-weight: 400; color: #6b6157; }
.body p { margin: 0 0 10px; white-space: normal; overflow-wrap: anywhere; }
.signoff { margin-top: 28px; }
.sig-img { max-height: 70px; max-width: 200px; object-fit: contain; display: block; margin-bottom: 4px; }
.signer { font-weight: 700; }
.foot { position: fixed; bottom: 10mm; left: 20mm; right: 20mm; text-align: center; font-size: 9pt; color: #85796d; border-top: 1px solid #ebe4dc; padding-top: 4px; }
</style>
</head>
<body>
<div class="page">
  <header class="head">
    <div>
      <p class="issuer-name">${escapeHtml(issuer.displayName)}</p>
      ${idLine ? `<p class="issuer-line">${escapeHtml(idLine)}</p>` : ""}
      ${contact.map((c) => `<p class="issuer-line">${escapeHtml(c)}</p>`).join("\n      ")}
    </div>
    ${logo ? `<img class="logo" src="${logo}" alt="">` : ""}
  </header>
  <div class="meta">
    <span>תאריך: ${escapeHtml(formatLetterDate(input.date))}</span>
    ${input.reference ? `<span>סימוכין: ${escapeHtml(input.reference)}</span>` : "<span></span>"}
  </div>
  <section class="recipient">
    <div class="label">לכבוד</div>
    <div class="name">${escapeHtml(recipient.name)}</div>
    ${recipient.address ? `<div>${multiline(recipient.address)}</div>` : ""}
  </section>
  <p class="subject"><span class="label">הנדון:</span> ${escapeHtml(input.subject)}</p>
  <section class="body">
${bodyToHtml(input.body)}
  </section>
  <section class="signoff">
    <div>בברכה,</div>
    ${signature ? `<img class="sig-img" src="${signature}" alt="">` : ""}
    ${input.signerName ? `<div class="signer">${escapeHtml(input.signerName)}</div>` : ""}
    ${input.signerTitle ? `<div>${escapeHtml(input.signerTitle)}</div>` : ""}
    <div>${escapeHtml(issuer.displayName)}</div>
  </section>
</div>
<div class="foot">${escapeHtml(issuer.displayName)}</div>
</body>
</html>`;
}
