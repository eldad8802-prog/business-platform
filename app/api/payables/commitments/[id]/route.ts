import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { getCommitmentDetail } from "@/lib/services/payables/payables-read";
import { updateCommitment } from "@/lib/services/payables/payables.service";
import {
  handlePayablesError,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * GET — one commitment, its installment timeline, its payments and its audit.
 *
 * A commitment belonging to another business is simply not found under this
 * tenant context, so this is a 404 rather than a 403 — answering "forbidden"
 * would confirm the row exists somewhere else.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const commitmentId = parseId(id, "commitment id");

    const detail = await runWithTenantContext({ businessId: user.businessId }, () =>
      getCommitmentDetail({ businessId: user.businessId, commitmentId }),
    );

    return NextResponse.json({ commitment: detail });
  } catch (error) {
    return handlePayablesError(error);
  }
}

/**
 * PATCH — correct what a commitment SAYS, never what it owes.
 *
 * Only the fields the service is willing to change are forwarded, and each one
 * is forwarded only when the caller actually sent it: `undefined` means "leave
 * it alone", while an explicit `null` on the payee means "detach the entity and
 * keep this name". Amounts and schedules are not accepted here at all — they
 * would contradict installments that payments are already allocated against.
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const commitmentId = parseId(id, "commitment id");
    const body = await readJsonBody(req);

    const patch: Parameters<typeof updateCommitment>[0] = {
      businessId: user.businessId,
      commitmentId,
      actorUserId: user.id,
    };
    if (typeof body.title === "string") patch.title = body.title;
    if ("note" in body) patch.note = body.note == null ? null : String(body.note);
    if ("category" in body) {
      patch.category = body.category == null ? null : String(body.category);
    }
    if ("payeeId" in body) {
      patch.payeeId = body.payeeId == null ? null : Number(body.payeeId);
    }
    if ("payeeName" in body) {
      patch.payeeNameSnapshot =
        body.payeeName == null ? null : String(body.payeeName);
    }

    const commitment = await runWithTenantContext({ businessId: user.businessId }, () =>
      updateCommitment(patch),
    );

    return NextResponse.json({ commitment });
  } catch (error) {
    return handlePayablesError(error);
  }
}
