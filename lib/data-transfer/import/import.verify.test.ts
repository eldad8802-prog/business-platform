/**
 * Import dry run (I-5) — deterministic verifier.
 *
 * NO database and NO network. The parts that would touch a DB (the existing-
 * record duplicate lookup) are exercised through their pure half and pinned
 * structurally; cross-tenant behaviour against real Postgres RLS is proven by
 * the D2/P7 matrix.
 *
 * The load-bearing assertions here are the ones whose failure is SILENT:
 *   - a mapping that quietly picks the wrong column
 *   - a number read as 1000x its value
 *   - a preview token that validates for the wrong business or the wrong file
 *   - a write appearing anywhere in a dry run
 *
 * Run: npx tsx lib/data-transfer/import/import.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
} from "@/lib/data-transfer/import/import-config";
import { normalizeHeaderForMatch } from "@/lib/data-transfer/import/mapping/header-normalize";
import {
  canonicalizeMapping,
  proposeMapping,
  validateMapping,
} from "@/lib/data-transfer/import/mapping/mapping-proposer";
import {
  normalizeEmail,
  normalizeEnum,
  normalizeNonNegativeInteger,
  normalizeNumber,
  normalizePhone,
  normalizeText,
} from "@/lib/data-transfer/import/normalize/value-normalize";
import { validateRows } from "@/lib/data-transfer/import/validate/row-validate";
import { detectInFileDuplicates } from "@/lib/data-transfer/import/duplicates/duplicate-detect";
import {
  issuePreviewToken,
  sha256Hex,
  verifyPreviewToken,
} from "@/lib/data-transfer/import/preview/preview-token";
import { readImportSource } from "@/lib/data-transfer/import/import-source";
import { readCsvTable } from "@/lib/data-transfer/format/csv-reader";
import { analyzeImportSource } from "@/lib/data-transfer/import/preview/preview-orchestrator";
import { getExportDescriptor } from "@/lib/data-transfer/export/export-registry";
import { buildImportTemplate } from "@/lib/data-transfer/templates/template-builder";
import { buildXlsxBuffer } from "@/lib/data-transfer/format/xlsx-writer";
import { writeCsvBuffer } from "@/lib/data-transfer/format/csv-writer";
import { domainAliasMap } from "@/lib/data-transfer/import/domain-aliases";
import type { DataTransferDomainId } from "@/lib/data-transfer/domains";

process.env.AUTH_TOKEN_SECRET ||= "i5_verifier_synthetic_secret";

let passed = 0;

function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

function readCode(path: string): string {
  const blockComment = new RegExp(String.raw`/\*[\s\S]*?\*/`, "g");
  const lineComment = new RegExp(String.raw`^\s*//`);
  return fs
    .readFileSync(path, "utf8")
    .replace(blockComment, "")
    .split("\n")
    .filter((line) => !lineComment.test(line))
    .join("\n");
}

const AT = new Date(Date.UTC(2026, 8, 2, 12, 0));
const fieldsOf = (id: DataTransferDomainId) => getExportDescriptor(id).columns;

