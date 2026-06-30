import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  authorizePaymentAction,
  PAYMENT_ACTIONS,
} from "@/lib/services/payments/payment-authorization";
import { createPaymentRequest } from "@/lib/services/payments/payment-request.service";
import { paymentRequestDeps } from "@/lib/services/payments/payments.deps";
import {
  toPaymentRequestApi,
  toPaymentRequestListItemApi,
} from "@/lib/services/payments/payment-api.serializer";
import type {
  ListPaymentRequestsOptions,
  PaymentRequestStatus,
} from "@/lib/services/payments/payments.types";

export const runtime = "nodejs";

const REQUEST_STATUSES: readonly PaymentRequestStatus[] = [
  "PENDING",
  "PAID",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
];

function asOptionalPositiveInt(value: unknown, field: string): number | null {
  if (value == null || value === "") return null;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return num;
}

function parseStatus(value: string | null): PaymentRequestStatus | undefined {
  if (!value) return undefined;
  if (!REQUEST_STATUSES.includes(value as PaymentRequestStatus)) {
    throw new ValidationError("invalid status filter");
  }
  return value as PaymentRequestStatus;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.CREATE_CHARGE);

    let body: Record<string, unknown> = {};
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }

    if (body.amount == null) {
      throw new ValidationError("amount is required");
    }

    const result = await createPaymentRequest(
      {
        businessId: actor.businessId,
        actorUserId: actor.userId,
        amount: body.amount as string | number,
        currency: typeof body.currency === "string" ? body.currency : undefined,
        description:
          typeof body.description === "string" ? body.description : null,
        customerId: asOptionalPositiveInt(body.customerId, "customerId"),
        billingDocumentId: asOptionalPositiveInt(
          body.billingDocumentId,
          "billingDocumentId"
        ),
        expiresAt:
          typeof body.expiresAt === "string" && body.expiresAt
            ? new Date(body.expiresAt)
            : null,
      },
      paymentRequestDeps()
    );

    return NextResponse.json(toPaymentRequestApi(result.paymentRequest), {
      status: 201,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    const actor = authorizePaymentAction(user, PAYMENT_ACTIONS.VIEW_TRANSACTIONS);

    const { searchParams } = req.nextUrl;
    const limitRaw = searchParams.get("limit");
    let limit: number | undefined;
    if (limitRaw != null && limitRaw !== "") {
      const num = Number(limitRaw);
      if (!Number.isInteger(num) || num <= 0 || num > 500) {
        throw new ValidationError("limit must be an integer between 1 and 500");
      }
      limit = num;
    }

    const options: ListPaymentRequestsOptions = {
      status: parseStatus(searchParams.get("status")),
      customerId:
        asOptionalPositiveInt(searchParams.get("customerId"), "customerId") ??
        undefined,
      billingDocumentId:
        asOptionalPositiveInt(
          searchParams.get("billingDocumentId"),
          "billingDocumentId"
        ) ?? undefined,
      limit,
    };

    const records = await paymentRequestDeps().store.listPaymentRequests(
      actor.businessId,
      options
    );

    return NextResponse.json(
      { requests: records.map(toPaymentRequestListItemApi) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}
