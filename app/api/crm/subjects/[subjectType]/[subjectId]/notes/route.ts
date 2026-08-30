import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { crmNotesService } from "@/lib/services/crm/crm-notes.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

type Ctx = { params: Promise<{ subjectType: string; subjectId: string }> };

/** List notes for a CRM subject (CUSTOMER | SUPPLIER | LEAD), newest-first, capped at 100. */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { subjectType, subjectId } = await ctx.params;

    const notes = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          crmNotesService.listNotes(
            {
              businessId: user.businessId,
              subjectType,
              subjectId: Number(subjectId),
              actingUserId: user.id,
            },
            { tx }
          )
        )
    );

    return NextResponse.json({ notes }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/** Add a note to a CRM subject. Body: { body }. */
export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { subjectType, subjectId } = await ctx.params;

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
          crmNotesService.createNote(
            {
              businessId: user.businessId,
              subjectType,
              subjectId: Number(subjectId),
              body: payload.body as string,
              createdByUserId: user.id,
            },
            { tx }
          )
        )
    );

    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