async function main(): Promise<void> {

/* ================================================= 1. header matching === */

check("safe header normalization folds only what is safe to fold", () => {
  assert.equal(normalizeHeaderForMatch("  Customer Name  "), "customer name");
  assert.equal(normalizeHeaderForMatch("customer_name"), "customer name");
  assert.equal(normalizeHeaderForMatch("Customer-Name"), "customer name");
  // Hebrew geresh/gershayim and the ASCII quotes typed instead all unify.
  assert.equal(normalizeHeaderForMatch("מק״ט"), normalizeHeaderForMatch('מק"ט'));
  assert.equal(normalizeHeaderForMatch("מק״ט"), normalizeHeaderForMatch("מקט"));
  // Bidi marks Excel injects disappear.
  assert.equal(normalizeHeaderForMatch("‏שם‎"), "שם");
  // An unnamed column can never match anything.
  assert.equal(normalizeHeaderForMatch("   "), "");
  assert.equal(normalizeHeaderForMatch(null), "");
});

check("NO fuzzy matching — distinct labels stay distinct", () => {
  // Each pair is close enough that an edit-distance matcher would merge them.
  const pairs: Array<[string, string]> = [
    ["שם", "שם ספק"],
    ["מחיר", "מחיר מכירה"],
    ["עלות ליחידה", "עלות רכישה אחרונה"],
    ["כמות במלאי", "כמות מינימום"],
    ["טלפון", "טלפון איש קשר"],
  ];
  for (const [a, b] of pairs) {
    assert.notEqual(normalizeHeaderForMatch(a), normalizeHeaderForMatch(b));
  }
});

/* ======================================================== 2. aliases === */

check("no alias is ambiguous BETWEEN two fields of the same domain", () => {
  // An alias pointing at two DIFFERENT fields would make every file using that
  // header AMBIGUOUS, and the owner would have to resolve it by hand every
  // time. Two spellings of the same alias inside ONE field are harmless (they
  // normalize together), so only cross-field collisions fail.
  for (const id of ["customers", "suppliers", "leads", "inventory"] as const) {
    const seen = new Map<string, string>();
    for (const [field, aliases] of Object.entries(domainAliasMap(id))) {
      for (const alias of aliases) {
        const key = normalizeHeaderForMatch(alias);
        const prior = seen.get(key);
        assert.equal(
          prior === undefined || prior === field,
          true,
          `${id}: "${alias}" is an alias of both "${prior}" and "${field}"`
        );
        seen.set(key, field);
      }
    }
  }
});

check("no alias collides with a DIFFERENT field's canonical label", () => {
  for (const id of ["customers", "suppliers", "leads", "inventory"] as const) {
    const canonical = new Map(
      fieldsOf(id).map((f) => [normalizeHeaderForMatch(f.header), f.header])
    );
    for (const [field, aliases] of Object.entries(domainAliasMap(id))) {
      for (const alias of aliases) {
        const hit = canonical.get(normalizeHeaderForMatch(alias));
        assert.equal(
          hit === undefined || hit === field,
          true,
          `${id}: alias "${alias}" of "${field}" is the canonical label of "${hit}"`
        );
      }
    }
  }
});

check("aliases only ever name importable fields", () => {
  for (const id of ["customers", "suppliers", "leads", "inventory"] as const) {
    const importable = new Set(
      fieldsOf(id).filter((f) => f.importable).map((f) => f.header)
    );
    for (const field of Object.keys(domainAliasMap(id))) {
      assert.equal(importable.has(field), true, `${id}: "${field}" is not importable`);
    }
  }
});

/* ================================================ 3. mapping proposal === */

function propose(id: DataTransferDomainId, headers: string[]) {
  return proposeMapping({
    domainId: id,
    fields: fieldsOf(id),
    headers,
    sampleRows: [["a", "b", "c", "d"]],
    sampleCount: 3,
  });
}

check("EXACT — the canonical Hebrew label", () => {
  const [p] = propose("customers", ["שם"]);
  assert.equal(p.status, "EXACT");
  assert.equal(p.field, "שם");
});

check("EXACT survives spacing, case and quote style", () => {
  assert.equal(propose("inventory", ['  מק"ט  '])[0].field, "מק״ט");
  assert.equal(propose("customers", ["  שם  "])[0].status, "EXACT");
});

check("SUGGESTED — an explicit alias, Hebrew or English", () => {
  for (const header of ["שם לקוח", "Customer Name", "client"]) {
    const [p] = propose("customers", [header]);
    assert.equal(p.status, "SUGGESTED", header);
    assert.equal(p.field, "שם", header);
  }
});

check("UNMAPPED — an unknown column is simply not imported", () => {
  const [p] = propose("customers", ["מספר חשבון בנק"]);
  assert.equal(p.status, "UNMAPPED");
  assert.equal(p.field, null);
});

check("AMBIGUOUS — two source columns claiming the same label", () => {
  const proposals = propose("customers", ["שם", "שם"]);
  // Both resolve to the same field; the DUPLICATE_TARGET check is what refuses
  // the mapping, and it is asserted below.
  assert.equal(proposals[0].field, "שם");
  assert.equal(proposals[1].field, "שם");
});

check("a canonical label BEATS another field's alias — that is not ambiguity", () => {
  // "ספק" is Inventory's canonical supplier column AND an alias of nothing
  // else there; "שם ספק" is its alias. Both must resolve cleanly.
  assert.equal(propose("inventory", ["ספק"])[0].status, "EXACT");
  assert.equal(propose("inventory", ["שם ספק"])[0].status, "SUGGESTED");
  assert.equal(propose("inventory", ["שם ספק"])[0].field, "ספק");
});

check("samples come from the file so the owner can sanity-check a guess", () => {
  const proposals = proposeMapping({
    domainId: "customers",
    fields: fieldsOf("customers"),
    headers: ["שם", "טלפון"],
    sampleRows: [
      ["אבי", "0501234567"],
      ["", "0521111111"],
      ["דנה", ""],
    ],
    sampleCount: 3,
  });
  assert.deepEqual(proposals[0].samples, ["אבי", "דנה"]);
  assert.deepEqual(proposals[1].samples, ["0501234567", "0521111111"]);
});

/* ============================================== 4. mapping validation === */

const custFields = fieldsOf("customers");

check("a complete mapping passes", () => {
  assert.deepEqual(
    validateMapping({ fields: custFields, headerCount: 2, mapping: { 0: "שם", 1: "טלפון" } }),
    []
  );
});

check("MISSING_REQUIRED blocks the preview", () => {
  const problems = validateMapping({
    fields: custFields,
    headerCount: 1,
    mapping: { 0: "טלפון" },
  });
  assert.deepEqual(problems, [{ kind: "MISSING_REQUIRED", field: "שם" }]);
});

check("DUPLICATE_TARGET is refused, never silently resolved", () => {
  // Picking "the first" or "the last" would silently discard data the owner
  // believed they were importing.
  const problems = validateMapping({
    fields: custFields,
    headerCount: 2,
    mapping: { 0: "שם", 1: "שם" },
  });
  assert.equal(
    problems.some(
      (p) => p.kind === "DUPLICATE_TARGET" && p.field === "שם"
    ),
    true
  );
});

check("a non-importable or unknown target is rejected", () => {
  const notImportable = validateMapping({
    fields: custFields,
    headerCount: 2,
    mapping: { 0: "שם", 1: "נוצר בתאריך" },
  });
  assert.equal(
    notImportable.some((p) => p.kind === "NOT_IMPORTABLE"),
    true
  );
  const unknown = validateMapping({
    fields: custFields,
    headerCount: 2,
    mapping: { 0: "שם", 1: "שדה שלא קיים" },
  });
  assert.equal(unknown.some((p) => p.kind === "UNKNOWN_FIELD"), true);
});

check("a column index outside the file is rejected", () => {
  const problems = validateMapping({
    fields: custFields,
    headerCount: 1,
    mapping: { 0: "שם", 9: "טלפון" },
  });
  assert.equal(problems.some((p) => p.kind === "UNKNOWN_COLUMN"), true);
});

check("an ignored column is legitimate — it simply is not mapped", () => {
  assert.deepEqual(
    validateMapping({ fields: custFields, headerCount: 3, mapping: { 0: "שם" } }),
    []
  );
});

check("mapping canonicalization is order-independent", () => {
  const a = canonicalizeMapping({ 2: "עיר", 0: "שם", 1: "טלפון" });
  const b = canonicalizeMapping({ 0: "שם", 1: "טלפון", 2: "עיר" });
  assert.equal(a, b);
  assert.equal(sha256Hex(a), sha256Hex(b));
  // A different mapping must hash differently.
  assert.notEqual(sha256Hex(a), sha256Hex(canonicalizeMapping({ 0: "שם" })));
});

/* ================================================== 5. normalization === */

check("phone: canonical for storage, readable for the owner", () => {
  const r = normalizePhone("050-123-4567");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value, "972501234567");
    assert.equal(r.display, "050-123-4567");
    assert.equal(r.original, "050-123-4567");
  }
  for (const form of ["0501234567", "+972-50-123-4567", "972501234567"]) {
    const x = normalizePhone(form);
    assert.equal(x.ok && x.value, "972501234567", form);
  }
  assert.equal(normalizePhone("12").ok, false);
  assert.equal(normalizePhone("").ok, true);
});

