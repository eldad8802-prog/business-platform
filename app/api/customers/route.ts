import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import {
  customerService,
  type CustomerLifecycleFilter,
} from "@/lib/services/crm/customer.service";

const DEFAULT_LIMIT = 50;

const LIFECYCLE_FILTERS: CustomerLifecycleFilter[] = ["active", "inactive", "all"];

/** Validate the closed lifecycle filter set. Absent = undefined (service → "all"). */
function parseStatus(value: string | null): CustomerLifecycleFilter | undefined {
  if (value === null || value === "") return undefined;
  if (!LIFECYCLE_FILTERS.includes(value as CustomerLifecycleFilter)) {
    throw new ValidationError(`status must be one of: ${LIFECYCLE_FILTERS.join(", ")}`);
  }
  return value as CustomerLifecycleFilter;
}

/** Row shape exposed to the customers list UI — identity + lifecycle, no fabricated financials. */
function toListRow(c: {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  isActive: boolean;
}) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    city: c.city,
    isActive: c.isActive,
  };
}

/**
 * Canonical customers list/search.
 * GET ?q= (name/phone substring) ?limit=
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q");
    const limitParam = searchParams.get("limit");
    const limit =
      limitParam === null || limitParam === ""
        ? DEFAULT_LIMIT
        : Number(limitParam);
    const status = parseStatus(searchParams.get("status"));

    const customers = await customerService.listCustomers({
      businessId: user.businessId,
      query: q,
      limit,
      sort: "recent",
      status,
    });

    return NextResponse.json(
      { customers: customers.map(toListRow) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Canonical customer create. Body: { name, phone?, email?, city?, notes? }.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const customer = await customerService.createCustomer({
      businessId: user.businessId,
      name: body.name as string,
      phone: (body.phone as string | null | undefined) ?? null,
      email: (body.email as string | null | undefined) ?? null,
      city: (body.city as string | null | undefined) ?? null,
      notes: (body.notes as string | null | undefined) ?? null,
    });

    return NextResponse.json({ customer: toListRow(customer) }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
