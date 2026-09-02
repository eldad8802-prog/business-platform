import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  CUSTOMER_BILLING_IDENTITY_SELECT,
  parseCustomerIdentityPayload,
} from "@/lib/billing/customer-tax-identity";

function parseCustomerId(value: string): number {
  const num = Number(value);
  if (!num || Number.isNaN(num) || !Number.isInteger(num) || num <= 0) {
    throw new ValidationError("Invalid customer id");
  }
  return num;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    const customerId = parseCustomerId(id);

    // CUTOVER-2A: Customer is one of the five P4-B pilot tables. A context-less
    // read returns null under FORCE RLS, which this handler would report as
    // "Customer not found" for a customer the tenant owns.
    const customer = await tenantTx(user.businessId, (tx) =>
      tx.customer.findFirst({
        where: { id: customerId, businessId: user.businessId },
        select: CUSTOMER_BILLING_IDENTITY_SELECT,
      })
    );

    if (!customer) {
      throw new NotFoundError("Customer not found");
    }

    return NextResponse.json({ customer }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { id } = await context.params;
    const customerId = parseCustomerId(id);

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const identity = parseCustomerIdentityPayload(body);
    if (Object.keys(identity).length === 0) {
      throw new ValidationError("No updatable fields provided");
    }

    // Ownership check and update in ONE tenant transaction.
    const customer = await tenantTx(user.businessId, async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { id: customerId, businessId: user.businessId },
        select: { id: true },
      });
      if (!existing) return null;

      return tx.customer.update({
        where: { id: customerId },
        data: identity,
        select: CUSTOMER_BILLING_IDENTITY_SELECT,
      });
    });

    if (!customer) {
      throw new NotFoundError("Customer not found");
    }

    return NextResponse.json({ customer }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
