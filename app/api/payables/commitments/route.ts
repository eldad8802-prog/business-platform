import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { createCommitment } from "@/lib/services/payables/payables.service";
import { listCommitments } from "@/lib/services/payables/payables-read";
import {
  amountString,
  handlePayablesError,
  optionalPositiveInt,
  optionalString,
  readJsonBody,
  requiredDate,
  requiredString,
} from "@/lib/services/payables/payables-http";
import type {
  CommitmentScheduleKindValue,
  RecurrenceCadenceValue,
} from "@/lib/services/payables/payables-core";

export const runtime = "nodejs";

const SCHEDULE_KINDS: readonly CommitmentScheduleKindValue[] = [
  "ONE_OFF",
  "RECURRING",
  "INSTALLMENT_PLAN",
];
const CADENCES: readonly RecurrenceCadenceValue[] = [
  "NONE",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
];

/** GET — the owner's commitments, ordered by what needs attention first. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const scope = req.nextUrl.searchParams.get("scope") === "all" ? "all" : "open";

    const rows = await runWithTenantContext({ businessId: user.businessId }, () =>
      listCommitments({ businessId: user.businessId, scope }),
    );

    return NextResponse.json({ commitments: rows });
  } catch (error) {
    return handlePayablesError(error);
  }
}

/**
 * POST — recognise a new commitment, with the installments it implies.
 *
 * The schedule kind decides which amount field is meaningful, and the service
 * refuses the contradictory combinations (a RECURRING commitment carrying a
 * total, a finite plan whose installments do not sum to it). This handler only
 * shapes the request; it decides nothing about money.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const body = await readJsonBody(req);

    const scheduleKind = body.scheduleKind;
    if (
      typeof scheduleKind !== "string" ||
      !SCHEDULE_KINDS.includes(scheduleKind as CommitmentScheduleKindValue)
    ) {
      throw new ValidationError("scheduleKind must be one of " + SCHEDULE_KINDS.join(", "));
    }

    const recurrenceRaw = body.recurrence;
    if (
      recurrenceRaw != null &&
      (typeof recurrenceRaw !== "string" ||
        !CADENCES.includes(recurrenceRaw as RecurrenceCadenceValue))
    ) {
      throw new ValidationError("invalid recurrence cadence");
    }

    const kind = scheduleKind as CommitmentScheduleKindValue;

    const commitment = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        createCommitment({
          businessId: user.businessId,
          actorUserId: user.id,
          title: requiredString(body, "title"),
          category: optionalString(body, "category"),
          payeeId: optionalPositiveInt(body, "payeeId"),
          // Free text stays legal: a commitment can name a payee the business
          // has never turned into an entity, exactly as the Tier-1 rule allows.
          payeeNameSnapshot: optionalString(body, "payeeName"),
          currency: optionalString(body, "currency") ?? undefined,
          scheduleKind: kind,
          totalAmount: kind === "RECURRING" ? null : amountString(body, "totalAmount"),
          recurringAmount:
            kind === "RECURRING" ? amountString(body, "recurringAmount") : null,
          installmentCount:
            kind === "INSTALLMENT_PLAN" ? optionalPositiveInt(body, "installmentCount") : null,
          recurrence: (recurrenceRaw as RecurrenceCadenceValue | undefined) ?? undefined,
          firstDueAt: requiredDate(body, "firstDueAt"),
          note: optionalString(body, "note"),
        }),
    );

    return NextResponse.json({ commitment }, { status: 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
