/**
 * I-7A — canonical Documents ingestion: equivalence and boundary verifier.
 *
 * This increment moved an ordering, not a feature. The upload route behaved
 * correctly before and must behave identically after, so most of what follows
 * asserts that nothing moved that should not have — and, just as importantly,
 * that the things which HAD to move are no longer duplicated in the route.
 *
 * The failure this exists to prevent is specific: a second caller reproducing
 * the ingestion sequence slightly differently. A document ingested by the
 * Import Center must be indistinguishable from one the owner uploaded, and the
 * only way to guarantee that is for there to be exactly one implementation.
 *
 * NO database and NO network. The parts that need a real Postgres (tenant
 * isolation, RLS) are proven by the D2/P7 matrix; what is provable statically
 * is proven statically, and nothing here pretends otherwise.
 *
 * Run: npx tsx lib/services/documents/document-ingestion.verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  DOCUMENT_MAX_UPLOAD_BYTES,
  isAllowedDocumentMime,
  isHeicMimeType,
} from "@/lib/services/documents/document-ingestion.service";
import {
  containerForDeclaredMime,
  signatureRejectionMessage,
  SUPPORTED_DOCUMENT_MIME_TYPES,
  verifyFileSignature,
} from "@/lib/services/documents/file-signature";

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${label}`);
}

const SERVICE = "lib/services/documents/document-ingestion.service.ts";
const ROUTE = "app/api/documents/upload/route.ts";
const serviceSrc = fs.readFileSync(SERVICE, "utf8");
const routeSrc = fs.readFileSync(ROUTE, "utf8");

/** Comments describe the constructs they forbid, so strip before scanning. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const serviceCode = stripComments(serviceSrc);
const routeCode = stripComments(routeSrc);

/* ==================================== 1. acceptance rules, unchanged ==== */

console.log("\n1. Acceptance rules (behaviour frozen from the pre-refactor route)");

check("the 15MB ceiling is unchanged", () => {
  assert.equal(DOCUMENT_MAX_UPLOAD_BYTES, 15 * 1024 * 1024);
});

check("PDF, JPEG and PNG are accepted", () => {
  assert.equal(isAllowedDocumentMime("application/pdf"), true);
  assert.equal(isAllowedDocumentMime("image/jpeg"), true);
  assert.equal(isAllowedDocumentMime("image/png"), true);
  assert.equal(isAllowedDocumentMime("IMAGE/PNG"), true, "case-insensitive");
  assert.equal(isAllowedDocumentMime("  application/pdf  "), true, "trimmed");
});

check("HEIC and HEIF keep their own, more specific refusal", () => {
  assert.equal(isHeicMimeType("image/heic"), true);
  assert.equal(isHeicMimeType("image/heif"), true);
  assert.equal(isHeicMimeType("IMAGE/HEIC"), true);
  // The order matters: the route checks HEIC first so its message wins, and
  // the closed allowlist excludes it independently.
  assert.equal(isAllowedDocumentMime("image/heic"), false);
  assert.equal(isAllowedDocumentMime("image/heif"), false);
});

check("everything else is refused", () => {
  for (const m of [
    "application/zip",
    "text/html",
    "image/svg+xml".replace("image/", "application/"),
    "",
    "application/octet-stream",
  ]) {
    assert.equal(isAllowedDocumentMime(m), false, m);
  }
});

check("a non-string mime cannot slip through", () => {
  assert.equal(isAllowedDocumentMime(undefined as unknown as string), false);
  assert.equal(isAllowedDocumentMime(null as unknown as string), false);
});

/* ============================== 2. the route no longer ingests ========== */

console.log("\n2. The route delegates instead of reproducing the sequence");

check("the route calls the canonical service", () => {
  assert.equal(routeCode.includes("ingestDocument("), true);
});

check("the route performs NO step of the ingestion sequence itself", () => {
  // Each of these is a step that must have exactly one implementation. Finding
  // any of them here again would mean the second engine is back.
  for (const forbidden of [
    "document.create",
    "putDocumentObject",
    "buildStoredDocumentFileName",
    "deleteDocumentObjectQuiet",
    "processDocumentPipeline(",
    "sha256Hex(",
    "findFirst",
  ]) {
    assert.equal(
      routeCode.includes(forbidden),
      false,
      `the route still performs: ${forbidden}`
    );
  }
});