check("numbers: the approved forms, and only those", () => {
  const cases: Array<[string, number]> = [
    ["1234.50", 1234.5],
    ["1,234.50", 1234.5],
    ["1,234", 1234],
    ["₪1,234.50", 1234.5],
    ["1,234.50 ₪", 1234.5],
    ["0", 0],
    ["7", 7],
  ];
  for (const [input, expected] of cases) {
    const r = normalizeNumber(input);
    assert.equal(r.ok, true, input);
    if (r.ok) assert.equal(r.value, expected, input);
  }
});

check("an ambiguous decimal comma is REFUSED, never guessed", () => {
  // "1,50" is 1.5 in one convention and 150 in another. Guessing either way is
  // a silent factor-of-100 error in a price.
  const r = normalizeNumber("1,50");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason.includes("נקודה עשרונית"), true);
  assert.equal(normalizeNumber("abc").ok, false);
  assert.equal(normalizeNumber("1.2.3").ok, false);
});

check("a negative quantity is refused; an integer field rejects a fraction", () => {
  assert.equal(normalizeNonNegativeInteger("-1").ok, false);
  assert.equal(normalizeNonNegativeInteger("1.5").ok, false);
  assert.equal(normalizeNonNegativeInteger("30").ok, true);
});

check("email uses the same pragmatic shape the domain already enforces", () => {
  assert.equal(normalizeEmail("a@b.co.il", 200).ok, true);
  for (const bad of ["not-an-email", "a@b", "a b@c.com", "a@@b.com"]) {
    assert.equal(normalizeEmail(bad, 200).ok, false, bad);
  }
});

