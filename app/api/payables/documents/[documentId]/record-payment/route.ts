import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { recordPaymentFromDocument } from "@/lib/services/payables/payables-reconciliation.service";
import {
  handlePayablesError,
  optionalString,
  parseId,
  readJsonBody,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * POST — the owner says this document IS a payment they made and never recorded.
 *
 * This is the ONLY path where a document becomes an economic event, and it is a
 * separate endpoint from `attach` on purpose: the two answers to "what is this
 * receipt?" have completely different consequences, and one endpoint with a
 * boolean would eventually be called with the wrong one.
 *
 * A score cannot reach here. Only a person can.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { documentId } = await context.params;
    const id = parseId(documentId, "document id");
    const body = await readJsonBody(req);

    const commitmentId = Number(body.commitmentId);
    if (!Number.isInteger(commitmentId) || commitmentId <= 0) {
      throw new ValidationError("commitmentId is required");
    }

    let installmentIds: number[] | null = null;
    if (body.installmentIds != null) {
      if (!Array.isArray(body.installmentIds) || body.installmentIds.length === 0) {
        throw new ValidationError("installmentIds must be a non-empty array when given");
      }
      installmentIds = body.installmentIds.map((raw) => {
        const num = Number(raw);
        if (!Number.isInteger(num) || num <= 0) {
          throw new ValidationError("installmentIds must all be positive integers");
        }
        return num;
      });
    }

    const method = typeof body.method === "string" ? body.method : "BANK_TRANSFER";

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      recordPaymentFromDocument({
        businessId: user.businessId,
        documentId: id,
        commitmentId,
        installmentIds,
        method,
        actorUserId: user.id,
        idempotencyKey: optionalString(body, "idempotencyKey"),
        note: optionalString(body, "note"),
      }),
    );

    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
