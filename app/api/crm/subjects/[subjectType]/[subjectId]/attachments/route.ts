import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { crmAttachmentsService } from "@/lib/services/crm/crm-attachments.service";

export const runtime = "nodejs";
export const maxDuration = 30;

type Ctx = { params: Promise<{ subjectType: string; subjectId: string }> };

/** List attachments for a CRM subject (CUSTOMER | SUPPLIER), newest-first, capped at 100. */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { subjectType, subjectId } = await ctx.params;

    const attachments = await crmAttachmentsService.listAttachments({
      businessId: user.businessId,
      subjectType,
      subjectId: Number(subjectId),
      actingUserId: user.id,
    });

    return NextResponse.json({ attachments }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/** Upload one file (multipart/form-data, field "file") to a CRM subject. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    // Write path → fail-closed rate limit (controlled 503 on a backend blip).
    const decision = await checkRateLimit({
      bucket: "CRM_ATTACHMENT_UPLOAD",
      user: user.id,
      business: user.businessId,
    });
    if (!decision.allowed) {
      return buildRateLimitResponse(decision);
    }

    const { subjectType, subjectId } = await ctx.params;

    const formData = await req.formData();
    const files = formData.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      throw new ValidationError("לא נבחר קובץ");
    }
    if (files.length > 1) {
      throw new ValidationError("ניתן להעלות קובץ אחד בכל פעם");
    }
    const file = files[0];

    const buffer = Buffer.from(await file.arrayBuffer());
    const attachment = await crmAttachmentsService.uploadAttachment({
      businessId: user.businessId,
      subjectType,
      subjectId: Number(subjectId),
      uploadedByUserId: user.id,
      buffer,
      originalFileName: file.name,
      mimeType: file.type,
    });

    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
