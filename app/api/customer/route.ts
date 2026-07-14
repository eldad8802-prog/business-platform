import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { customerService } from "@/lib/services/crm/customer.service";

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

    const customers = await customerService.listCustomers({
      businessId: user.businessId,
      sort: "id-asc",
    });

    return NextResponse.json(customers, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
