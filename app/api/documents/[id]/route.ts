import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { resolveDocumentOutputProfile } from "@/lib/services/documents/output-profile-resolver.service";
import { findDuplicateSignals } from "@/lib/services/documents/duplicate-signals.service";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return Response.json({ error: "לא מחובר" }, { status: 401 });
    }

    const params = await context.params; // 🔥 חשוב
    const id = Number(params.id);

    if (isNaN(id)) {
      return Response.json(
        { error: "מזהה מסמך לא תקין" },
        { status: 400 }
      );
    }

    const document = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        businessId: true,
        fileUrl: true,
        source: true,
        mimeType: true,
        status: true,
        createdAt: true,
        ocrText: true,
        extractedData: true,
        financialRecord: { select: { id: true } },
      },
    });

    if (!document) {
      return Response.json(
        { error: "המסמך לא נמצא" },
        { status: 404 }
      );
    }

    if (document.businessId !== user.businessId) {
      return Response.json({ error: "אין הרשאה" }, { status: 403 });
    }

    const debug =
      process.env.NODE_ENV !== "production" &&
      new URL(req.url).searchParams.get("debugOutputProfile") === "1";

    const resolved = await resolveDocumentOutputProfile({
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
      allowUnified: false,
      debug,
    });

    // Duplicate-defense WARN tier — never blocks the review, degrades to [].
    const duplicateSignals = await findDuplicateSignals({
      businessId: user.businessId,
      documentId: document.id,
    });

    return Response.json({
      success: true,
      document: {
        id: document.id,
        businessId: document.businessId,
        fileUrl: document.fileUrl,
        source: document.source,
        mimeType: document.mimeType,
        status: document.status,
        createdAt: document.createdAt.toISOString(),
      },
      extracted: document.extractedData,
      // Approved-mutation guard: lets the review UI say up front that this
      // document's financial record is locked (server enforces regardless).
      financialRecorded: Boolean(document.financialRecord),
      duplicateSignals,
      outputProfile: resolved.outputProfile,
      outputProfileSource: resolved.outputProfileSource,
      outputProfileComputedAt: resolved.outputProfileComputedAt,
      ...(resolved.outputProfileDebug ? { outputProfileDebug: resolved.outputProfileDebug } : {}),
    });
  } catch (error) {
    console.error("GET DOCUMENT ERROR:", error);

    return Response.json(
      { error: "שגיאה בטעינת המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}