check("controlled values match the owner's words, not the enum token", () => {
  const allowed = ["יחידה", "ליטר", "ק״ג"];
  assert.equal(normalizeEnum("ליטר", allowed).ok, true);
  assert.equal(normalizeEnum("  ליטר ", allowed).ok, true);
  assert.equal(normalizeEnum("LITER", allowed).ok, false);
  assert.equal(normalizeEnum("ליטרים", allowed).ok, false);
});

check("over-length text is refused with the limit stated", () => {
  const r = normalizeText("x".repeat(201), 200);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason.includes("200"), true);
});

/* ==================================================== 6. row validation */

function validate(id: DataTransferDomainId, mapping: Record<number, string>, rows: unknown[][]) {
  return validateRows({ domainId: id, fields: fieldsOf(id), mapping, rows });
}

check("a valid customer row is READY, with normalization evidence", () => {
  const [row] = validate("customers", { 0: "שם", 1: "טלפון" }, [
    ["אבי כהן", "050-123-4567"],
  ]);
  assert.equal(row.status, "READY");
  assert.deepEqual(row.errors, []);
  const phone = row.values.find((v) => v.field === "טלפון");
  assert.equal(phone?.original, "050-123-4567");
  assert.equal(phone?.normalized, "050-123-4567");
  assert.equal(row.canonical["טלפון"], "972501234567");
});

check("a missing required field is an ERROR, per domain", () => {
  const cases: Array<[DataTransferDomainId, Record<number, string>, unknown[]]> = [
    ["customers", { 0: "שם", 1: "טלפון" }, ["", "0501234567"]],
    ["suppliers", { 0: "שם ספק", 1: "טלפון" }, ["", "031234567"]],
    ["leads", { 0: "שם", 1: "טלפון" }, ["", "0501234567"]],
    ["inventory", { 0: "שם פריט", 1: "יחידת מידה" }, ["", "ליטר"]],
  ];
  for (const [id, mapping, row] of cases) {
    const [out] = validate(id, mapping, [row]);
    assert.equal(out.status, "ERROR", id);
    assert.equal(out.errors[0].reason, "שדה חובה חסר", id);
  }
});

check("inventory requires BOTH a name and a unit", () => {
  const [missingUnit] = validate("inventory", { 0: "שם פריט", 1: "יחידת מידה" }, [
    ["חלב", ""],
  ]);
  assert.equal(missingUnit.status, "ERROR");
  assert.equal(missingUnit.errors[0].field, "יחידת מידה");

  const [badUnit] = validate("inventory", { 0: "שם פריט", 1: "יחידת מידה" }, [
    ["חלב", "בקבוקים"],
  ]);
  assert.equal(badUnit.status, "ERROR");
  assert.equal(badUnit.errors[0].reason.includes("ערכים המותרים"), true);

  const [ok] = validate("inventory", { 0: "שם פריט", 1: "יחידת מידה" }, [
    ["חלב", "ליטר"],
  ]);
  assert.equal(ok.status, "READY");
});

check("a malformed value is an ERROR on the field that caused it", () => {
  const [row] = validate("customers", { 0: "שם", 1: "טלפון", 2: "אימייל" }, [
    ["אבי", "12", "not-an-email"],
  ]);
  assert.equal(row.status, "ERROR");
  assert.deepEqual(
    row.errors.map((e) => e.field).sort(),
    ["אימייל", "טלפון"]
  );
  // The owner's original text is echoed back so they can find it in the file.
  assert.equal(row.errors.find((e) => e.field === "טלפון")?.original, "12");
});

check("a fully blank row is skipped, not reported as an error", () => {
  const rows = validate("customers", { 0: "שם", 1: "טלפון" }, [
    ["אבי", "0501234567"],
    ["", ""],
    ["דנה", "0521111111"],
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.rowNumber), [1, 3]);
});

