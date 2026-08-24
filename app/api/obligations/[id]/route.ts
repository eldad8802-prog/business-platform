import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { updateObligation } from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { toObligationApi } from "@/lib/services/obligations/obligation-api.serializer";
import type { RecurrenceCadence } from "@/lib/services/obligations/obligations.types";

export const runtime = "nodejs";

const RECURRENCE_VALUES: readonly RecurrenceCadence[] = [
  "NONE",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

export function parseObligationId(value: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid obligation id");
  }
  return num;
}

/** Update an open obligation's essentials. */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const { id } = await context.params;
    const obligationId = parseObligationId(id);

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    const input: Parameters<typeof updateObligation>[2] = {};
    if (body.obligeeName !== undefined) input.obligeeName = String(body.obligeeName);
    if (body.amount !== undefined) input.amount = body.amount as string | number;
    if (body.currency !== undefined) input.currency = String(body.currency);
    if (body.dueAt !== undefined) {
      const date = new Date(String(body.dueAt));
      if (Number.isNaN(date.getTime())) {
        throw new ValidationError("dueAt must be a valid date");
      }
      input.dueAt = date;
    }
    if (body.recurrence !== undefined) {
      if (
        typeof body.recurrence !== "string" ||
        !RECURRENCE_VALUES.includes(body.recurrence as RecurrenceCadence)
      ) {
        throw new ValidationError("invalid recurrence cadence");
      }
      input.recurrence = body.recurrence as RecurrenceCadence;
    }
    if (body.note !== undefined) {
      input.note = body.note == null ? null : String(body.note);
    }

    const updated = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          updateObligation(
            user.businessId,
            obligationId,
            input,
            obligationServiceDeps({ tx })
          )
        )
    );

    return NextResponse.json(toObligationApi(updated), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
