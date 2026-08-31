import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getLeadCard } from "@/lib/services/crm/lead-card.read-model";
import { leadService } from "@/lib/services/crm/lead.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

/**
 * Turn a conversation into a lead — the real action.
 *
 * Until W2 the inbox's "צור ליד" chip only pasted a sentence into the composer,
 * so the owner's intent evaporated the moment they navigated away. This
 * endpoint is what that chip now calls.
 *
 * IDEMPOTENT by construction, which matters because an owner will tap it twice:
 *   - the conversation already points at a lead      → 200, that lead
 *   - the contact already has an OPEN lead           → 200, linked to it
 *   - otherwise                                      → 201, a new lead
 *
 * Never two leads for one thread, and never a second lead for a contact who
 * already has a live one. The response is the full lead card, so the caller
 * renders the server's answer rather than guessing.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const conversationId = Number(id);
    const businessId = user.businessId;

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    // ONE tenant transaction: resolve-or-create, link, emit events, and read the
    // card back. The response is therefore the committed state by construction.
    const { card, outcome } = await runWithTenantContext({ businessId }, () =>
      withTenantTransaction(async (tx) => {
        const result = await leadService.createFromConversation(
          {
            businessId,
            conversationId,
            name: (body.name as string | null | undefined) ?? null,
          },
          { tx }
        );
        const card = await getLeadCard(
          { businessId, leadId: result.lead.id },
          { tx }
        );
        return { card, outcome: result.outcome };
      })
    );

    return NextResponse.json(
      { ...card, outcome },
      { status: outcome === "created" ? 201 : 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
