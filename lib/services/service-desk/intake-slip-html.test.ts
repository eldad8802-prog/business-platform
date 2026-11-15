/**
 * Run: npx tsx lib/services/service-desk/intake-slip-html.test.ts
 *
 * The intake slip HTML (pure): Hebrew RTL, every text escaped, nothing fetched (no image, no script, no external URL, a
 * strict CSP), and — owner decision 2026-11-11 — no customer signature and no legal-terms text: the slip names the user
 * who confirmed the intake and when, with the evidence (intake digest, photo hashes).
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
  confirmation: { byName: "דנה כהן", atText: "11.11.2026, 10:15" },
  evidence: { intakeSha256: H("f") },
  fontDataUri: "data:font/ttf;base64,AAEAAA==",
  ...o,
});

const html = buildIntakeSlipHtml(base());
ok("H1 a Hebrew RTL document (lang he, dir rtl) with the case number and the business name", /<html lang="he" dir="rtl">/.test(html) && html.includes("תיק מספר 1042") && html.includes("מעבדת הסלולר של דנה"));
ok("H2 the confirmation names the user and the time; the evidence carries the intake digest and every photo hash",
  html.includes("הקליטה אושרה") && html.includes("דנה כהן") && html.includes("11.11.2026, 10:15") && [H("a"), H("b"), H("f")].every((h) => html.includes(h)));
ok("H3 owner decision: no signature, no legal terms, no image on the slip", !/חתימ|תנאי השירות|הודעה לפי דין|<img/.test(html));
const evil = buildIntakeSlipHtml(base({
  customerName: "<script>alert(1)</script>", business: { name: "\"><img src=x onerror=alert(1)>" },
  intake: { conditionNote: "<b>x</b>", accessoriesNote: null }, confirmation: { byName: "<iframe src=https://evil.example>", atText: "<i>now</i>" },
}));
ok("H4 every text is escaped: no script / img / iframe from the data reaches the markup",
  !/<script|<iframe|<img src=x|<i>now/i.test(evil) && evil.includes("&lt;script&gt;") && evil.includes("&lt;iframe") && evil.includes("&quot;&gt;&lt;img src=x onerror"));
ok("H5 nothing is fetched: a strict CSP, no http(s) URL, no <script>, no image", html.includes("default-src 'none'") && !/https?:\/\//.test(html) && !/<script/i.test(html) && !/<img /.test(html));
ok("H6 a font that is not a TTF data URL is refused", throws(() => buildIntakeSlipHtml(base({ fontDataUri: "https://fonts.example/x.ttf" }))));
const none = buildIntakeSlipHtml(base({ photos: [], customerName: null, intake: { conditionNote: "תקין", accessoriesNote: null }, confirmation: { byName: null, atText: "x" } }));
ok("H7 no photos / no accessories / no customer / no name → explicit placeholders (\"לא נמסרו אביזרים\"), never 'undefined' / 'null'",
  none.includes("לא צולמו תמונות בקליטה.") && none.includes("לא נמסרו אביזרים") && none.includes("משתמש העסק") && !/undefined|>null</.test(none));
ok("H8 a hash that is not 64 hex is never printed as one", !buildIntakeSlipHtml(base({ photos: [{ sha256: "<x>" }] })).includes("<x>"));
ok("H9 escapeHtml covers & < > \" '", escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;");
const src = fs.readFileSync(path.join(process.cwd(), "lib/services/service-desk/intake-slip-html.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
ok("H10 the builder is pure (no prisma, storage, fetch, fs, clock)", !/from "@prisma|@\/lib\/storage|node:fs|fetch\(|new Date|Date\.now/.test(src));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
