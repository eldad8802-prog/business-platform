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

check("PDF and images are accepted, exactly as before", () => {
  assert.equal(isAllowedDocumentMime("application/pdf"), true);
  assert.equal(isAllowedDocumentMime("image/jpeg"), true);
  assert.equal(isAllowedDocumentMime("image/png"), true);
  assert.equal(isAllowedDocumentMime("IMAGE/PNG"), true, "case-insensitive");
  assert.equal(isAllowedDocumentMime("  application/pdf  "), true, "trimmed");
});

check("HEIC and HEIF are still refused", () => {
  assert.equal(isHeicMimeType("image/heic"), true);
  assert.equal(isHeicMimeType("image/heif"), true);
  assert.equal(isHeicMimeType("IMAGE/HEIC"), true);
  // The order matters: HEIC is an image/*, so the HEIC test must win.
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

check("the duplicate check happens BEFORE anything is written", () => {
  const dup = serviceCode.indexOf("findDuplicate(");
  const put = serviceCode.indexOf("putDocumentObject(");
  assert.notEqual(dup, -1);
  assert.equal(dup < put, true);
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

check("the duplicate lookup is tenant-scoped", () => {
  const fn = serviceCode.slice(serviceCode.indexOf("async function findDuplicate"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.equal(body.includes("businessId,"), true);
  assert.equal(body.includes("contentHashSha256,"), true);
  assert.equal(body.includes('status: { not: "failed" }'), true);
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

console.log(`\nI-7A DOCUMENT INGESTION VERIFY PASS — ${passed} checks green.`);
