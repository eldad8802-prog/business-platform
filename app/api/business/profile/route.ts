import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await prisma.businessProfile.findUnique({
      where: { businessId: user.businessId },
    });

    return NextResponse.json({
      success: true,
      hasProfile: !!profile,
      profile,
    });
  } catch (error) {
    console.error("PROFILE_GET_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { category, subCategory, businessModel } = body;

    if (!category || !subCategory || !businessModel) {
      return NextResponse.json(
        { error: "category, subCategory and businessModel are required" },
        { status: 400 }
      );
    }

    if (!["service", "product", "hybrid"].includes(String(businessModel).toLowerCase())) {
      return NextResponse.json(
        { error: "businessModel must be service, product or hybrid" },
        { status: 400 }
      );
    }

    const normalizedBusinessModel = String(businessModel).toLowerCase();

    const profile = await prisma.businessProfile.upsert({
      where: { businessId: user.businessId },
      update: {
        category,
        subCategory,
        businessModel: normalizedBusinessModel,
      },
      create: {
        businessId: user.businessId,
        category,
        subCategory,
        businessModel: normalizedBusinessModel,
      },
    });

    return NextResponse.json({
      success: true,
      profile,
    });
  } catch (error) {
    console.error("PROFILE_POST_ERROR:", error);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}