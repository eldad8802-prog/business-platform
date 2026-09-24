import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { tenantTx } from "@/lib/tenant/tenant-tx";
import {
  CUSTOMER_BILLING_IDENTITY_SELECT,
  parseCustomerIdentityPayload,
} from "@/lib/billing/customer-tax-identity";
import { changedFields, recordSensor } from "@/lib/sensors/record-sensor";

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
        // legalName/taxId/taxIdType are read only so the sensor can report WHICH changed.
        select: { id: true, legalName: true, taxId: true, taxIdType: true },
      });
      if (!existing) return null;

      const updated = await tx.customer.update({
        where: { id: customerId },
        data: identity,
        select: CUSTOMER_BILLING_IDENTITY_SELECT,
      });

      // M5.5 — field NAMES only, never the tax identity values.
      const fields = changedFields(
        { legalName: existing.legalName, taxId: existing.taxId, taxIdType: existing.taxIdType },
        {
          ...("legalName" in identity ? { legalName: updated.legalName } : {}),
          ...("taxId" in identity ? { taxId: updated.taxId } : {}),
          ...("taxIdType" in identity ? { taxIdType: updated.taxIdType } : {}),
        },
        ["legalName", "taxId", "taxIdType"]
      );
      if (fields.length > 0) {
        await recordSensor(
          {
            businessId: user.businessId,
            sensor: "CUSTOMER_TAX_IDENTITY_CHANGED",
            entityId: customerId,
            actor: { type: "OWNER_USER", userId: user.id },
            source: "OWNER_UI",
            payload: { fields },
          },
          { tx }
        );
      }
      return updated;
    });

    if (!customer) {
      throw new NotFoundError("Customer not found");
    }

    return NextResponse.json({ customer }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
