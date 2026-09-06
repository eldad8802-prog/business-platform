/**
 * I-7B — Documents batch analyze / preview verifier.
 *
 * NO database and NO network. The one DB touch in this layer is a tenant-scoped
 * read of existing content hashes, exercised through its pure half and pinned
 * structurally; cross-tenant behaviour against real Postgres is proven by the
 * D2/P7 matrix.
 *
 * The assertions that matter most are the ones whose failure would be SILENT:
 * a preview that writes something, a decision the server would not have offered
 * being accepted anyway, a renamed file passing as a PDF, or two identical files
 * both defaulting to import.
 *
 * Run: npx tsx lib/data-transfer/documents/documents-analyze.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

import {
  DOCUMENTS_IMPORT_MAX_BATCH_BYTES,
  DOCUMENTS_IMPORT_MAX_FILES,
  DOCUMENTS_NO_MAPPING_SENTINEL,
  documentsBatchContentHash,
  documentsMappingHash,
} from "@/lib/data-transfer/documents/documents-import-config";
import {
  detectFileSignature,
  verifyFileSignature,
} from "@/lib/data-transfer/documents/file-signature";
import {
  defaultDocumentDecisions,
  documentDecisionsHash,
  isDecisionPermitted,
  classifyStagedFiles,
  type AnalyzedFile,
  type StagedFile,
} from "@/lib/data-transfer/documents/batch-analyze";
import { DOCUMENT_MAX_UPLOAD_BYTES } from "@/lib/services/documents/document-ingestion.service";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const pdf = (extra = "rest") => Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.from(extra)]);
const jpeg = (extra = "rest") => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(extra)]);
const png = (extra = "rest") =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(extra)]);

function file(over: Partial<AnalyzedFile> & { index: number }): AnalyzedFile {
  return {
    filename: "x.pdf",
    sizeBytes: 100,
    mimeType: "application/pdf",
    status: "NEW",
    action: "CREATE",
    reason: "",
    overridable: false,
    ...over,
  };
}

/* ================================================ 1. limits ============ */

console.log("\n1. Batch limits");

check("the per-file rule is the SHARED one, not a second copy", () => {
  assert.equal(DOCUMENT_MAX_UPLOAD_BYTES, 15 * 1024 * 1024);
});

check("the batch limits are the locked v1 contract", () => {
  assert.equal(DOCUMENTS_IMPORT_MAX_FILES, 20);
  assert.equal(DOCUMENTS_IMPORT_MAX_BATCH_BYTES, 60 * 1024 * 1024);
});

check("the byte ceiling, not the file count, is what bounds memory", () => {
  // 20 files at the per-file ceiling would be 300MB. The batch ceiling is what
  // makes offering 20 safe, so it must be well below that product.
  const theoretical = DOCUMENTS_IMPORT_MAX_FILES * DOCUMENT_MAX_UPLOAD_BYTES;
  assert.equal(DOCUMENTS_IMPORT_MAX_BATCH_BYTES < theoretical / 4, true);
});

/* ==================================== 2. mapping sentinel ============== */

console.log("\n2. Mapping-less sentinel");

check("the sentinel says what it means, and is versioned", () => {
  assert.equal(DOCUMENTS_NO_MAPPING_SENTINEL, "documents:no-mapping:v1");
  assert.equal(/:v\d+$/.test(DOCUMENTS_NO_MAPPING_SENTINEL), true);
});

check("it is deterministic", () => {
  assert.equal(documentsMappingHash(), documentsMappingHash());
});

check("it is a SHA-256 hex digest, the representation mappingHash expects", () => {
  assert.equal(/^[0-9a-f]{64}$/.test(documentsMappingHash()), true);
});

check("it is produced by the canonical hashing, not a hand-rolled constant", () => {
  assert.equal(
    documentsMappingHash(),
    createHash("sha256").update(DOCUMENTS_NO_MAPPING_SENTINEL).digest("hex")
  );
});

check("changing the version would change execution identity", () => {
  const v2 = createHash("sha256").update("documents:no-mapping:v2").digest("hex");
  assert.notEqual(documentsMappingHash(), v2);
});

