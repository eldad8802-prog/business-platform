/**
 * Service Desk 1.3b-B — the intake slip as a self-contained Hebrew RTL HTML document. PURE (no I/O, no clock): the
 * service passes every value, including the formatted time. Every text is HTML-escaped; the only image is the customer's
 * signature as a validated PNG data URL; the font is embedded; nothing is fetched (no external URL, no script).
 *
 * The slip restates what the customer signed and the evidence that binds it: the frozen terms and statutory notice with
 * their versions and hashes, the intake data, the photo hashes, the signature hash and the intake digest journaled with
 * the signature (SIGNED event).
 */

export type IntakeSlipInput = {
  business: { name: string };
  caseNumber: number;
  customerName: string | null;
  item: { category: string | null; brand: string | null; model: string | null; serialNumber: string | null; problemDescription: string | null };
  intake: { conditionNote: string | null; accessoriesNote: string | null };
  photos: { sha256: string }[];
  terms: { version: number; sha256: string; body: string };
  statutory: { version: number; sha256: string; body: string };
  signature: { pngDataUrl: string; sha256: string; signedAtText: string };
  evidence: { intakeSha256: string | null };
  fontDataUri: string;
};

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Paragraphs split on blank lines; single newlines kept as line breaks. */
function bodyToHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("\n");
}

const text = (v: string | null | undefined, empty = "—") => (v && v.trim() ? escapeHtml(v.trim()) : empty);
const hash = (v: string | null | undefined) => (v && SHA256.test(v) ? v : "—");

/** The intake slip HTML. Throws on a signature that is not a PNG data URL or a font that is not a TTF data URL. */
export function buildIntakeSlipHtml(i: IntakeSlipInput): string {
  if (!PNG_DATA_URL.test(i.signature.pngDataUrl) || i.signature.pngDataUrl.length > 800_000) throw new RangeError("signature must be a PNG data URL");
  if (!/^data:font\/ttf;base64,[A-Za-z0-9+/]+={0,2}$/.test(i.fontDataUri)) throw new RangeError("font must be a TTF data URL");
  const item = [i.item.category, i.item.brand, i.item.model].filter((x): x is string => Boolean(x && x.trim())).map((x) => x.trim()).join(" · ");
  const photos = i.photos.length === 0
    ? "<p class=\"muted\">לא צולמו תמונות בקליטה.</p>"
    : `<ol class="hashes">${i.photos.map((p) => `<li><span dir="ltr">${hash(p.sha256)}</span></li>`).join("")}</ol>`;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<title>טופס קליטה — תיק ${i.caseNumber}</title>
<style>
@font-face { font-family: "DubizHebrew"; src: url("${i.fontDataUri}") format("truetype"); }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: "DubizHebrew", sans-serif; color: #1f1b16; font-size: 10.5pt; line-height: 1.5; direction: rtl; }
.page { padding: 14mm 16mm 14mm; }
.head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1.5px solid #8a5a2b; padding-bottom: 8px; }
.biz { font-size: 16pt; font-weight: 700; margin: 0; }
.doc { font-size: 13pt; margin: 0; }
.case { font-size: 11pt; color: #4a4239; }
h2 { font-size: 11.5pt; margin: 10px 0 4px; color: #5a3a1b; }
.grid { display: grid; grid-template-columns: 9em 1fr; gap: 2px 12px; }
.label { color: #6b6157; }
.terms { border: 1px solid #d9cfc4; border-radius: 6px; padding: 8px 12px; font-size: 9.5pt; }
.terms p { margin: 0 0 6px; }
.meta { font-size: 8.5pt; color: #6b6157; margin-top: 4px; }
.signature { margin-top: 10px; border-top: 1px dashed #b9ab9b; padding-top: 8px; }
.signature img { max-width: 260px; max-height: 110px; display: block; }
.hashes { font-size: 7.5pt; color: #4a4239; margin: 0; padding-inline-start: 18px; line-height: 1.35; }
.grid span[dir="ltr"] { text-align: right; unicode-bidi: plaintext; }
.evidence { margin-top: 10px; break-inside: avoid; font-size: 8pt; color: #4a4239; border-top: 1px solid #d9cfc4; padding-top: 6px; }
.evidence span[dir="ltr"] { font-family: monospace; }
.evidence p { margin: 2px 0; }
.muted { color: #6b6157; }
</style>
</head>
<body>
<div class="page">
  <div class="head">
    <div>
      <p class="biz">${text(i.business.name)}</p>
      <p class="doc">טופס קליטה לשירות</p>
    </div>
    <div class="case">תיק מספר ${i.caseNumber}</div>
  </div>

  <h2>הלקוח והפריט</h2>
  <div class="grid">
    <span class="label">לקוח</span><span>${text(i.customerName)}</span>
    <span class="label">פריט</span><span>${item ? escapeHtml(item) : "—"}</span>
    <span class="label">מספר סידורי</span><span dir="ltr">${text(i.item.serialNumber)}</span>
    <span class="label">תיאור התקלה</span><span>${text(i.item.problemDescription)}</span>
  </div>

  <h2>מצב הפריט בקליטה</h2>
  <div class="grid">
    <span class="label">מצב חיצוני</span><span>${text(i.intake.conditionNote)}</span>
    <span class="label">אביזרים שנמסרו</span><span>${text(i.intake.accessoriesNote)}</span>
    <span class="label">תמונות</span><span>${i.photos.length}</span>
  </div>

  <h2>תנאי השירות (גרסה ${i.terms.version})</h2>
  <div class="terms">${bodyToHtml(i.terms.body)}</div>
  <p class="meta">טביעת הנוסח: <span dir="ltr">${hash(i.terms.sha256)}</span></p>

  <h2>הודעה לפי דין (גרסה ${i.statutory.version})</h2>
  <div class="terms">${bodyToHtml(i.statutory.body)}</div>
  <p class="meta">טביעת הנוסח: <span dir="ltr">${hash(i.statutory.sha256)}</span></p>

  <div class="signature">
    <h2>חתימת הלקוח</h2>
    <img src="${i.signature.pngDataUrl}" alt="חתימת הלקוח">
    <p class="meta">נחתם: ${escapeHtml(i.signature.signedAtText)}</p>
  </div>

  <h2>תמונות הקליטה (טביעות)</h2>
  ${photos}

  <div class="evidence">
    <p>פרטי אימות — הנתונים להלן קושרים את המסמך לרשומת הקליטה החתומה.</p>
    <p>טביעת החתימה: <span dir="ltr">${hash(i.signature.sha256)}</span></p>
    <p>טביעת נתוני הקליטה: <span dir="ltr">${hash(i.evidence.intakeSha256)}</span></p>
  </div>
</div>
</body>
</html>`;
}