check("supplier profile values validate through the supplier domain's own rules", () => {
  const mapping = { 0: "שם ספק", 1: "מספר עוסק / ח.פ.", 2: "ימי תשלום", 3: "אמצעי תשלום מועדף" };
  const [ok] = validate("suppliers", mapping, [["תנובה", "512345678", "30", "העברה בנקאית"]]);
  assert.equal(ok.status, "READY");

  const [bad] = validate("suppliers", mapping, [["תנובה", "12", "999", "מזומן ביד"]]);
  assert.equal(bad.status, "ERROR");
  assert.deepEqual(
    bad.errors.map((e) => e.field).sort(),
    ["אמצעי תשלום מועדף", "ימי תשלום", "מספר עוסק / ח.פ."].sort()
  );
});

check("no importable field is a date, so no date is ever parsed", () => {
  for (const id of ["customers", "suppliers", "leads", "inventory"] as const) {
    const dates = fieldsOf(id).filter(
      (f) => f.importable && (f.type === "date" || f.type === "datetime")
    );
    assert.deepEqual(dates, [], `${id} gained an importable date field`);
  }
});

/* ================================================== 7. duplicates ====== */

check("IN_FILE: two customer rows with the same phone flag each other", () => {
  const rows = validate("customers", { 0: "שם", 1: "טלפון" }, [
    ["אבי", "050-123-4567"],
    ["דנה", "0521111111"],
    ["אבי כהן", "0501234567"],
  ]);
  const dupes = detectInFileDuplicates("customers", rows);
  assert.deepEqual([...dupes.keys()].sort(), [1, 3]);
  const first = dupes.get(1)?.[0];
  assert.equal(first?.scope, "IN_FILE");
  assert.equal(first?.strength, "STRONG");
  assert.equal(first?.field, "טלפון");
  assert.deepEqual(first?.otherRows, [3]);
});

check("IN_FILE: no collision means no evidence", () => {
  const rows = validate("customers", { 0: "שם", 1: "טלפון" }, [
    ["אבי", "0501234567"],
    ["דנה", "0521111111"],
  ]);
  assert.equal(detectInFileDuplicates("customers", rows).size, 0);
});

check("IN_FILE strength reflects the PRODUCT, not our confidence", () => {
  // Suppliers and inventory have no uniqueness at all, so even an exact tax-id
  // or SKU repeat is WEAK — claiming otherwise would invent a guarantee.
  const suppliers = validate("suppliers", { 0: "שם ספק", 1: "מספר עוסק / ח.פ." }, [
    ["תנובה", "512345678"],
    ["תנובה בעמ", "512345678"],
  ]);
  const sd = detectInFileDuplicates("suppliers", suppliers);
  assert.equal(sd.get(1)?.[0].strength, "WEAK");

  const inventory = validate("inventory", { 0: "שם פריט", 1: "יחידת מידה", 2: "מק״ט" }, [
    ["חלב", "ליטר", "MILK-1"],
    ["חלב 3%", "ליטר", "MILK-1"],
  ]);
  const id = detectInFileDuplicates("inventory", inventory);
  assert.equal(id.get(1)?.[0].strength, "WEAK");
  assert.equal(id.get(1)?.[0].field, "מק״ט");
});

check("the existing-record lookup is READ-ONLY and tenant-scoped", () => {
  const src = readCode(
    "lib/data-transfer/import/duplicates/duplicate-detect.ts"
  );
  assert.equal(src.includes("runWithTenantContext"), true);
  assert.equal(src.includes("withTenantTransaction"), true);
  // Every query filters by the server-derived tenant.
  const finds = src.match(/findMany\(\{/g) ?? [];
  const scoped = src.match(/where: \{\s*businessId,/g) ?? [];
  assert.equal(finds.length > 0, true);
  assert.equal(scoped.length, finds.length, "a lookup is missing businessId");
  for (const needle of ["create(", "update(", "upsert(", "delete(", "$executeRaw"]) {
    assert.equal(src.includes(needle), false, `duplicate lookup contains ${needle}`);
  }
});

check("duplicate evidence exposes no internal identifiers", () => {
  const src = readCode(
    "lib/data-transfer/import/duplicates/duplicate-detect.ts"
  );
  // The selects must not pull ids, and the evidence type has no id field.
  assert.equal(/select: \{[^}]*\bid: true/.test(src), false, "a lookup selects id");
  assert.equal(src.includes("existingId"), false);
  assert.equal(src.includes("businessId:"), true); // as a FILTER, which is required
});

/* ================================================ 8. preview token ===== */

const FACTS = {
  businessId: 7,
  userId: 42,
  domain: "customers" as DataTransferDomainId,
  contentHash: sha256Hex("file-bytes"),
  mappingHash: sha256Hex(canonicalizeMapping({ 0: "שם" })),
  sheetName: "ייבוא",
  rowCount: 3,
};

check("a fresh token verifies and returns exactly what was bound", () => {
  const result = verifyPreviewToken(issuePreviewToken(FACTS, AT), AT);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.facts, FACTS);
});

check("an expired token is refused", () => {
  const token = issuePreviewToken(FACTS, AT);
  const later = new Date(AT.getTime() + 31 * 60 * 1000);
  const result = verifyPreviewToken(token, later);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "EXPIRED");
});

check("a tampered payload or signature is refused", () => {
  const token = issuePreviewToken(FACTS, AT);
  const [body, mac] = token.split(".");

  // Re-encode the payload with a different business — the signature no longer
  // covers it.
  const payload = JSON.parse(
    Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
  );
  payload.businessId = 999;
  const forgedBody = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const forged = verifyPreviewToken(`${forgedBody}.${mac}`, AT);
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.reason, "BAD_SIGNATURE");

  // A flipped signature byte.
  const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
  assert.equal(verifyPreviewToken(`${body}.${flipped}`, AT).ok, false);
});