check("the acceptance rules are the SHARED ones, not route-local copies", () => {
  assert.equal(routeCode.includes("isAllowedDocumentMime("), true);
  assert.equal(routeCode.includes("isHeicMimeType("), true);
  assert.equal(routeCode.includes("DOCUMENT_MAX_UPLOAD_BYTES"), true);
  // The old private copies must be gone, or the two callers could diverge.
  assert.equal(/function isAllowedMime/.test(routeCode), false);
  assert.equal(/function isHeic\b/.test(routeCode), false);
  assert.equal(/const MAX_UPLOAD_BYTES/.test(routeCode), false);
});

check("the stripper self-test removes a commented-out construct", () => {
  assert.equal(stripComments("// document.create\nconst a=1;").includes("document.create"), false);
  assert.equal(stripComments("const s='document.create';").includes("document.create"), true);
});

/* ================================ 3. HTTP stays in the route =========== */

console.log("\n3. HTTP responsibilities stayed where they belong");

check("auth, rate limiting and product-usage remain route concerns", () => {
  for (const kept of [
    "getCurrentUser",
    "checkRateLimit",
    "UPLOAD_ACCEPT",
    "DOCUMENT_PROCESSING",
    "recordProductUsageEvent",
    "req.formData()",
  ]) {
    assert.equal(routeCode.includes(kept), true, `route lost: ${kept}`);
  }
});

check("the service decides nothing about HTTP", () => {
  for (const forbidden of [
    "NextResponse",
    "getCurrentUser",
    "checkRateLimit",
    "formData",
    "status: 4",
    "status: 5",
  ]) {
    assert.equal(
      serviceCode.includes(forbidden),
      false,
      `the service reaches into HTTP: ${forbidden}`
    );
  }
});

check("every response the route produced before, it still produces", () => {
  // Frozen wording and codes — these are what the client and the owner see.
  assert.equal(routeSrc.includes('"לא מחובר"'), true); // 401
  assert.equal(routeSrc.includes("פורמט HEIC לא נתמך"), true); // 415
  assert.equal(routeSrc.includes("סוג קובץ לא נתמך"), true); // 400
  assert.equal(routeSrc.includes("הקובץ גדול מדי (עד 15MB)"), true); // 413
  assert.equal(routeSrc.includes("נראה שהמסמך הזה כבר הועלה"), true); // 409
  assert.equal(routeSrc.includes("שגיאה בהעלאת המסמך"), true); // 500
  assert.equal(routeSrc.includes("לא נבחר קובץ"), true); // 400
  assert.equal(/status: 409/.test(routeSrc), true);
  assert.equal(/success: true/.test(routeSrc), true);
  assert.equal(/status: "processing"/.test(routeSrc), true);
});

/* ============================ 4. the ordering that matters ============= */

console.log("\n4. The ordering the whole refactor exists to protect");

check("storage is written BEFORE the Document row", () => {
  const put = serviceCode.indexOf("putDocumentObject(");
  const create = serviceCode.indexOf("document.create");
  assert.notEqual(put, -1);
  assert.notEqual(create, -1);
  assert.equal(
    put < create,
    true,
    "a row pointing at a file that does not exist is a broken document"
  );
});

check("a cheap duplicate look happens BEFORE anything is written", () => {
  // Advisory only: it exists so a file the business already holds costs no
  // storage write and no pipeline. The decision that binds is the locked one.
  const early = serviceCode.indexOf("findDuplicateDocumentTx(");
  const put = serviceCode.indexOf("putDocumentObject(");
  assert.notEqual(early, -1);
  assert.equal(early < put, true);
});

check("the BINDING duplicate decision is taken under the content lock", () => {
  // A check in its own transaction is a snapshot, not a guarantee: two callers
  // could both read "no duplicate" and both insert. The authoritative check
  // runs inside the create transaction, after taking the lock.
  const lock = serviceCode.indexOf("lockDocumentContent(tx");
  const create = serviceCode.indexOf("tx.document.create(");
  assert.notEqual(lock, -1, "the create transaction takes the content lock");
  assert.equal(lock < create, true, "and takes it before creating");
  const between = serviceCode.slice(lock, create);
  assert.equal(between.includes("findDuplicateDocumentTx("), true);
});