check("it cannot collide with an ordinary mapping representation", () => {
  // A tabular mapping canonicalizes to lines of `index=field`. The sentinel is
  // a namespaced sentence, so no real mapping can hash to the same value.
  const realMapping = createHash("sha256").update("0=שם\n1=טלפון").digest("hex");
  assert.notEqual(documentsMappingHash(), realMapping);
  assert.equal(DOCUMENTS_NO_MAPPING_SENTINEL.includes("="), false);
});

check("the literal appears in exactly ONE module", () => {
  const roots = ["lib/data-transfer", "app/api/data-transfer", "components/settings"];
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".verify.test.ts")) {
        if (fs.readFileSync(full, "utf8").includes("documents:no-mapping")) hits.push(full);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(hits, ["lib/data-transfer/documents/documents-import-config.ts"]);
});

/* ================================ 3. batch identity ==================== */

console.log("\n3. Batch identity");

check("the batch hash is deterministic and order-sensitive", () => {
  const a = documentsBatchContentHash(["aa", "bb"]);
  assert.equal(a, documentsBatchContentHash(["aa", "bb"]));
  assert.notEqual(a, documentsBatchContentHash(["bb", "aa"]));
});

check("a different file set is a different batch", () => {
  assert.notEqual(
    documentsBatchContentHash(["aa", "bb"]),
    documentsBatchContentHash(["aa", "bb", "cc"])
  );
});

check("decisions hash is order-independent but value-sensitive", () => {
  assert.equal(
    documentDecisionsHash({ 1: "CREATE", 0: "SKIP" }),
    documentDecisionsHash({ 0: "SKIP", 1: "CREATE" })
  );
  assert.notEqual(
    documentDecisionsHash({ 0: "SKIP" }),
    documentDecisionsHash({ 0: "CREATE" })
  );
});

/* ============================== 4. file signatures ===================== */

console.log("\n4. File contents are checked, not just the declared type");

check("real containers are detected from their bytes", () => {
  assert.equal(detectFileSignature(pdf()), "pdf");
  assert.equal(detectFileSignature(jpeg()), "jpeg");
  assert.equal(detectFileSignature(png()), "png");
});

check("a renamed file is caught as a MISMATCH", () => {
  const v = verifyFileSignature(png(), "application/pdf");
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "MISMATCH");
});

check("arbitrary bytes claiming to be a PDF are refused", () => {
  const v = verifyFileSignature(Buffer.from("MZ\x90\x00 not a pdf"), "application/pdf");
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "UNRECOGNISED");
});

check("an empty file is refused", () => {
  const v = verifyFileSignature(Buffer.alloc(0), "application/pdf");
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "EMPTY");
});

check("matching declared type and contents passes", () => {
  assert.equal(verifyFileSignature(pdf(), "application/pdf").ok, true);
  assert.equal(verifyFileSignature(jpeg(), "image/jpeg").ok, true);
  assert.equal(verifyFileSignature(jpeg(), "image/jpg").ok, true);
  assert.equal(verifyFileSignature(png(), "image/png").ok, true);
});

/* ============================== 5. decisions =========================== */

console.log("\n5. Decisions the server would actually offer");

check("SKIP is always permitted", () => {
  for (const status of ["NEW", "DUPLICATE", "IN_FILE_DUPLICATE", "UNSUPPORTED"] as const) {
    assert.equal(isDecisionPermitted(file({ index: 0, status }), "SKIP"), true, status);
  }
});

check("an unsupported file can never be created, by either word", () => {
  const f = file({ index: 0, status: "UNSUPPORTED", action: "SKIP", overridable: false });
  assert.equal(isDecisionPermitted(f, "CREATE"), false);
  assert.equal(isDecisionPermitted(f, "CREATE_ANYWAY"), false);
});

check("an in-file duplicate can never be created, by either word", () => {
  const f = file({ index: 1, status: "IN_FILE_DUPLICATE", action: "SKIP", overridable: false });
  assert.equal(isDecisionPermitted(f, "CREATE"), false);
  assert.equal(isDecisionPermitted(f, "CREATE_ANYWAY"), false);
});

