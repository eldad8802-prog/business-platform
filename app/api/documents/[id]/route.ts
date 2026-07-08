import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { resolveDocumentOutputProfile } from "@/lib/services/documents/output-profile-resolver.service";
import { deleteDocumentObjectQuiet } from "@/lib/services/documents/document-storage.service";

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

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return Response.json({ error: "לא מחובר" }, { status: 401 });
    }

    const params = await context.params;
    const id = Number(params.id);

    if (isNaN(id)) {
      return Response.json({ error: "מזהה מסמך לא תקין" }, { status: 400 });
    }

    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true, businessId: true, fileUrl: true },
    });

    if (!document) {
      return Response.json({ error: "המסמך לא נמצא" }, { status: 404 });
    }

    // Cross-tenant guard: only the owning business may delete the document.
    if (document.businessId !== user.businessId) {
      return Response.json({ error: "אין הרשאה" }, { status: 403 });
    }

    // Deleting the Document cascades its ExtractedData and, if it was approved,
    // its FinancialRecord. The email/WhatsApp import rows are kept as an audit
    // trail (their documentId is set to null by the optional FK).
    await prisma.document.delete({ where: { id } });

    // Best-effort removal of the stored source file (no-op for legacy
    // placeholder URLs that don't match the stored-object naming scheme).
    await deleteDocumentObjectQuiet(user.businessId, String(document.fileUrl ?? ""));

    return Response.json({ success: true });
  } catch (error) {
    console.error("DELETE DOCUMENT ERROR:", error);

    return Response.json(
      { error: "שגיאה במחיקת המסמך. נסה שוב מאוחר יותר." },
      { status: 500 }
    );
  }
}