check("an explicit override still takes the lock, and only skips the check", () => {
  const lock = serviceCode.indexOf("lockDocumentContent(tx");
  const create = serviceCode.indexOf("tx.document.create(");
  const between = serviceCode.slice(lock, create);
  // The guard sits around the LOOKUP, never around the lock itself: an override
  // means "create a second copy deliberately", not "skip the serialisation".
  assert.equal(between.includes("if (!input.allowDuplicate)"), true);
  const guard = between.indexOf("if (!input.allowDuplicate)");
  assert.equal(guard > 0, true, "the lock is taken before the override guard");
});

check("phase 2 is scheduled by the SERVICE, so a caller cannot forget it", () => {
  assert.equal(serviceCode.includes("after("), true);
  assert.equal(serviceCode.includes("processDocumentPipeline("), true);
  const create = serviceCode.indexOf("document.create");
  const sched = serviceCode.indexOf("after(");
  assert.equal(sched > create, true, "scheduling must follow persistence");
});

check("a failed row-create cleans up its own storage orphan", () => {
  const create = serviceCode.indexOf("document.create");
  const cleanup = serviceCode.indexOf("deleteDocumentObjectQuiet(");
  assert.notEqual(cleanup, -1, "the service must clean up after itself");
  assert.equal(cleanup > create, true);
});

/* ================================ 5. domain invariants ================= */

console.log("\n5. Domain invariants");

check("the tenant is server-derived and never client-supplied", () => {
  // The service takes businessId as a typed input from a trusted caller and
  // never reads it from a request; it has no access to one.
  assert.equal(serviceCode.includes("formData"), false);
  assert.equal(serviceCode.includes("req."), false);
  assert.equal(/businessId: input\.businessId/.test(serviceCode), true);
});

check("every DB access runs inside the tenant substrate", () => {
  assert.equal(serviceCode.includes("runWithTenantContext"), true);
  assert.equal(serviceCode.includes("withTenantTransaction"), true);
  // No bare prisma client: that would escape RLS context.
  assert.equal(/\bprisma\./.test(serviceCode), false);
});

check("the duplicate lookup is tenant-scoped, and lives in ONE place", () => {
  // It moved out of this service when a second and third intake path needed
  // the same answer. Two copies of "does this business already hold it" is two
  // chances to disagree.
  const shared = fs.readFileSync(
    "lib/services/documents/document-duplicate.ts",
    "utf8"
  );
  const fn = shared.slice(shared.indexOf("export async function findDuplicateDocumentTx"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.equal(body.includes("businessId,"), true);
  assert.equal(body.includes("contentHashSha256,"), true);
  assert.equal(body.includes('status: { not: "failed" }'), true);
  // and this service no longer carries its own copy
  assert.equal(/async function findDuplicate\b/.test(serviceCode), false);
});

check("the stored name is derived, never taken from the uploader", () => {
  assert.equal(serviceCode.includes("buildStoredDocumentFileName(input.mimeType)"), true);
  // originalFilename is persisted for display but must never become the key.
  assert.equal(/basename: input\.originalFilename/.test(serviceCode), false);
});

check("BillingDocument is never touched", () => {
  assert.equal(/billingDocument/i.test(serviceCode), false);
  assert.equal(/billingDocument/i.test(routeCode), false);
});

check("ingestion writes no approval-only effect", () => {
  // vendorLearning / financialRecord / reviewEvent belong to the approve route.
  // Bulk import must not train the business merely by ingesting.
  for (const forbidden of ["vendorLearning", "financialRecord.upsert", "reviewEvent"]) {
    assert.equal(serviceCode.includes(forbidden), false, forbidden);
  }
});

check("a new document still starts in processing, with the same fields", () => {
  assert.equal(serviceCode.includes('status: "processing"'), true);
  for (const field of [
    "fileUrl:",
    "source:",
    "mimeType:",
    "ocrText: null",
    "contentHashSha256,",
    "originalFilename:",
    "sizeBytes:",
  ]) {
    assert.equal(serviceCode.includes(field), true, `missing field: ${field}`);
  }
});

check("a duplicate is returned as a decision, never thrown", () => {
  assert.equal(serviceCode.includes('reason: "DUPLICATE"'), true);
  assert.equal(/throw new Error\("duplicate/i.test(serviceCode), false);
});

/* ========================= 5. content-signature acceptance (I-7C.1) ===== */

console.log("\n5. A file must BE what it claims to be");

const SIGNATURE = "lib/services/documents/file-signature.ts";
const signatureSrc = fs.readFileSync(SIGNATURE, "utf8");
const batchSrc = fs.readFileSync(
  "lib/data-transfer/documents/batch-analyze.ts",
  "utf8"
);

const realPdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("body")]);
const realJpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("body"),
]);
const realPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("body"),
]);
const arbitrary = Buffer.from("MZ\x90\x00 this is not a document at all");