check("an existing duplicate is overridden by CREATE_ANYWAY, never by CREATE", () => {
  // The two words are not interchangeable. A plain CREATE asserts the file was
  // NOT already held, and execution relies on that: it re-derives duplicate
  // truth at execute time, and a CREATE arriving on a file that has since become
  // a duplicate must fail as drift rather than be read as an override the owner
  // never gave.
  const f = file({ index: 0, status: "DUPLICATE", action: "SKIP", overridable: true });
  assert.equal(isDecisionPermitted(f, "CREATE_ANYWAY"), true);
  assert.equal(isDecisionPermitted(f, "CREATE"), false);
});

check("a NEW file takes the plain CREATE, not the override word", () => {
  const f = file({ index: 0, status: "NEW", action: "CREATE", overridable: false });
  assert.equal(isDecisionPermitted(f, "CREATE"), true);
  assert.equal(isDecisionPermitted(f, "CREATE_ANYWAY"), false);
});

check("the digest distinguishes an override from a plain create", () => {
  assert.notEqual(
    documentDecisionsHash({ 0: "CREATE" }),
    documentDecisionsHash({ 0: "CREATE_ANYWAY" })
  );
});

check("a duplicate override is never the DEFAULT", () => {
  const files = [file({ index: 0, status: "DUPLICATE", action: "SKIP", overridable: true })];
  assert.deepEqual(defaultDocumentDecisions(files), { 0: "SKIP" });
});

check("defaults cover every file in the batch", () => {
  const files = [
    file({ index: 0 }),
    file({ index: 1, status: "DUPLICATE", action: "SKIP", overridable: true }),
    file({ index: 2, status: "UNSUPPORTED", action: "SKIP" }),
  ];
  assert.deepEqual(defaultDocumentDecisions(files), { 0: "CREATE", 1: "SKIP", 2: "SKIP" });
});

/* ============== 5b. the classifier itself, not just the predicate ====== */

console.log("\n5b. Classification behaviour (the producer, tested for real)");

function staged(index: number, hash: string, over: Partial<StagedFile> = {}): StagedFile {
  return {
    index,
    filename: `f${index}.pdf`,
    sizeBytes: 10,
    mimeType: "application/pdf",
    status: "NEW",
    reason: "",
    hash,
    ...over,
  };
}

check("different filename, SAME bytes: first wins, the rest are in-file dupes", () => {
  const out = classifyStagedFiles(
    [staged(0, "h1", { filename: "a.pdf" }), staged(1, "h1", { filename: "b.pdf" })],
    new Set()
  );
  assert.equal(out[0].status, "NEW");
  assert.equal(out[0].action, "CREATE");
  assert.equal(out[1].status, "IN_FILE_DUPLICATE");
  assert.equal(out[1].action, "SKIP");
});

check("same filename, DIFFERENT bytes: both are new", () => {
  const out = classifyStagedFiles(
    [staged(0, "h1", { filename: "same.pdf" }), staged(1, "h2", { filename: "same.pdf" })],
    new Set()
  );
  assert.equal(out[0].status, "NEW");
  assert.equal(out[1].status, "NEW");
  assert.deepEqual(out.map((f) => f.action), ["CREATE", "CREATE"]);
});

check("the same bytes three times import exactly once", () => {
  const out = classifyStagedFiles(
    [staged(0, "h"), staged(1, "h"), staged(2, "h")],
    new Set()
  );
  assert.deepEqual(out.map((f) => f.action), ["CREATE", "SKIP", "SKIP"]);
  assert.equal(out.filter((f) => f.action === "CREATE").length, 1);
});

check("an in-file duplicate is NEVER overridable", () => {
  const out = classifyStagedFiles([staged(0, "h"), staged(1, "h")], new Set());
  assert.equal(out[1].status, "IN_FILE_DUPLICATE");
  assert.equal(
    out[1].overridable,
    false,
    "the owner's own selection contradicts itself; the fix is in the picker"
  );
  assert.equal(isDecisionPermitted(out[1], "CREATE"), false);
  assert.equal(isDecisionPermitted(out[1], "CREATE_ANYWAY"), false);
});

