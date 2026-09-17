import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { runWithTenantContext } from "@/lib/tenant/context";
import { recordManualPayment } from "@/lib/services/payables/payables.service";
import {
  amountString,
  handlePayablesError,
  optionalString,
  readJsonBody,
  requiredDate,
} from "@/lib/services/payables/payables-http";

export const runtime = "nodejs";

/**
 * The instruments a PAYABLE may be settled with.
 *
 * Deliberately narrower than the full `PaymentMethod` enum in one direction and
 * wider in another: `DIRECT_DEBIT` and `STANDING_ORDER` are ordinary here, and
 * are the very values Billing refuses on an issued document because that enum
 * doubles as a מבנה אחיד D120.1306 fiscal code. Outbound money and an issued
 * receipt are different questions, and this list is the outbound answer.
 */
const PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
  "CREDIT_CARD",
  "CHECK",
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;

/**
 * POST — record a payment the owner has actually made, and apply it.
 *
 * This is an OBSERVED economic event, never a plan and never an intention. The
 * service refuses to over-apply it: a surplus stays unallocated and is reported
 * back, rather than being quietly spread onto some other installment.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const body = await readJsonBody(req);

    const commitmentId = Number(body.commitmentId);
    if (!Number.isInteger(commitmentId) || commitmentId <= 0) {
      throw new ValidationError("commitmentId is required");
    }

    const method = body.method;
    if (
      typeof method !== "string" ||
      !(PAYMENT_METHODS as readonly string[]).includes(method)
    ) {
      throw new ValidationError("method must be one of " + PAYMENT_METHODS.join(", "));
    }

    // Absent means "apply in due-date order", which is the common case. An
    // explicit list is how the owner spreads one payment across chosen
    // installments, so an empty array is a mistake worth naming rather than
    // silently treating as "all of them".
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

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      recordManualPayment({
        businessId: user.businessId,
        actorUserId: user.id,
        commitmentId,
        amount: amountString(body, "amount"),
        paidAt: requiredDate(body, "paidAt"),
        method,
        externalReference: optionalString(body, "externalReference"),
        note: optionalString(body, "note"),
        idempotencyKey: optionalString(body, "idempotencyKey"),
        installmentIds,
      }),
    );

    // `replayed` is surfaced, not hidden: the caller asked twice and must be
    // able to tell that the second answer is the first payment, not a new one.
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