check("a real file under its own type is accepted", () => {
  assert.deepEqual(verifyFileSignature(realPdf, "application/pdf"), {
    ok: true,
    detected: "pdf",
  });
  assert.deepEqual(verifyFileSignature(realJpeg, "image/jpeg"), {
    ok: true,
    detected: "jpeg",
  });
  assert.deepEqual(verifyFileSignature(realPng, "image/png"), {
    ok: true,
    detected: "png",
  });
});

check("arbitrary bytes are refused under EVERY supported type", () => {
  for (const declared of ["application/pdf", "image/jpeg", "image/png"]) {
    const verdict = verifyFileSignature(arbitrary, declared);
    assert.equal(verdict.ok, false, declared);
    assert.equal(
      verdict.ok === false && verdict.reason,
      "UNRECOGNISED",
      declared
    );
  }
});

check("a real file under the WRONG supported type is refused", () => {
  // Each of these is a genuine document, just not the one it claims to be —
  // the renamed-file case, which is the common one in practice.
  const cases: [Buffer, string][] = [
    [realJpeg, "application/pdf"],
    [realPng, "image/jpeg"],
    [realPdf, "image/png"],
    [realPdf, "image/jpeg"],
    [realPng, "application/pdf"],
    [realJpeg, "image/png"],
  ];
  for (const [bytes, declared] of cases) {
    const verdict = verifyFileSignature(bytes, declared);
    assert.equal(verdict.ok, false, declared);
    assert.equal(verdict.ok === false && verdict.reason, "MISMATCH", declared);
  }
});

check("an empty file is refused as empty, not as a mismatch", () => {
  const verdict = verifyFileSignature(Buffer.alloc(0), "application/pdf");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, "EMPTY");
});

check("a type outside the supported set can never verify", () => {
  // Belt and braces: even if a declared type somehow passed the allowlist, the
  // validator has no container to check it against and refuses.
  for (const declared of ["image/webp", "image/gif", "image/heic", "", "text/html"]) {
    assert.equal(verifyFileSignature(realPng, declared).ok, false, declared);
  }
});

check("the non-standard image/jpg spelling names the same container", () => {
  assert.equal(verifyFileSignature(realJpeg, "image/jpg").ok, true);
  assert.equal(verifyFileSignature(realPng, "image/jpg").ok, false);
  assert.equal(isAllowedDocumentMime("image/jpg"), true);
});

check("declared type and detection are case- and whitespace-insensitive", () => {
  assert.equal(verifyFileSignature(realPdf, "  APPLICATION/PDF  ").ok, true);
  assert.equal(containerForDeclaredMime("IMAGE/PNG"), "png");
  assert.equal(containerForDeclaredMime("image/webp"), null);
});

/* -------- the supported set is now CLOSED (deliberate narrowing) -------- */

check("the supported set is exactly PDF, JPEG and PNG", () => {
  assert.deepEqual([...SUPPORTED_DOCUMENT_MIME_TYPES].sort(), [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
  ]);
});