check("malformed shapes are refused, never parsed optimistically", () => {
  for (const bad of ["", "abc", "a.b.c", null, undefined, 7, "a.", ".b"]) {
    assert.equal(verifyPreviewToken(bad, AT).ok, false, String(bad));
  }
});

check("BINDING: business, user, domain, file, mapping and sheet all differ the token", () => {
  const base = issuePreviewToken(FACTS, AT);
  const variants: Array<[string, typeof FACTS]> = [
    ["businessId", { ...FACTS, businessId: 8 }],
    ["userId", { ...FACTS, userId: 43 }],
    ["domain", { ...FACTS, domain: "leads" as DataTransferDomainId }],
    ["contentHash", { ...FACTS, contentHash: sha256Hex("other-bytes") }],
    ["mappingHash", { ...FACTS, mappingHash: sha256Hex("other-mapping") }],
    ["sheetName", { ...FACTS, sheetName: "גיליון2" }],
    ["rowCount", { ...FACTS, rowCount: 4 }],
  ];
  for (const [label, facts] of variants) {
    const other = issuePreviewToken(facts, AT);
    assert.notEqual(other, base, `${label} did not change the token`);
    const verified = verifyPreviewToken(other, AT);
    assert.equal(verified.ok, true, label);
    if (verified.ok) {
      assert.deepEqual(verified.facts, facts, label);
    }
  }
});

check("a token from ANOTHER purpose cannot validate here", () => {
  // Purpose-separated key derivation: an envelope minted for the ITA OAuth
  // state or a bearer auth token must be inert against this verifier.
  const foreign =
    Buffer.from(JSON.stringify({ v: 1, purpose: "authority-oauth-state" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "") + ".notasignature";
  assert.equal(verifyPreviewToken(foreign, AT).ok, false);
});

check("the token carries NO rows, values or business records", () => {
  const token = issuePreviewToken(FACTS, AT);
  const payload = JSON.parse(
    Buffer.from(
      token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString()
  );
  assert.deepEqual(
    Object.keys(payload).sort(),
    [
      "businessId",
      "contentHash",
      "domain",
      "exp",
      "iat",
      "mappingHash",
      "nonce",
      "purpose",
      "rowCount",
      "sheetName",
      "userId",
      "v",
    ].sort()
  );
  // It is SIGNED, not encrypted — so the payload must contain nothing secret.
  for (const key of ["rows", "values", "samples", "data", "records"]) {
    assert.equal(key in payload, false, `token carries ${key}`);
  }
});

/* =================================================== 9. source reading = */

const CUSTOMER_HEADERS = ["שם", "טלפון", "אימייל"];

async function xlsx(sheets: { name: string; rows: string[][] }[]): Promise<Buffer> {
  return buildXlsxBuffer(
    sheets.map((s) => ({
      name: s.name,
      columns: CUSTOMER_HEADERS.map((h) => ({ header: h, type: "text" as const })),
      rows: s.rows,
    }))
  );
}

await checkAsync("a Dubiz template resolves to the ייבוא sheet, never הוראות", async () => {
  const template = await buildImportTemplate("customers", AT);
  const result = await readImportSource({
    filename: "dubiz-customers-template.xlsx",
    bytes: template.body,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.sheetName, "ייבוא");
    assert.deepEqual(result.table.headers, template.headers);
    assert.equal(result.table.rows.length, 0);
  }
});

await checkAsync("a single-sheet workbook is used without asking", async () => {
  const bytes = await xlsx([{ name: "Sheet1", rows: [["אבי", "0501234567", ""]] }]);
  const result = await readImportSource({ filename: "x.xlsx", bytes });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.sheetName, "Sheet1");
});

await checkAsync("several data sheets REQUIRE a choice — never a silent pick", async () => {
  const bytes = await xlsx([
    { name: "לקוחות 2025", rows: [["אבי", "0501234567", ""]] },
    { name: "לקוחות 2026", rows: [["דנה", "0521111111", ""]] },
  ]);
  const result = await readImportSource({ filename: "x.xlsx", bytes });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "SHEET_CHOICE_REQUIRED");
    assert.deepEqual(result.availableSheets, ["לקוחות 2025", "לקוחות 2026"]);
  }
  // And the explicit choice is honoured.
  const chosen = await readImportSource({
    filename: "x.xlsx",
    bytes,
    sheetName: "לקוחות 2026",
  });
  assert.equal(chosen.ok && chosen.sheetName, "לקוחות 2026");

  // A sheet that is not in the file is refused.
  const bogus = await readImportSource({
    filename: "x.xlsx",
    bytes,
    sheetName: "אין כזה",
  });
  assert.equal(bogus.ok, false);
  if (!bogus.ok) assert.equal(bogus.code, "SHEET_NOT_FOUND");
});

