import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { crmNotesService } from "@/lib/services/crm/crm-notes.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

type Ctx = { params: Promise<{ noteId: string }> };

/** Edit a note's body. Author-only (enforced in the service). Subject/author/business are immutable. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { noteId } = await ctx.params;

    let payload: Record<string, unknown> = {};
    try {
      payload = (await req.json()) as Record<string, unknown>;
    } catch {
      payload = {};
    }

    const note = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          crmNotesService.updateNote(
            {
              businessId: user.businessId,
              noteId: Number(noteId),
              actingUserId: user.id,
              body: payload.body as string,
            },
            { tx }
          )
        )
    );

    return NextResponse.json({ note }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/** Delete a note. Author-only hard delete (enforced in the service). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { noteId } = await ctx.params;

    const result = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          crmNotesService.deleteNote(
            {
              businessId: user.businessId,
              noteId: Number(noteId),
              actingUserId: user.id,
            },
            { tx }
          )
        )
    );

    return NextResponse.json({ success: true, ...result }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
