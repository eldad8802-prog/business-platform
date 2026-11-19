/**
 * Service Desk — the intake slip as a self-contained Hebrew RTL HTML document. PURE (no I/O, no clock): the service
 * passes every value, including the formatted time. Every text is HTML-escaped; nothing is fetched (no image, no script,
 * no external URL); the font is embedded.
 *
 * Owner decision 2026-11-11: no customer signature and no legal-terms text. The slip restates the documented intake and
 * names the user who confirmed it, with when; the evidence block binds it to the record (the intake digest, the photo
 * hashes).
 */

export type IntakeSlipInput = {
  business: { name: string };
  caseNumber: number;
  customerName: string | null;
  item: { category: string | null; brand: string | null; model: string | null; serialNumber: string | null; problemDescription: string | null };
  intake: { conditionNote: string | null; accessoriesNote: string | null };
  photos: { sha256: string }[];
  confirmation: { byName: string | null; atText: string };
  evidence: { intakeSha256: string };
  fontDataUri: string;
};

const SHA256 = /^[0-9a-f]{64}$/;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const text = (v: string | null | undefined, empty = "—") => (v && v.trim() ? escapeHtml(v.trim()) : empty);
const hash = (v: string | null | undefined) => (v && SHA256.test(v) ? v : "—");

/** The intake slip HTML. Throws on a font that is not a TTF data URL. */
export function buildIntakeSlipHtml(i: IntakeSlipInput): string {
  if (!/^data:font\/ttf;base64,[A-Za-z0-9+/]+={0,2}$/.test(i.fontDataUri)) throw new RangeError("font must be a TTF data URL");
  const item = [i.item.category, i.item.brand, i.item.model].filter((x): x is string => Boolean(x && x.trim())).map((x) => x.trim()).join(" · ");
  const photos = i.photos.length === 0
    ? "<p class=\"muted\">לא צולמו תמונות בקליטה.</p>"
    : `<ol class="hashes">${i.photos.map((p) => `<li><span dir="ltr">${hash(p.sha256)}</span></li>`).join("")}</ol>`;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src data:; style-src 'unsafe-inline'">
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
h2 { font-size: 11.5pt; margin: 12px 0 4px; color: #5a3a1b; }
.grid { display: grid; grid-template-columns: 9em 1fr; gap: 2px 12px; }
.grid span[dir="ltr"] { text-align: right; unicode-bidi: plaintext; }
.label { color: #6b6157; }
.confirm { margin-top: 12px; border: 1px solid #d9cfc4; border-radius: 6px; padding: 8px 12px; }
.confirm p { margin: 0; }
.hashes { font-size: 7.5pt; color: #4a4239; margin: 0; padding-inline-start: 18px; line-height: 1.35; }
.evidence { margin-top: 10px; font-size: 8pt; color: #4a4239; border-top: 1px solid #d9cfc4; padding-top: 6px; break-inside: avoid; }
.evidence p { margin: 2px 0; }
.evidence span[dir="ltr"] { font-family: monospace; }
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
    <span class="label">אביזרים שנמסרו</span><span>${text(i.intake.accessoriesNote, "לא נמסרו אביזרים")}</span>
    <span class="label">תמונות</span><span>${i.photos.length}</span>
  </div>

  <div class="confirm">
    <p><strong>הקליטה אושרה</strong> על ידי ${text(i.confirmation.byName, "משתמש העסק")} · ${escapeHtml(i.confirmation.atText)}</p>
  </div>

  <h2>תמונות הקליטה (טביעות)</h2>
  ${photos}

  <div class="evidence">
    <p>פרטי אימות — הנתונים להלן קושרים את המסמך לרשומת הקליטה ביומן התיק.</p>
    <p>טביעת נתוני הקליטה: <span dir="ltr">${hash(i.evidence.intakeSha256)}</span></p>
  </div>
</div>
</body>
</html>`;
}
