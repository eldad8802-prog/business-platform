import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { crmAttachmentsService } from "@/lib/services/crm/crm-attachments.service";

type Ctx = { params: Promise<{ attachmentId: string }> };

/** Delete an attachment. Uploader-only hard delete (enforced in the service). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { attachmentId } = await ctx.params;

    const result = await crmAttachmentsService.deleteAttachment({
      businessId: user.businessId,
      attachmentId: Number(attachmentId),
      actingUserId: user.id,
    });

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
