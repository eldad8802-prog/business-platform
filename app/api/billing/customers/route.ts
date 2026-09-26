import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { ValidationError } from "@/lib/errors";
import { customerService } from "@/lib/services/crm/customer.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

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

    // Customer is FORCE RLS. Without a tenant transaction the service falls back to
    // the global client, runs with no `app.current_business_id`, and the policy
    // matches zero rows — an empty picker for every tenant behind a green 200.
    // businessId is ALWAYS the server-derived user.businessId.
    const customers = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          customerService.listCustomers(
            {
              businessId: user.businessId,
              query: q,
              limit,
              sort: "recent",
            },
            { tx }
          )
        )
    );

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

    // Same tenant transaction as the list: without it the INSERT policy's WITH CHECK
    // refuses the row. The body is never read for businessId.
    const customer = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          customerService.createCustomer(
            {
              businessId: user.businessId,
              name: body.name as string,
              phone: (body.phone as string | null | undefined) ?? null,
            },
            {
              tx,
              // M5.5 — server-derived actor; never read from the body.
              sensor: {
                actor: { type: "OWNER_USER", userId: user.id },
                source: "OWNER_UI",
                origin: "BILLING",
              },
            }
          )
        )
    );

    return NextResponse.json(
      { customer: toBillingCustomer(customer) },
      { status: 201 }
    );
  } catch (error) {
    return handleError(error);
  }
}
