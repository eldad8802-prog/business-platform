import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { customerService } from "@/lib/services/crm/customer.service";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";

/**
 * Legacy endpoint — retained for existing callers. Delegates to the canonical
 * `customerService` so phone normalization + validation match every other path.
 * Response shapes are unchanged: POST → the created customer object (201);
 * GET → the full customer array ordered by id asc.
 */
export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    const customer = await customerService.createCustomer({
      businessId: user.businessId,
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      city: body.city ?? null,
      notes: body.notes ?? null,
    }, {
      // M5.5 — server-derived actor; no tx here, so the sensor opens its own (fail-open).
      sensor: {
        actor: { type: "OWNER_USER", userId: user.id },
        source: "OWNER_UI",
        origin: "UI",
      },
    });

    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Customer is FORCE RLS. Without a tenant transaction the service falls back to
    // the global client, runs with no `app.current_business_id`, and the policy
    // matches zero rows — an empty list behind a green 200. Same fix as
    // /api/billing/customers (#535). businessId is ALWAYS the server-derived one.
    const customers = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          customerService.listCustomers(
            { businessId: user.businessId, sort: "id-asc" },
            { tx }
          )
        )
    );

    return NextResponse.json(customers, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