check("the image/* wildcard is gone, and with it the bypass", () => {
  // It used to be enough to declare ANY image subtype to get arbitrary bytes
  // accepted, because no validator can ever cover an unbounded set.
  for (const m of ["image/webp", "image/gif", "image/tiff", "image/bmp", "image/svg+xml"]) {
    assert.equal(isAllowedDocumentMime(m), false, m);
  }
  assert.equal(/startsWith\("image\//.test(serviceCode), false);
});

check("the allowlist is DERIVED from the signature table, not a second list", () => {
  // Two independent lists is how the old divergence happened. The service must
  // ask the signature module rather than restate the answer.
  assert.equal(serviceCode.includes("containerForDeclaredMime("), true);
  assert.equal(serviceCode.includes('=== "application/pdf"'), false);
});

check("there is exactly ONE content validator in the codebase", () => {
  assert.equal(signatureSrc.includes("export function detectFileSignature"), true);
  assert.equal(
    batchSrc.includes('from "@/lib/services/documents/file-signature"'),
    true
  );
  assert.equal(
    routeSrc.includes('from "@/lib/services/documents/file-signature"'),
    true
  );
  for (const src of [batchSrc, routeSrc, serviceSrc]) {
    assert.equal(src.includes("0x89, 0x50, 0x4e, 0x47"), false, "PNG bytes duplicated");
    assert.equal(src.includes('Buffer.from("%PDF-")'), false, "PDF magic duplicated");
  }
});

/* ---------------- the route enforces it, before anything else ---------- */

check("the upload route validates the bytes before the canonical lifecycle", () => {
  const readBytes = routeCode.indexOf("file.arrayBuffer()");
  const verify = routeCode.indexOf("verifyFileSignature(");
  const ingest = routeCode.indexOf("ingestDocument(");
  assert.equal(readBytes > 0 && verify > readBytes, true, "bytes are read first");
  assert.equal(verify < ingest, true, "and checked BEFORE ingestion is called");
});

check("a signature refusal returns before any mutation is possible", () => {
  // The route performs no storage, no Document write and no scheduling itself
  // (asserted in section 2), so returning before `ingestDocument` is the whole
  // proof: nothing downstream of the gate can run.
  const verify = routeCode.indexOf("const signature = verifyFileSignature(");
  const guard = routeCode.indexOf("if (!signature.ok)", verify);
  const ingest = routeCode.indexOf("ingestDocument(");
  assert.equal(guard > verify && guard < ingest, true);
  const between = routeCode.slice(verify, ingest);
  assert.equal(between.includes("status: 415"), true, "it refuses with 415");
  for (const mutation of ["putDocumentObject", "document.create", "after("]) {
    assert.equal(between.includes(mutation), false, mutation);
  }
});

check("the refusal reuses the shared wording, not a route-local copy", () => {
  assert.equal(routeCode.includes("signatureRejectionMessage("), true);
  assert.equal(signatureSrc.includes("export function signatureRejectionMessage"), true);
  // No parser vocabulary leaks to the owner.
  for (const jargon of ["signature", "magic", "mime", "sniff", "header"]) {
    assert.equal(
      signatureRejectionMessage("MISMATCH").toLowerCase().includes(jargon),
      false,
      jargon
    );
  }
});

check("the refusal names no filename and no bytes", () => {
  const verify = routeCode.indexOf("const signature = verifyFileSignature(");
  const ingest = routeCode.indexOf("ingestDocument(");
  const between = routeCode.slice(verify, ingest);
  assert.equal(between.includes("file.name"), false);
  assert.equal(between.includes("originalFilename"), false);
});

check("the existing refusals keep their own statuses and wording", () => {
  // The only intended change to the response contract is the NEW 415 case.
  assert.equal(routeCode.includes("status: 415"), true);
  assert.equal(routeCode.includes("status: 413"), true, "still too-large");
  assert.equal(routeCode.includes("status: 409"), true, "still duplicate");
  assert.equal(routeCode.includes("status: 401"), true, "still unauthenticated");
  assert.equal(routeSrc.includes("פורמט HEIC לא נתמך"), true, "HEIC wording kept");
  assert.equal(routeSrc.includes("הקובץ גדול מדי (עד 15MB)"), true);
  assert.equal(routeSrc.includes("נראה שהמסמך הזה כבר הועלה"), true);
});

check("the import centre's behaviour is unchanged by the move", () => {
  // Same validator, same call, same place in its own pipeline.
  assert.equal(batchSrc.includes("verifyFileSignature(file.buffer, mimeType)"), true);
  assert.equal(batchSrc.includes("isAllowedDocumentMime("), true);
});

check("the picker offers exactly what the server accepts", () => {
  for (const page of [
    "app/(shell)/documents/upload/page.tsx",
    "app/(shell)/documents/page.tsx",
  ]) {
    const src = fs.readFileSync(page, "utf8");
    assert.equal(src.includes('accept="image/*"'), false, page);
    assert.equal(src.includes('accept="image/*,application/pdf"'), false, page);
    assert.equal(src.includes('accept="application/pdf,image/*"'), false, page);
  }
});

check("a rejection is observable, without recording anything identifying", () => {
  const verify = routeCode.indexOf("const signature = verifyFileSignature(");
  const ingest = routeCode.indexOf("ingestDocument(");
  const between = routeCode.slice(verify, ingest);
  assert.equal(between.includes("recordProductUsageEvent("), true);
  assert.equal(between.includes("content-signature:"), true);
  // Observability must never decide the response.
  assert.equal(between.includes("}).catch(() => {})"), true);
});


console.log(`\nDOCUMENT INGESTION + CONTENT SIGNATURE VERIFY PASS — ${passed} checks green.`);