check("an existing duplicate IS overridable, and still defaults to SKIP", () => {
  const out = classifyStagedFiles([staged(0, "h")], new Set(["h"]));
  assert.equal(out[0].status, "DUPLICATE");
  assert.equal(out[0].action, "SKIP");
  assert.equal(out[0].overridable, true);
  assert.equal(isDecisionPermitted(out[0], "CREATE_ANYWAY"), true);
  assert.equal(isDecisionPermitted(out[0], "CREATE"), false);
});

check("an unsupported file stays unsupported and un-overridable", () => {
  const out = classifyStagedFiles(
    [staged(0, "h", { status: "UNSUPPORTED", reason: "x" })],
    new Set()
  );
  assert.equal(out[0].status, "UNSUPPORTED");
  assert.equal(out[0].action, "SKIP");
  assert.equal(out[0].overridable, false);
});

check("an existing duplicate outranks an in-file duplicate", () => {
  // Both copies are already held, so neither is a "first occurrence" to import.
  const out = classifyStagedFiles([staged(0, "h"), staged(1, "h")], new Set(["h"]));
  assert.deepEqual(out.map((f) => f.status), ["DUPLICATE", "DUPLICATE"]);
  assert.deepEqual(out.map((f) => f.action), ["SKIP", "SKIP"]);
});

check("in-file resolution is by batch position, deterministically", () => {
  const a = classifyStagedFiles([staged(0, "h"), staged(1, "h")], new Set());
  const b = classifyStagedFiles([staged(0, "h"), staged(1, "h")], new Set());
  assert.deepEqual(a.map((f) => f.action), b.map((f) => f.action));
  assert.equal(a[0].action, "CREATE");
});

/* ============================== 6. zero writes ========================= */

console.log("\n6. Analyze and preview write NOTHING");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SCANNED = [
  "lib/data-transfer/documents/batch-analyze.ts",
  "lib/data-transfer/documents/file-signature.ts",
  "lib/data-transfer/documents/documents-import-config.ts",
  "app/api/data-transfer/documents/analyze/route.ts",
];

check("no module in the analyze path performs a Prisma write", () => {
  const WRITE = /\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
  for (const f of SCANNED) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    const hit = WRITE.exec(code);
    assert.equal(hit, null, `${f} writes: ${hit?.[0]}`);
  }
  // the scan can actually catch one
  assert.equal(WRITE.test("await tx.document.create({ data })"), true);
  assert.equal(WRITE.test('createHash("sha256").update(b)'), false);
});

check("analyze never reaches ingestion, storage or the ledger", () => {
  for (const f of SCANNED) {
    const code = stripComments(fs.readFileSync(f, "utf8"));
    for (const forbidden of [
      "ingestDocument(",
      "putDocumentObject",
      "processDocumentPipeline",
      "openOrResumeRun",
      "markRow",
      "importRun",
      "after(",
    ]) {
      assert.equal(code.includes(forbidden), false, `${f} reaches ${forbidden}`);
    }
  }
});

check("the only DB access is a tenant-scoped read", () => {
  const code = stripComments(fs.readFileSync("lib/data-transfer/documents/batch-analyze.ts", "utf8"));
  assert.equal(code.includes("runWithTenantContext"), true);
  assert.equal(code.includes("withTenantTransaction"), true);
  assert.equal(code.includes("findMany"), true);
  assert.equal(/\bprisma\./.test(code), false, "no bare client outside the substrate");
  // Robust to formatting: within the findMany call, the tenant filter must
  // appear before the projection. A read that lost it would select every
  // business row that happens to share a content hash.
  const call = code.slice(code.indexOf("findMany"));
  const projectionAt = call.indexOf("select:");
  const tenantAt = call.indexOf("businessId");
  assert.notEqual(tenantAt, -1, "the duplicate read names no tenant at all");
  assert.equal(
    tenantAt < projectionAt,
    true,
    "the duplicate read must be tenant-scoped in its where clause"
  );
  assert.equal(call.slice(0, projectionAt).includes("failed"), true);
});

