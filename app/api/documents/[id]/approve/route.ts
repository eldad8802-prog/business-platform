import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { runTenantJob } from "@/lib/tenant/job";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { resolveDocumentOutputProfile } from "@/lib/services/documents/output-profile-resolver.service";
import { buildReviewEventCreateData } from "@/lib/services/documents/ledger/correction-ledger.service";
import { normalizeVendorForLearning } from "@/lib/services/documents/vendor-normalization.service";
import { runShadowMaterialization } from "@/lib/business-memory/shadow";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return Response.json({ error: "לא מחובר" }, { status: 401 });
    }

    const params = await context.params;
    const documentId = Number(params.id);

    if (isNaN(documentId)) {
      return Response.json({ error: "מזהה מסמך לא תקין" }, { status: 400 });
    }

    const document = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.document.findFirst({
            where: { id: documentId, businessId: user.businessId },
            include: { extractedData: true },
          })
        )
    );

    if (!document) {
      return Response.json({ error: "המסמך לא נמצא" }, { status: 404 });
    }

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
      return Response.json({ error: "בקשה לא תקינה" }, { status: 400 });
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
          | null
          | undefined) ??
        null,
      category:
        body.extracted?.category ??
        document.extractedData?.category ??
        null,
      confidenceScore: document.extractedData?.confidenceScore ?? null,
    };

    const profile = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        resolveDocumentOutputProfile({
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
        })
    );

    const profileId = profile.outputProfile.profileId;

    // Financial approval follows the USER'S explicit intent first, the profile
    // second. `explicitFinancial:true` allows a financial approval from ANY
    // profile (the human is the final authority; the machine belief is still
    // recorded on the ReviewEvent via profileId). `explicitFinancial:false` is
    // an explicit "save as informational document" and is honored even when the
    // profile says financial — so a document-only save can never silently
    // create a FinancialRecord from stored values. Only a legacy caller that
    // sends no intent falls back to the profile alone.
    const allowFinancial =
      body.explicitFinancial === true ||
      (profileId === "financial_transaction" &&
        body.explicitFinancial !== false);

    // Financial validations run BEFORE any write: a rejected approval must not
    // leave the user's draft persisted on ExtractedData (pre-fix, the upsert
    // ran first and a 400 still mutated stored state).
    let financial: {
      amount: number;
      vendorName: string;
      category: string;
      direction: "income" | "expense";
      date: Date;
    } | null = null;

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
          { error: "חסר סכום תקין לאישור כספי" },
          { status: 400 }
        );
      }
      if (!vendorName) {
        return Response.json(
          { error: "חסר שם ספק לאישור כספי" },
          { status: 400 }
        );
      }
      if (!direction) {
        return Response.json(
          { error: "חסר כיוון (הכנסה/הוצאה) לאישור כספי" },
          { status: 400 }
        );
      }

      financial = { amount, vendorName, category, direction, date };
    }

    // APPROVED-MUTATION GUARD (Wave 0+1 invariant): approved financial truth
    // cannot be silently overwritten. Once a document is approved AND has a
    // FinancialRecord:
    //   - a document-only save is rejected (it would leave a live record
    //     contradicting the review verdict);
    //   - a financial re-approval with DIFFERENT values is rejected — value
    //     changes will arrive only as an explicit, audited Correction (a later
    //     wave);
    //   - an IDENTICAL financial re-approval stays allowed (idempotent retry).
    // A document approved WITHOUT a record (informational save) remains fully
    // re-approvable — that is the rescue path for misfiled receipts.
    if (document.status === "approved") {
      const existingRecord = await prisma.financialRecord.findUnique({
        where: { documentId },
      });
      if (existingRecord) {
        const sameDay = (a: Date, b: Date) =>
          a.getUTCFullYear() === b.getUTCFullYear() &&
          a.getUTCMonth() === b.getUTCMonth() &&
          a.getUTCDate() === b.getUTCDate();
        const unchanged =
          financial !== null &&
          existingRecord.amount === financial.amount &&
          existingRecord.vendorName === financial.vendorName &&
          existingRecord.direction === financial.direction &&
          existingRecord.category === financial.category &&
          sameDay(existingRecord.date, financial.date);
        if (!unchanged) {
          return Response.json(
            {
              error:
                "המסמך כבר אושר ונרשם כספית. שינוי הרישום יתאפשר רק דרך תיקון מבוקר.",
              code: "approved_financial_locked",
            },
            { status: 409 }
          );
        }
      }
    }

    // Belief is the engine extraction as loaded ABOVE (before the upsert
    // overwrite below) — this ordering is load-bearing for the learning ledger:
    // re-reading after the upsert would destroy the belief-vs-final signal.
    const reviewEventData = buildReviewEventCreateData({
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

    // ATOMIC APPROVAL (Wave 1A): the financially-coupled state — ExtractedData,
    // FinancialRecord, Document.status and the owner-decision ReviewEvent —
    // commits in ONE tenant transaction or not at all. A user-visible financial
    // approval can no longer land without its FinancialRecord, and approval
    // evidence can no longer be silently lost while the approval "succeeds".
    // VendorLearning and the Business Memory shadow stay OUTSIDE the
    // transaction on purpose: learning is best-effort and must never roll back
    // financial truth (and the shadow contract requires evidence to be durably
    // committed before it runs).
    const txResult = await runTenantJob({ businessId: user.businessId }, () =>
      withTenantTransaction(async (tx) => {
        const extractedData = await tx.extractedData.upsert({
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

        let record: unknown = null;
        if (financial) {
          record = await tx.financialRecord.upsert({
            where: { documentId },
            create: {
              documentId,
              businessId: user.businessId,
              amount: financial.amount,
              vendorName: financial.vendorName,
              category: financial.category,
              direction: financial.direction,
              date: financial.date,
            },
            update: {
              amount: financial.amount,
              vendorName: financial.vendorName,
              category: financial.category,
              direction: financial.direction,
              date: financial.date,
            },
          });
        }

        // Conditional transition — atomic first-approval detection. Replaces
        // the racy read-modify-write on document.status that could double-count
        // vendor learning under concurrent approves.
        const transitioned = await tx.document.updateMany({
          where: {
            id: documentId,
            businessId: user.businessId,
            status: { not: "approved" },
          },
          data: { status: "approved" },
        });

        await tx.reviewEvent.create({ data: reviewEventData });

        return {
          extractedData,
          record,
          firstApproval: transitioned.count === 1,
        };
      })
    );

    // 🧠 LEARNING — after commit, best-effort, never fails the approval.
    // Only on a financial approval, and only on the FIRST approval of this
    // document (atomic guard above) — avoids usageCount inflation on duplicate
    // approve/retry. See docs/documents-learning-mechanism-architecture-v1.md §5.
    if (financial && txResult.firstApproval) {
      try {
        const vendorNameNormalized =
          normalizeVendorForLearning(financial.vendorName).normalizedKey;
        await runWithTenantContext({ businessId: user.businessId }, () =>
          withTenantTransaction((tx) => tx.vendorLearning.upsert({
          where: {
            businessId_vendorName: {
              businessId: user.businessId,
              vendorName: financial.vendorName,
            },
          },
          update: {
            usageCount: { increment: 1 },
            category: financial.category,
            confidence: { increment: 0.02 },
            lastUsedAt: new Date(),
            vendorNameNormalized,
          },
          create: {
            businessId: user.businessId,
            vendorName: financial.vendorName,
            vendorNameNormalized,
            category: financial.category,
            confidence: 0.8,
            usageCount: 1,
            isGlobal: false,
          },
          }))
        );
      } catch (vendorLearningError) {
        console.error(
          "[approve] vendorLearning.upsert failed (non-fatal):",
          vendorLearningError
        );
      }
    }

    // Business Memory · DARK SHADOW (SHADOW-2). Post-canonical-evidence, best-effort, default-OFF
    // (BUSINESS_MEMORY_SHADOW). When enabled it awaits the Orchestrator once and isolates every outcome
    // — it never throws, never retries, never touches VendorLearning, and cannot change this approval.
    // The transaction above committed, so the owner-decision evidence is durably persisted.
    await runShadowMaterialization({
      businessId: user.businessId,
      vendorInput: body.extracted?.vendorName ?? null,
      evidencePersisted: true,
    });

    return Response.json({
      success: true,
      approvedAs: allowFinancial ? "financial" : "document",
      record: txResult.record,
      extractedData: txResult.extractedData,
      outputProfile: profile.outputProfile,
    });
  } catch (error) {
    console.error("APPROVE ERROR FULL:", error);

    return Response.json(
      { error: "שגיאה באישור המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}
