import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    if (!body.name) {
      return NextResponse.json(
        { error: "Business name is required" },
        { status: 400 }
      );
    }

    const business = await prisma.business.create({
      data: {
        name: body.name,
      },
    });

    return NextResponse.json({
      success: true,
      business,
    });
  } catch (error) {
    console.error("BUSINESS_CREATE_ERROR:", error);

    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}