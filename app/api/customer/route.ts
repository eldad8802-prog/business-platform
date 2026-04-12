import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const customer = await prisma.customer.create({
      data: {
        businessId: body.businessId,
        name: body.name,
        phone: body.phone,
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

export async function GET() {
  try {
    const customers = await prisma.customer.findMany({
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