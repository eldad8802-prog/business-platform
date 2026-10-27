import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { crmNotesService } from "@/lib/services/crm/crm-notes.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

type Ctx = { params: Promise<{ subjectType: string; subjectId: string }> };

/** List notes for a CRM subject (CUSTOMER | SUPPLIER | LEAD), newest-first, one page (100) at a time + hasMore + total. */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { subjectType, subjectId } = await ctx.params;

    // `before` = the id of the last note the caller already shows (next page). Anything but a
    // positive integer is ignored — the first page — never an error and never a raw value in a query.
    const beforeRaw = Number(new URL(req.url).searchParams.get("before"));
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;

    const page = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          crmNotesService.listNotesPage(
            {
              businessId: user.businessId,
              subjectType,
              subjectId: Number(subjectId),
              actingUserId: user.id,
              before,
            },
            { tx }
          )
        )
    );

    return NextResponse.json(page, { status: 200 });
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
