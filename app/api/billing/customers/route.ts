import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { customerService } from "@/lib/services/crm/customer.service";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError("limit must be a positive integer");
  }
  return Math.min(n, MAX_LIMIT);
}

/** Billing/invoice customer shape — identity subset only. Contract preserved. */
function toBillingCustomer(c: {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
}) {
  return { id: c.id, name: c.name, phone: c.phone, email: c.email, city: c.city };
}

/**
 * Search + list customers for the current business (billing / invoice UX).
 * GET ?q= optional substring on name or phone, ?limit=
 * POST { name, phone? } — quick create
 *
 * Delegates to the canonical `customerService`; response shapes are unchanged.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();
    const limit = parseLimit(searchParams.get("limit"));

    const customers = await customerService.listCustomers({
      businessId: user.businessId,
      query: q,
      limit,
      sort: "recent",
    });

    return NextResponse.json(
      { customers: customers.map(toBillingCustomer) },
      { status: 200 }
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    });

    return NextResponse.json(
      { customer: toBillingCustomer(customer) },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}