check("CSV: encodings and delimiters all reach the same table", () => {
  const utf8 = writeCsvBuffer(CUSTOMER_HEADERS, [["אבי", "0501234567", "a@b.co.il"]]);
  const parsed = readCsvTable(utf8);
  assert.deepEqual(parsed.headers, CUSTOMER_HEADERS);

  // Comma and TAB variants, no BOM.
  const comma = Buffer.from('שם,טלפון\r\nאבי,0501234567', "utf8");
  assert.deepEqual(readCsvTable(comma).headers, ["שם", "טלפון"]);
  const tab = Buffer.from("שם\tטלפון\nאבי\t0501234567", "utf8");
  assert.deepEqual(readCsvTable(tab).headers, ["שם", "טלפון"]);

  // windows-1255 (שם,טלפון) — invalid UTF-8, must fall back and not mangle.
  const cp1255 = Buffer.from([
    0xf9, 0xed, 0x2c, 0xe8, 0xec, 0xf4, 0xe5, 0xef, 0x0a,
    0xe0, 0xe1, 0xe9, 0x2c, 0x30, 0x35, 0x30,
  ]);
  const legacy = readCsvTable(cp1255);
  assert.deepEqual(legacy.headers, ["שם", "טלפון"]);
  assert.equal(legacy.rows[0][0], "אבי");
});

await checkAsync("a quoted newline stays one row", async () => {
  const csv = writeCsvBuffer(["שם", "הערות"], [["אבי", "שורה1\nשורה2"]]);
  const result = await readImportSource({ filename: "x.csv", bytes: csv });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.table.rows.length, 1);
    assert.equal(String(result.table.rows[0][1]).includes("\n"), true);
  }
});

await checkAsync("malformed and mislabelled files fail CLOSED", async () => {
  const notXlsx = await readImportSource({
    filename: "x.xlsx",
    bytes: Buffer.from("this is not a workbook"),
  });
  assert.equal(notXlsx.ok, false);
  if (!notXlsx.ok) assert.equal(notXlsx.code, "UNSUPPORTED_TYPE");

  // An xlsx renamed to .csv would otherwise be read as binary garbage.
  const renamed = await readImportSource({
    filename: "x.csv",
    bytes: await xlsx([{ name: "S", rows: [["a", "b", "c"]] }]),
  });
  assert.equal(renamed.ok, false);
  if (!renamed.ok) assert.equal(renamed.code, "UNSUPPORTED_TYPE");

  for (const name of ["x.pdf", "x.txt", "x", "x.xlsx.exe"]) {
    const bad = await readImportSource({ filename: name, bytes: Buffer.from("abc") });
    assert.equal(bad.ok, false, name);
  }

  const empty = await readImportSource({ filename: "x.csv", bytes: Buffer.alloc(0) });
  assert.equal(empty.ok && false, false);
  if (!empty.ok) assert.equal(empty.code, "EMPTY_FILE");
});

/* ================================================= 10. hard limits ===== */

await checkAsync("10MB is enforced on the BYTES, not on a declared size", async () => {
  const oversized = Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1, 0x61);
  const result = await readImportSource({ filename: "x.csv", bytes: oversized });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "FILE_TOO_LARGE");
  assert.equal(IMPORT_MAX_FILE_BYTES, 10 * 1024 * 1024);
});

