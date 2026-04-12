import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcrypt";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, password, name, businessName } = body;

    if (!email || !password || !name || !businessName) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "User already exists" },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const business = await prisma.business.create({
      data: {
        name: businessName,
      },
    });

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        businessId: business.id,
      },
    });

    return NextResponse.json({
      success: true,
      userId: user.id,
      businessId: business.id,
    });
  } catch (error) {
    console.error("REGISTER_ERROR:", error);

    return NextResponse.json(
      { error: "Server error", rawError: String(error) },
      { status: 500 }
    );
  }
}