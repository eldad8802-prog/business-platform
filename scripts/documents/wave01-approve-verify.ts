/**
 * Wave 0B + 1A runtime verify (dev DB, run manually):
 *   npx tsx scripts/documents/wave01-approve-verify.ts
 *
 * In-process integration test of the approve route against the real dev DB:
 *   1. snapshot-based profile → financial_transaction is reachable again
 *   2. financial approval commits FR + status + ReviewEvent atomically
 *   3. explicit document-only save never creates a FinancialRecord
 *   4. failed validation (400) leaves NO writes behind (no draft overwrite)
 *   5. duplicate signals: exact_file + same_transaction on the GET route
 *
 * Creates its own synthetic rows (vendor prefix "WAVE01 VERIFY") and deletes
 * them at the end.
 */

import { prisma } from "@/lib/prisma";
import { signAuthToken } from "@/lib/auth";
import { POST as approvePOST } from "@/app/api/documents/[id]/approve/route";
import { GET as documentGET } from "@/app/api/documents/[id]/route";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const VENDOR = "WAVE01 VERIFY VENDOR";

function ctxFor(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

function approveReq(token: string, body: unknown) {
  return new Request("http://localhost/api/documents/x/approve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function makeDoc(params: {
  businessId: number;
  hash?: string;
  amount?: number | null;
  direction?: string;
  date?: Date;
  withSnapshot?: boolean;
}) {
  const doc = await prisma.document.create({
    data: {
      businessId: params.businessId,
      fileUrl: `doc-${Date.now()}-wave01t.png`,
      source: "file",
      mimeType: "image/png",
      status: "needs_review",
      ocrText: "קבלה מס 123 " + VENDOR,
      contentHashSha256: params.hash ?? null,
    },
  });
  await prisma.extractedData.create({
    data: {
      documentId: doc.id,
      amount: params.amount === undefined ? 123.45 : params.amount,
      vendorName: VENDOR,
      category: "general",
      direction: params.direction ?? "expense",
      date: params.date ?? new Date("2026-08-20T00:00:00Z"),
      confidenceScore: 0.9,
    },
  });
  if (params.withSnapshot !== false) {
    await prisma.extractionSnapshot.create({
      data: {
        documentId: doc.id,
        businessId: params.businessId,
        sourceChannel: "upload",
        liveEngineVersion: "wave01-verify",
        ocrEngine: "google-vision",
        ocrVersion: "test",
        extractionOutcome: "ok",
        vendorName: VENDOR,
        documentType: "receipt",
        direction: params.direction ?? "expense",
        amount: params.amount === undefined ? 123.45 : params.amount,
        date: params.date ?? new Date("2026-08-20T00:00:00Z"),
        category: "general",
        confidenceScore: 0.9,
        isFinancial: true,
        financialEvidenceLevel: "strong",
        guardrailRoute: "financial_transaction",
        rawResult: { searchableText: `קבלה ${VENDOR}` },
      },
    });
  }
  return doc;
}

async function main() {
  const anyBiz = await prisma.user.findFirst({
    where: { business: { deletedAt: null } },
    orderBy: { id: "asc" },
    select: { id: true, businessId: true },
  });
  if (!anyBiz) throw new Error("no usable dev user");
  const { id: userId, businessId } = anyBiz;
  const token = signAuthToken(userId);
  console.log(`using user ${userId} / business ${businessId}`);

  const createdDocIds: number[] = [];

  try {
    // ── 1+2: financial approval via snapshot-resolved profile ─────────────
    const doc1 = await makeDoc({ businessId, hash: "wave01hash-A" });
    createdDocIds.push(doc1.id);

    const res1 = await approvePOST(
      approveReq(token, {
        explicitFinancial: true,
        extracted: {
          amount: 123.45,
          vendorName: VENDOR,
          date: "2026-08-20",
          direction: "expense",
          category: "general",
        },
      }),
      ctxFor(doc1.id)
    );
    const json1 = (await res1.json()) as {
      success?: boolean;
      approvedAs?: string;
      record?: { id?: number } | null;
      outputProfile?: { profileId?: string };
    };
    ok("financial approve returns 200", res1.status === 200 && json1.success === true);
    ok(
      "snapshot resolver reaches financial_transaction",
      json1.outputProfile?.profileId === "financial_transaction"
    );
    ok("approvedAs financial", json1.approvedAs === "financial");
    const fr1 = await prisma.financialRecord.findUnique({
      where: { documentId: doc1.id },
    });
    const d1 = await prisma.document.findUnique({ where: { id: doc1.id } });
    const re1 = await prisma.reviewEvent.findMany({
      where: { documentId: doc1.id },
    });
    ok("FinancialRecord committed", fr1 !== null && fr1.amount === 123.45);
    ok("Document approved", d1?.status === "approved");
    ok(
      "ReviewEvent committed in same operation",
      re1.length === 1 && re1[0].approvedAs === "financial"
    );

    // ── 3: explicit document-only save on a FINANCIAL profile → no FR ─────
    const doc2 = await makeDoc({ businessId, hash: "wave01hash-B" });
    createdDocIds.push(doc2.id);
    const res2 = await approvePOST(
      approveReq(token, {
        explicitFinancial: false,
        extracted: { vendorName: VENDOR, category: "general", date: "2026-08-20" },
      }),
      ctxFor(doc2.id)
    );
    const json2 = (await res2.json()) as { approvedAs?: string };
    ok("document-only approve returns 200", res2.status === 200);
    ok("document-only approvedAs=document", json2.approvedAs === "document");
    const fr2 = await prisma.financialRecord.findUnique({
      where: { documentId: doc2.id },
    });
    ok(
      "explicit document-only NEVER creates a FinancialRecord (even on financial profile)",
      fr2 === null
    );

    // ── 4: failed validation leaves nothing behind ────────────────────────
    const doc3 = await makeDoc({ businessId, amount: null, direction: "unknown" });
    createdDocIds.push(doc3.id);
    const res3 = await approvePOST(
      approveReq(token, {
        explicitFinancial: true,
        extracted: { vendorName: VENDOR },
      }),
      ctxFor(doc3.id)
    );
    ok("invalid financial approve rejected with 400", res3.status === 400);
    const d3 = await prisma.document.findUnique({ where: { id: doc3.id } });
    const re3 = await prisma.reviewEvent.count({ where: { documentId: doc3.id } });
    const ex3 = await prisma.extractedData.findUnique({
      where: { documentId: doc3.id },
    });
    ok("rejected approval: status unchanged", d3?.status === "needs_review");
    ok("rejected approval: no ReviewEvent", re3 === 0);
    ok("rejected approval: draft not persisted", ex3?.amount === null);

    // ── 5: duplicate signals on GET ───────────────────────────────────────
    const doc4 = await makeDoc({ businessId, hash: "wave01hash-A" }); // same bytes as doc1
    createdDocIds.push(doc4.id);
    const res4 = await documentGET(
      new Request("http://localhost/api/documents/x", {
        headers: { authorization: `Bearer ${token}` },
      }),
      ctxFor(doc4.id)
    );
    const json4 = (await res4.json()) as {
      duplicateSignals?: Array<{
        level: string;
        documentId: number;
        hasFinancialRecord: boolean;
      }>;
    };
    const signals = json4.duplicateSignals ?? [];
    ok(
      "exact_file duplicate signal detected",
      signals.some((s) => s.level === "exact_file" && s.documentId === doc1.id)
    );
    ok(
      "same_transaction signal carries hasFinancialRecord",
      signals.some((s) => s.documentId === doc1.id && s.hasFinancialRecord)
    );
  } finally {
    // Cleanup synthetic rows (children cascade from Document except scalars).
    await prisma.reviewEvent.deleteMany({
      where: { documentId: { in: createdDocIds } },
    });
    await prisma.extractionSnapshot.deleteMany({
      where: { documentId: { in: createdDocIds } },
    });
    await prisma.financialRecord.deleteMany({
      where: { documentId: { in: createdDocIds } },
    });
    await prisma.extractedData.deleteMany({
      where: { documentId: { in: createdDocIds } },
    });
    await prisma.document.deleteMany({ where: { id: { in: createdDocIds } } });
    await prisma.vendorLearning.deleteMany({
      where: { vendorName: VENDOR },
    });
    console.log(`cleaned up ${createdDocIds.length} synthetic documents`);
  }

  if (failed > 0) process.exit(1);
  console.log("wave01 approve verify passed");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
