const fs = require("fs");
function patch(file, edits, opts = {}) {
  let s = fs.readFileSync(file, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  for (let [from, to] of edits) {
    from = from.split("\n").join(nl); to = to.split("\n").join(nl);
    if (!s.includes(from)) {
      if (opts.tolerant) { console.log("skip (miss) in " + file + ": " + JSON.stringify(from.slice(0, 50))); continue; }
      console.error("MISS in " + file + ": " + JSON.stringify(from.slice(0, 70))); process.exit(1);
    }
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
  console.log("patched " + file);
}

const DBSTEP = `import type { Prisma } from "@prisma/client";
import { getTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

// D2/P7-W4D: run a single DB step on a short tenant transaction when a tenant
// context is established (all document routes set one); outside a context the
// step runs directly (pure unit tests / offline scripts). Under an
// established context there is NO fallback to the global client.
async function dbStep<T>(
  fn: (db: Prisma.TransactionClient | typeof prisma) => Promise<T>
): Promise<T> {
  if (getTenantContext() !== undefined) {
    return withTenantTransaction((tx) => fn(tx));
  }
  return fn(prisma);
}`;

// Generic transform: add DBSTEP after the prisma import and wrap listed
// `await prisma.X(...)` single-call sites with dbStep.
function dbstepify(file, calls) {
  let s = fs.readFileSync(file, "utf8");
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  if (!s.includes('import { prisma } from "@/lib/prisma";')) {
    console.error("MISS prisma import in " + file); process.exit(1);
  }
  if (!s.includes("async function dbStep")) {
    s = s.replace('import { prisma } from "@/lib/prisma";',
      'import { prisma } from "@/lib/prisma";' + nl + DBSTEP.split("\n").join(nl));
  }
  for (const callStart of calls) {
    const start = s.indexOf(callStart);
    if (start === -1) { console.error("MISS call in " + file + ": " + callStart.slice(0, 60)); process.exit(1); }
    // find matching close: scan from the "(" after prisma.X.method
    const parenIdx = s.indexOf("(", start + callStart.length - 1);
    let depth = 0, i = parenIdx;
    for (; i < s.length; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") { depth--; if (depth === 0) break; }
    }
    const orig = s.slice(start, i + 1);
    const wrapped = orig
      .replace(/await prisma\./, "await dbStep((db) => db.")
      + ")";
    s = s.slice(0, start) + wrapped + s.slice(i + 1);
  }
  fs.writeFileSync(file, s);
  console.log("dbstepified " + file);
}

// 1. correction-ledger: 4 writes, each its own short tenant tx (keeps the
//    individual best-effort semantics).
dbstepify("lib/services/documents/ledger/correction-ledger.service.ts", [
  "await prisma.extractionSnapshot.create",
  "await prisma.sliceDecision.createMany",
  "await prisma.extractionEvidence.create",
  "await prisma.reviewEvent.create",
]);

// 2. create-document-from-ocr
dbstepify("lib/services/documents/create-document-from-ocr.service.ts", [
  "await prisma.document.create",
  "await prisma.extractedData.create",
]);

// 3. duplicate-signals (3 reads)
dbstepify("lib/services/documents/duplicate-signals.service.ts", [
  "await prisma.document.findFirst",
  "await prisma.document.findMany",
  "await prisma.document.findMany",
]);

// 4. output-profile-resolver (1 read)
dbstepify("lib/services/documents/output-profile-resolver.service.ts", [
  "await prisma.extractionSnapshot.findFirst",
]);

// 5. category-decision (VendorLearning read at extraction)
dbstepify("lib/services/documents/category-decision.service.ts", [
  "await prisma.vendorLearning.findUnique",
]);

// 6. pending-review + paperwork-insight + accountant-export-zip
dbstepify("lib/documents/pending-review.ts", [
  "await prisma.document.count",
  "await prisma.document.findMany",
]);
dbstepify("lib/business-status/paperwork-insight.ts", [
  "await prisma.financialRecord.count",
]);
dbstepify("lib/reports/accountant-export-zip.ts", [
  "await prisma.financialRecord.findMany",
]);

// 7. business-memory evidence readers (flag-gated; future-correct)
dbstepify("lib/business-memory/evidence/extraction-snapshot.mapper.ts", [
  "await prisma.extractionSnapshot.findMany",
]);
dbstepify("lib/business-memory/evidence/review-event.reader.ts", [
  "await prisma.reviewEvent.findMany",
]);