check("the duplicate lookup returns hashes, not internal document ids", () => {
  const code = stripComments(fs.readFileSync("lib/data-transfer/documents/batch-analyze.ts", "utf8"));
  const sel = code.slice(code.indexOf("select: {"), code.indexOf("select: {") + 120);
  assert.equal(sel.includes("contentHashSha256"), true);
  assert.equal(/select: \{[^}]*\bid: true/.test(code), false, "no document id selected");
});

/* ============================== 7. route contract ====================== */

console.log("\n7. Route contract");

const routeSrc = fs.readFileSync("app/api/data-transfer/documents/analyze/route.ts", "utf8");
const routeCode = stripComments(routeSrc);

check("the tenant is server-derived and never read from the request", () => {
  assert.equal(routeCode.includes("businessId: user.businessId"), true);
  assert.equal(/form\.get\(\s*["']businessId["']\s*\)/.test(routeCode), false);
});

const formCode = fs.readFileSync(
  "lib/data-transfer/documents/documents-request.ts",
  "utf8"
);

check("auth precedes everything, including reading the body", () => {
  const auth = routeCode.indexOf("getCurrentUser");
  const body = routeCode.indexOf("req.formData()");
  const rate = routeCode.indexOf("checkRateLimit");
  assert.equal(auth < rate, true);
  assert.equal(rate < body, true, "rate limiting must precede reading the body");
});

check("the batch ceilings are enforced before and after reading bytes", () => {
  // The limits moved into the shared parser when Execute appeared, so that the
  // two endpoints cannot drift apart on what they accept. Assert them where
  // they now live, and assert the route actually delegates there.
  assert.equal(routeCode.includes("readDocumentBatchForm("), true);
  assert.equal(formCode.includes("TOO_MANY_FILES"), true);
  // declared-size pre-check AND real byte accounting
  assert.equal((formCode.match(/tooLarge\(\)/g) || []).length >= 2, true);
  assert.equal(formCode.includes("DOCUMENTS_IMPORT_MAX_FILES"), true);
  assert.equal(formCode.includes("DOCUMENTS_IMPORT_MAX_BATCH_BYTES"), true);
});

check("an empty batch is refused", () => {
  assert.equal(formCode.includes("NO_FILES"), true);
});

check("the parser accepts exactly the three decision words", () => {
  assert.equal(
    formCode.includes('const ACTIONS: readonly string[] = ["CREATE", "CREATE_ANYWAY", "SKIP"];'),
    true
  );
  assert.equal(formCode.includes("DECISIONS_MALFORMED"), true);
});

check("responses are private and never cached", () => {
  assert.equal(routeSrc.includes('"Cache-Control": "private, no-store"'), true);
});

check("the token binds the batch, and carries no filenames or bytes", () => {
  assert.equal(routeCode.includes('domain: "documents"'), true);
  assert.equal(routeCode.includes("documentsBatchContentHash("), true);
  assert.equal(routeCode.includes("documentsMappingHash()"), true);
  assert.equal(routeCode.includes("documentDecisionsHash("), true);
  // filenames are display-only and must stay out of the signed payload
  assert.equal(/issuePreviewToken\([\s\S]*?filename/.test(routeCode), false);
});

check("a client decision is re-checked against fresh analysis", () => {
  assert.equal(routeCode.includes("isDecisionPermitted("), true);
  assert.equal(routeCode.includes("DECISION_NOT_PERMITTED"), true);
  const analyze = routeCode.indexOf("analyzeDocumentBatch(");
  const permit = routeCode.indexOf("isDecisionPermitted(");
  assert.equal(analyze < permit, true, "analysis must precede the permission check");
});

check("the error path never echoes a filename", () => {
  const tail = routeCode.slice(routeCode.indexOf("} catch (error)"));
  assert.equal(tail.includes("error.message"), false);
  assert.equal(tail.includes("error.name"), true);
});

console.log(`\nI-7B DOCUMENTS ANALYZE VERIFY PASS — ${passed} checks green.`);
