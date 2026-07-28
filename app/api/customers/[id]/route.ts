import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { getCustomerCard } from "@/lib/services/crm/customer-card.read-model";
import { customerService } from "@/lib/services/crm/customer.service";

/** Basic CRM fields editable from the card. Tax identity stays in Billing. */
const BASIC_FIELDS = ["name", "phone", "email", "city", "notes"] as const;

/** Project a Customer row to the same `customer` shape the card read-model exposes. */
function toCardCustomer(c: {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    city: c.city,
    legalName: c.legalName,
    taxId: c.taxId,
    taxIdType: c.taxIdType,
    notes: c.notes,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Customer Card read-model. Returns the customer plus its REAL related rows
 * (billing documents, payment requests, conversations, appointments), all
 * tenant-scoped. No fabricated status or financial rollups.
 */
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

    const card = await getCustomerCard({
      businessId: user.businessId,
      customerId: Number(id),
    });

    return NextResponse.json(card, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * PATCH is split by contract to keep the two write paths atomic and separate:
 *  - a LIFECYCLE request carries `isActive` only → customerService.setCustomerActiveStatus
 *  - an EDIT request carries basic fields only (name/phone/email/city/notes) →
 *    customerService.updateCustomerBasics
 * Mixing lifecycle + basics in one request is rejected (no non-atomic multi-service
 * update). Tax identity (legalName/taxId/taxIdType) stays owned by
 * PATCH /api/billing/customers/[id]. Both paths are tenant-guarded in the service.
 */
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
    const customerId = Number(id);

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const hasLifecycle = Object.prototype.hasOwnProperty.call(body, "isActive");
    const basics: Record<string, unknown> = {};
    for (const key of BASIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        basics[key] = body[key];
      }
    }
    const hasBasics = Object.keys(basics).length > 0;

    if (hasLifecycle && hasBasics) {
      throw new ValidationError(
        "Lifecycle (isActive) and basic fields cannot be updated in the same request"
      );
    }

    const updated = hasLifecycle
      ? await customerService.setCustomerActiveStatus({
          businessId: user.businessId,
          customerId,
          isActive: body.isActive as boolean,
        })
      : await customerService.updateCustomerBasics({
          businessId: user.businessId,
          customerId,
          ...basics,
        });

    return NextResponse.json({ customer: toCardCustomer(updated) }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