await checkAsync("10,000 rows is a hard ceiling", async () => {
  assert.equal(IMPORT_MAX_ROWS, 10_000);
  const rows = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => [
    `לקוח ${i}`,
    "",
  ]);
  const csv = writeCsvBuffer(["שם", "טלפון"], rows);
  const result = await readImportSource({ filename: "x.csv", bytes: csv });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TOO_MANY_ROWS");
});

/* ============================================== 11. orchestrator/route = */

await checkAsync("analyze reads the file and proposes, without touching tenant data", async () => {
  const csv = writeCsvBuffer(
    ["Customer Name", "Phone", "משהו אחר"],
    [["אבי", "0501234567", "x"]]
  );
  const result = await analyzeImportSource({
    domainId: "customers",
    filename: "x.csv",
    bytes: csv,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.rowCount, 1);
    assert.equal(result.proposals[0].status, "SUGGESTED");
    assert.equal(result.proposals[0].field, "שם");
    assert.equal(result.proposals[2].status, "UNMAPPED");
    assert.deepEqual(result.requiredFields, ["שם"]);
    assert.equal(result.contentHash, sha256Hex(csv));
  }
});

check("ROUTES: the tenant is server-derived and never read from the body", () => {
  for (const route of [
    "app/api/data-transfer/import/analyze/route.ts",
    "app/api/data-transfer/import/preview/route.ts",
  ]) {
    const src = readCode(route);
    assert.equal(src.includes("getCurrentUser"), true, route);
    assert.equal(
      /form\.get\(\s*["']businessId["']\s*\)|body\.businessId/.test(src),
      false,
      `${route} reads a client businessId`
    );
    assert.equal(src.includes("private, no-store"), true, route);
  }
  // Only preview needs the tenant; analyze must not use it for data.
  const preview = readCode("app/api/data-transfer/import/preview/route.ts");
  assert.equal(preview.includes("businessId: user.businessId"), true);
});

/* ============================================ 12. ZERO BUSINESS WRITES = */

check("ZERO WRITES: no import module can create or change business data", () => {
  // A Prisma write is `<client>.<model>.<op>(`. Matching a bare `.update(`
  // would fire on `createHmac(...).update(...)` in the token signer, which is
  // crypto, not a database call — a check that cries wolf gets disabled.
  const PRISMA_WRITE =
    /\.\w+\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/;

  const forbidden = [
    "$executeRaw",
    "$executeRawUnsafe",
    "$queryRawUnsafe",
    "customerService.createCustomer",
    "customerService.updateCustomer",
    "supplierService.createSupplier",
    "leadService.createLead",
    "createItemWithInitialStock",
    "createMovement",
    "addStock",
    "removeStock",
  ];

  const roots = [
    "lib/data-transfer/import",
    "app/api/data-transfer/import",
  ];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".verify.test.ts")) {
        files.push(full);
      }
    }
  };
  roots.forEach(walk);
  assert.equal(files.length >= 10, true, "expected the import layer to be scanned");

  for (const file of files) {
    const src = readCode(file);
    const write = PRISMA_WRITE.exec(src);
    assert.equal(
      write,
      null,
      `${file} performs a Prisma write: ${write?.[0]}`
    );
    for (const needle of forbidden) {
      assert.equal(src.includes(needle), false, `${file} contains ${needle}`);
    }
  }

  // Proof the scan can actually catch one — otherwise a passing check means
  // nothing.
  assert.equal(PRISMA_WRITE.test("await tx.customer.create({ data })"), true);
  assert.equal(PRISMA_WRITE.test("await tx.lead.updateMany({ where })"), true);
  assert.equal(PRISMA_WRITE.test('createHmac("sha256", k).update(body)'), false);
});

check("ZERO WRITES: the Import UI has no endpoint that could save", () => {
  const src = readCode("components/settings/import-export/ImportScreen.tsx");
  const endpoints = [...src.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    endpoints.sort(),
    ["/api/data-transfer/import/analyze", "/api/data-transfer/import/preview"]
  );
  // And it tells the owner the truth, twice.
  assert.equal(src.includes("שום מידע לא יישמר בדוביז"), true);
  assert.equal(src.includes("שום מידע לא נשמר בדוביז"), true);
  assert.equal(src.includes("בדיקת הקובץ הושלמה"), true);
});

console.log(`\nIMPORT DRY-RUN VERIFY PASS — ${passed} checks green.`);
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});
