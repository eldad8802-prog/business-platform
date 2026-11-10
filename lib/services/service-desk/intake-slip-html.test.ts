/**
 * Run: npx tsx lib/services/service-desk/intake-slip-html.test.ts
 *
 * 1.3b-B — the intake slip HTML (pure): Hebrew RTL, every text escaped, nothing fetched (no script, no external URL,
 * a strict CSP), the signature only as a PNG data URL, and the evidence (text versions + hashes, signature hash,
 * intake digest, photo hashes) on the page.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildIntakeSlipHtml, escapeHtml, type IntakeSlipInput } from "./intake-slip-html";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`OK: ${name}`); } else { failures.push(name); console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };

const H = (c: string) => c.repeat(64);
const base = (o: Partial<IntakeSlipInput> = {}): IntakeSlipInput => ({
  business: { name: "מעבדת הסלולר של דנה" },
  caseNumber: 1042,
  customerName: "ישראל ישראלי",
  item: { category: "טלפון", brand: "Samsung", model: "A54", serialNumber: "R58N12345", problemDescription: "המסך לא נדלק" },
  intake: { conditionNote: "שריטה בפינה", accessoriesNote: "מטען וכיסוי" },
  photos: [{ sha256: H("a") }, { sha256: H("b") }],
  terms: { version: 3, sha256: H("c"), body: "סעיף ראשון.\n\nסעיף שני\nשורה נוספת." },
  statutory: { version: 1, sha256: H("d"), body: "זכויותיך לפי חוק הגנת הצרכן." },
  signature: { pngDataUrl: "data:image/png;base64,iVBORw0KGgo=", sha256: H("e"), signedAtText: "11.11.2026, 10:15" },
  evidence: { intakeSha256: H("f") },
  fontDataUri: "data:font/ttf;base64,AAEAAA==",
  ...o,
});

const html = buildIntakeSlipHtml(base());
ok("H1 a Hebrew RTL document (lang he, dir rtl) with the case number and the business name", /<html lang="he" dir="rtl">/.test(html) && html.includes("תיק מספר 1042") && html.includes("מעבדת הסלולר של דנה"));
ok("H2 the evidence is on the page: both text versions + hashes, the signature hash, the intake digest, every photo hash",
  html.includes("תנאי השירות (גרסה 3)") && html.includes("(גרסה 1)") && [H("a"), H("b"), H("c"), H("d"), H("e"), H("f")].every((h) => html.includes(h)));
ok("H3 the terms keep their paragraphs and line breaks", html.includes("<p>סעיף ראשון.</p>") && html.includes("<p>סעיף שני<br>שורה נוספת.</p>"));
const evil = buildIntakeSlipHtml(base({
  customerName: "<script>alert(1)</script>", business: { name: "\"><img src=x onerror=alert(1)>" },
  intake: { conditionNote: "<b>x</b>", accessoriesNote: null }, terms: { version: 3, sha256: H("c"), body: "<iframe src=https://evil.example>" },
}));
ok("H4 every text is escaped: no script / img / iframe / handler from the data reaches the markup",
  !/<script|<iframe|<img src=x/i.test(evil) && evil.includes("&lt;script&gt;") && evil.includes("&lt;iframe") && evil.includes("&quot;&gt;&lt;img src=x onerror"));
ok("H5 nothing is fetched: a strict CSP, no http(s) URL, no <script>, the only image is the signature data URL",
  html.includes("default-src 'none'") && !/https?:\/\//.test(html) && !/<script/i.test(html) && (html.match(/<img /g) ?? []).length === 1);
ok("H6 a signature that is not a PNG data URL, or a font that is not a TTF data URL, is refused",
  throws(() => buildIntakeSlipHtml(base({ signature: { pngDataUrl: "https://evil.example/s.png", sha256: H("e"), signedAtText: "x" } })))
    && throws(() => buildIntakeSlipHtml(base({ signature: { pngDataUrl: "data:image/svg+xml;base64,PHN2Zz4=", sha256: H("e"), signedAtText: "x" } })))
    && throws(() => buildIntakeSlipHtml(base({ fontDataUri: "https://fonts.example/x.ttf" }))));
const noPhotos = buildIntakeSlipHtml(base({ photos: [], evidence: { intakeSha256: null }, customerName: null }));
ok("H7 no photos, no digest, no customer → explicit placeholders, never 'undefined' / 'null'",
  noPhotos.includes("לא צולמו תמונות בקליטה.") && !/undefined|>null</.test(noPhotos));
ok("H8 a hash that is not 64 hex is never printed as one", !buildIntakeSlipHtml(base({ photos: [{ sha256: "<x>" }] })).includes("<x>"));
ok("H9 escapeHtml covers & < > \" '", escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;");
const src = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/intake-slip-html.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
ok("H10 the builder is pure (no prisma, storage, fetch, fs, clock)", !/from "@prisma|@\/lib\/storage|node:fs|fetch\(|new Date|Date\.now/.test(src));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
