import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return authRequiredResponse(request);
    }

    const categories = await prisma.inventoryCategory.findMany({
      where: { businessId: user.businessId },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({
      success: true,
      categories,
    });
  } catch (err: any) {
    if (err.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.error("Categories GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      return authRequiredResponse(request);
    }
    const body = await request.json();

    const name =
      typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json(
        { error: "Category name is required" },
        { status: 400 }
      );
    }

    const existing = await prisma.inventoryCategory.findFirst({
      where: {
        businessId: user.businessId,
        name,
      },
    });

    if (existing) {
      return NextResponse.json({
        success: true,
        category: existing,
        alreadyExists: true,
      });
    }

    const category = await prisma.inventoryCategory.create({
      data: {
        businessId: user.businessId,
        name,
      },
    });

    return NextResponse.json(
      {
        success: true,
        category,
      },
      { status: 201 }
    );
  } catch (err: any) {
    if (err.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.error("Categories POST error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}