import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getCustomerCard } from "@/lib/services/crm/customer-card.read-model";
import { customerService } from "@/lib/services/crm/customer.service";

/** Basic CRM fields editable from the customer card. Tax identity stays in Billing. */
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
 * Edit a customer's basic CRM fields (name/phone/email/city/notes). Delegates to
 * the canonical `customerService.updateCustomerBasics` — no parallel write path.
 * Tenant-guarded there (another business's customer behaves as not-found). Tax
 * identity (legalName/taxId/taxIdType) is intentionally NOT accepted here; it stays
 * owned by PATCH /api/billing/customers/[id].
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

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    // Forward only the basic fields, preserving "key absent = don't touch".
    const input: Parameters<typeof customerService.updateCustomerBasics>[0] = {
      businessId: user.businessId,
      customerId: Number(id),
    };
    for (const key of BASIC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        (input as Record<string, unknown>)[key] = body[key];
      }
    }

    const updated = await customerService.updateCustomerBasics(input);

    return NextResponse.json({ customer: toCardCustomer(updated) }, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
