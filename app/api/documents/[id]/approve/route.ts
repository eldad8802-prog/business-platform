import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { resolveDocumentOutputProfile } from "@/lib/services/documents/output-profile-resolver.service";
import { recordReviewEvent } from "@/lib/services/documents/ledger/correction-ledger.service";
import { assertMonthOpen } from "@/lib/services/accounting/month-close.service";
import { ConflictError } from "@/lib/errors";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const params = await context.params;
    const documentId = Number(params.id);

    if (isNaN(documentId)) {
      return Response.json({ error: "Invalid ID" }, { status: 400 });
    }

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { extractedData: true },
    });

    if (!document) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }

    if (document.businessId !== user.businessId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const wasAlreadyApproved = document.status === "approved";

    const body = (await req.json().catch(() => null)) as
      | null
      | {
          extracted?: {
            amount?: number | null;
            vendorName?: string | null;
            date?: string | null;
            direction?: "expense" | "income" | "unknown" | null;
            category?: string | null;
          };
          explicitFinancial?: boolean;
        };

    if (!body) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const merged = {
      amount:
        body.extracted?.amount ??
        document.extractedData?.amount ??
        null,
      vendorName:
        body.extracted?.vendorName ??
        document.extractedData?.vendorName ??
        null,
      date:
        body.extracted?.date ??
        (document.extractedData?.date ? document.extractedData.date.toISOString() : null) ??
        null,
      direction:
        body.extracted?.direction ??
        (document.extractedData?.direction as
          | "expense"
          | "income"
          | "unknown"
          | null) ??
        null,
      category:
        body.extracted?.category ??
        document.extractedData?.category ??
        null,
      confidenceScore: document.extractedData?.confidenceScore ?? null,
    };

    // Phase A.1 Month-Close guard: approving a document lands a financial record
    // dated to the document's date. If that month is CLOSED, refuse before any
    // write so a settled period cannot gain new financial reality. (Best-effort
    // guard on the resolved target date; other write paths are not yet covered.)
    const guardDateMs = merged.date ? Date.parse(merged.date) : NaN;
    const guardDate = Number.isFinite(guardDateMs)
      ? new Date(guardDateMs)
      : document.createdAt;
    try {
      await assertMonthOpen(prisma, user.businessId, guardDate);
    } catch (guardError) {
      if (guardError instanceof ConflictError) {
        return Response.json(
          { error: guardError.message, code: guardError.code },
          { status: guardError.statusCode }
        );
      }
      throw guardError;
    }

    const profile = await resolveDocumentOutputProfile({
      documentId: document.id,
      businessId: user.businessId,
      ocrText: document.ocrText ?? null,
      documentStatus: document.status,
      extracted: document.extractedData
        ? {
            amount: document.extractedData.amount ?? null,
            vendorName: document.extractedData.vendorName ?? null,
            date: document.extractedData.date ?? null,
            direction: document.extractedData.direction ?? null,
            category: document.extractedData.category ?? null,
            confidenceScore: document.extractedData.confidenceScore ?? null,
          }
        : null,
      allowUnified: false, // IMPORTANT: approve must never run unified
      debug: false,
    });

    const profileId = profile.outputProfile.profileId;

    const allowFinancial =
      profileId === "financial_transaction" ||
      (profileId === "unknown_review" && body.explicitFinancial === true);

    // Update extractedData (idempotent via upsert)
    const extractedData = await prisma.extractedData.upsert({
      where: { documentId },
      create: {
        documentId,
        amount: merged.amount ?? undefined,
        vendorName: merged.vendorName ?? undefined,
        category: merged.category ?? undefined,
        direction: merged.direction ?? undefined,
        date: merged.date ? new Date(merged.date) : undefined,
        confidenceScore: merged.confidenceScore ?? undefined,
      },
      update: {
        amount: merged.amount ?? undefined,
        vendorName: merged.vendorName ?? undefined,
        category: merged.category ?? undefined,
        direction: merged.direction ?? undefined,
        date: merged.date ? new Date(merged.date) : undefined,
      },
    });

    let record:
      | Awaited<ReturnType<typeof prisma.financialRecord.create>>
      | null = null;

    if (allowFinancial) {
      const amount = typeof merged.amount === "number" ? merged.amount : NaN;
      const vendorName = String(merged.vendorName || "").trim();
      const category = String(merged.category || "").trim() || "general";
      const direction =
        merged.direction === "income" || merged.direction === "expense"
          ? merged.direction
          : null;

      const dateMs = merged.date ? Date.parse(merged.date) : NaN;
      const date = Number.isFinite(dateMs) ? new Date(dateMs) : document.createdAt;

      if (!Number.isFinite(amount) || amount <= 0) {
        return Response.json(
          { error: "Missing/invalid amount for financial approval" },
          { status: 400 }
        );
      }
      if (!vendorName) {
        return Response.json(
          { error: "Missing vendorName for financial approval" },
          { status: 400 }
        );
      }
      if (!direction) {
        return Response.json(
          { error: "Missing direction (income/expense) for financial approval" },
          { status: 400 }
        );
      }

      // Phase B — carry already-detected fields from ExtractedData to the
      // approved record (null when not detected). Not user-editable here.
      const vendorTaxId = document.extractedData?.vendorTaxId ?? null;
      const vatAmount = document.extractedData?.vatAmount ?? null;
      const subtotalAmount = document.extractedData?.subtotalAmount ?? null;

      const existingRecord = await prisma.financialRecord.findFirst({
        where: { documentId },
      });

      if (existingRecord) {
        record = await prisma.financialRecord.update({
          where: { id: existingRecord.id },
          data: {
            amount,
            vendorName,
            category,
            direction,
            date,
            vendorTaxId,
            vatAmount,
            subtotalAmount,
          },
        });
      } else {
        record = await prisma.financialRecord.create({
          data: {
            documentId,
            businessId: user.businessId,
            amount,
            vendorName,
            category,
            direction,
            date,
            vendorTaxId,
            vatAmount,
            subtotalAmount,
          },
        });
      }

      // Vendor learning only when we actually create/update a financial record,
      // and only on first approval — avoids usageCount inflation on duplicate approve/retry.
      if (!wasAlreadyApproved) {
        await prisma.vendorLearning.upsert({
          where: {
            businessId_vendorName: {
              businessId: user.businessId,
              vendorName,
            },
          },
          update: {
            usageCount: { increment: 1 },
            category,
            confidence: { increment: 0.02 },
            lastUsedAt: new Date(),
          },
          create: {
            businessId: user.businessId,
            vendorName,
            category,
            confidence: 0.8,
            usageCount: 1,
            isGlobal: false,
          },
        });
      }
    }

    // 🧠 LEARNING (רק לפי עסק — בלי global)
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "approved" },
    });

    // Phase 1A Correction Ledger — additive, write-only, never throws. Reads the
    // original in-memory engine belief (document.extractedData, loaded before the
    // upsert overwrite) and the human-submitted final values.
    await recordReviewEvent({
      documentId,
      businessId: user.businessId,
      reviewerUserId: user.id,
      approvedAs: allowFinancial ? "financial" : "document",
      explicitFinancial: body.explicitFinancial === true,
      profileId,
      belief: document.extractedData
        ? {
            amount: document.extractedData.amount ?? null,
            vendorName: document.extractedData.vendorName ?? null,
            date: document.extractedData.date ?? null,
            category: document.extractedData.category ?? null,
            direction: document.extractedData.direction ?? null,
          }
        : null,
      final: body.extracted ?? {},
    });

    return Response.json({
      success: true,
      approvedAs: allowFinancial ? "financial" : "document",
      record,
      extractedData,
      outputProfile: profile.outputProfile,
    });
  } catch (error) {
    console.error("APPROVE ERROR FULL:", error);

    return Response.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}