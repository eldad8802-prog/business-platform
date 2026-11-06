/**
 * ר2 — letter contracts + HTML (pure: no DB, no network, no clock).
 * Run: npx tsx lib/services/business-documents/letter/letter-core.test.ts
 */
import { buildLetterHtml, bodyToHtml, escapeHtml, safeImageDataUrl, type LetterIssuer } from "./letter-html";
import { formatLetterDate, LetterValidationError, letterFileName, parseLetterInput, type LetterInputRaw } from "./letter.contracts";
import { missingFields, restoreDraft, toRequestBody, emptyLetter } from "../../../../features/business-documents/letter-model";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
function problemsOf(raw: LetterInputRaw): string[] {
  try {
    parseLetterInput(raw);
    return [];
  } catch (e) {
    return e instanceof LetterValidationError ? e.problems.map((p) => p.field) : ["<other>"];
  }
}

const base: LetterInputRaw = { recipientKind: "free", recipientName: "חברת בדיקה", subject: "הודעה", body: "שלום רב,\nתודה.", date: "2026-11-05" };

// ---- contracts ----
const parsed = parseLetterInput(base);
ok("valid free letter parses", parsed.subject === "הודעה" && parsed.recipientKind === "free" && parsed.customerId === null);
ok("single-line fields collapse whitespace", parseLetterInput({ ...base, subject: "  שתי   מילים \n" }).subject === "שתי מילים");
ok("body keeps line breaks, trims, normalizes CRLF", parseLetterInput({ ...base, body: "  א\r\nב  " }).body === "א\nב");
ok("subject is required", problemsOf({ ...base, subject: " " }).includes("subject"));
ok("body is required", problemsOf({ ...base, body: "" }).includes("body"));
ok("free recipient needs a name", problemsOf({ ...base, recipientName: "" }).includes("recipientName"));
ok("customer recipient needs a customer id", problemsOf({ ...base, recipientKind: "customer", recipientName: "" }).includes("customerId"));
ok("customer recipient with id parses; name optional", parseLetterInput({ ...base, recipientKind: "customer", customerId: 12, recipientName: "" }).customerId === 12);
ok("supplier id from a numeric string", parseLetterInput({ ...base, recipientKind: "supplier", supplierId: "7" }).supplierId === 7);
ok("ids of the other kind are dropped", parseLetterInput({ ...base, recipientKind: "free", customerId: 3 }).customerId === null);
ok("negative / garbage id refused", problemsOf({ ...base, recipientKind: "customer", customerId: -1 }).includes("customerId") && problemsOf({ ...base, recipientKind: "customer", customerId: "1 OR 1=1" }).includes("customerId"));
ok("unknown recipient kind refused", problemsOf({ ...base, recipientKind: "admin" }).includes("recipientKind"));
ok("impossible date refused", problemsOf({ ...base, date: "2026-02-30" }).includes("date") && problemsOf({ ...base, date: "05/11/2026" }).includes("date"));
ok("subject over 200 chars refused", problemsOf({ ...base, subject: "א".repeat(201) }).includes("subject"));
ok("body over 10,000 chars refused", problemsOf({ ...base, body: "א".repeat(10_001) }).includes("body"));
ok("control characters refused", problemsOf({ ...base, subject: "a\u0007b" }).includes("subject"));
ok("non-string field refused", problemsOf({ ...base, subject: 42 as unknown as string }).includes("subject"));
ok("includeSignatureImage must be boolean", problemsOf({ ...base, includeSignatureImage: "yes" }).includes("includeSignatureImage"));
ok("date formatted dd.mm.yyyy", formatLetterDate("2026-11-05") === "05.11.2026");
ok("file name never uses free text", letterFileName(parsed) === "letter-2026-11-05.pdf");

// ---- HTML ----
const issuer: LetterIssuer = {
  displayName: "עסק <ב\"ע>",
  businessKindLabel: "ח.פ.",
  taxId: "999999998",
  address: "רחוב 1",
  phone: "03-0000000",
  email: "a@example.test",
  logoDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=",
};
const evil = parseLetterInput({ ...base, subject: "<script>alert(1)</script>", body: "<img src=x onerror=alert(1)>\n\nפסקה שנייה" });
const html = buildLetterHtml({ input: evil, issuer, recipient: { name: "לקוח & בנו", address: "שורה 1\nשורה 2" }, fontDataUri: "data:font/ttf;base64,AA==" });
ok("RTL Hebrew document", html.includes('<html lang="he" dir="rtl">'));
ok("no raw script from the subject", !html.includes("<script>") && html.includes("&lt;script&gt;"));
ok("no raw HTML from the body", !html.includes("<img src=x") && html.includes("&lt;img src=x onerror=alert(1)&gt;"));
ok("issuer name escaped", html.includes("עסק &lt;ב&quot;ע&gt;"));
ok("recipient escaped, address lines kept", html.includes("לקוח &amp; בנו") && html.includes("שורה 1<br>שורה 2"));
ok("blank line starts a new paragraph", (html.match(/<p>/g) ?? []).length >= 2);
ok("logo printed from a valid data URL", html.includes('class="logo" src="data:image/png;base64'));
ok("signature image only when asked", !html.includes('class="sig-img"') && buildLetterHtml({ input: { ...evil, includeSignatureImage: true }, issuer, recipient: { name: "x", address: "" }, fontDataUri: "" }).includes('class="sig-img"'));
ok("non-image / remote URL refused as image", safeImageDataUrl("https://evil.example/x.png") === null && safeImageDataUrl("data:text/html;base64,PHNjcmlwdD4=") === null);
ok("no external URL anywhere in the document", !/https?:\/\//.test(html));
ok("deterministic: same input → same bytes", html === buildLetterHtml({ input: evil, issuer, recipient: { name: "לקוח & בנו", address: "שורה 1\nשורה 2" }, fontDataUri: "data:font/ttf;base64,AA==" }));
ok("escapeHtml covers quotes", escapeHtml(`"'`) === "&quot;&#39;");
ok("bodyToHtml drops empty paragraphs", bodyToHtml("\n\n\nא\n\n\n") === "<p>א</p>");

// ---- browser form model ----
const today = "2026-11-05";
ok("empty letter dated today", emptyLetter(today).date === today);
ok("malformed draft falls back to empty", restoreDraft("{not json", today).subject === "" && restoreDraft(null, today).date === today);
ok("draft restores known fields only", restoreDraft(JSON.stringify({ subject: "x", evil: "y", recipientKind: "hack" }), today).subject === "x" && restoreDraft(JSON.stringify({ recipientKind: "hack" }), today).recipientKind === "free");
const body = toRequestBody({ ...emptyLetter(today), recipientKind: "customer", customerId: "12", supplierId: "9" });
ok("request carries only the chosen recipient's id", body.customerId === 12 && body.supplierId === null);
ok("missing fields listed before a request", missingFields(emptyLetter(today)).join(",") === "recipientName,subject,body");

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  process.exit(1);
}
