import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { normalizeCustomerPhone } from "@/lib/services/integrations/whatsapp/phone";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();

    // Canonical-form phone is the platform's source of truth for Customer
    // identity. `normalizeCustomerPhone` returns null for missing/invalid
    // input — we intentionally persist null rather than the raw string when
    // normalization fails, so the (businessId, phone) unique constraint
    // remains meaningful over time.
    const normalizedPhone = normalizeCustomerPhone(body.phone);

    const customer = await prisma.customer.create({
      data: {
        businessId: user.businessId,
        name: body.name,
        phone: normalizedPhone,
        email: body.email,
        city: body.city,
        notes: body.notes,
      },
    });

    return NextResponse.json(customer, { status: 201 });
  } catch (error) {
    console.error("ERROR creating customer:", error);
    return NextResponse.json(
      { error: "Failed to create customer" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const customers = await prisma.customer.findMany({
      where: { businessId: user.businessId },
      orderBy: { id: "asc" },
    });

    return NextResponse.json(customers);
  } catch (error) {
    console.error("ERROR fetching customers:", error);
    return NextResponse.json(
      { error: "Failed to fetch customers" },
      { status: 500 }
    );
  }
}