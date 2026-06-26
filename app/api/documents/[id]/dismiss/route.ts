import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

// POST /api/documents/[id]/dismiss
//
// Soft archive / dismiss for irrelevant documents (spam, duplicates, noise).
// This is a LIFECYCLE transition, not a deletion: the Document row and its file
// are kept for audit. A dismissed document:
//   - leaves the verification queue (status !== "needs_review")
//   - is not counted as an open task
//   - never produces a FinancialRecord, so it never enters the accountant pack
//
// Guard: an already-approved document owns a financial record and must NOT be
// silently dismissed — reversing settled financial reality is a different,
// explicit flow. Dismiss is only for documents that have not been approved.
//
// `{ undo: true }` reverses a dismissal back into the review queue (simple,
// safe undo — no separate feature surface).

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

    if (Number.isNaN(documentId)) {
      return Response.json({ error: "Invalid ID" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as
      | null
      | { undo?: boolean };
    const isUndo = body?.undo === true;

    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, businessId: true, status: true },
    });

    if (!document) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }

    if (document.businessId !== user.businessId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    if (isUndo) {
      // Only a dismissed document can be restored; anything else is a no-op error
      // so we never resurrect/alter an approved record by accident.
      if (document.status !== "dismissed") {
        return Response.json(
          { error: "רק מסמך שהוסר מהתור ניתן להחזרה", code: "not_dismissed" },
          { status: 409 }
        );
      }
      await prisma.document.update({
        where: { id: documentId },
        data: { status: "needs_review" },
      });
      return Response.json({ success: true, status: "needs_review" });
    }

    if (document.status === "approved") {
      return Response.json(
        {
          error:
            "לא ניתן להסיר מסמך שכבר אושר כרשומה פיננסית. ביטול רשומה מאושרת הוא תהליך נפרד.",
          code: "already_approved",
        },
        { status: 409 }
      );
    }

    if (document.status === "dismissed") {
      // Idempotent: already dismissed.
      return Response.json({ success: true, status: "dismissed" });
    }

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "dismissed" },
    });

    return Response.json({ success: true, status: "dismissed" });
  } catch (error) {
    console.error("DISMISS ERROR:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
