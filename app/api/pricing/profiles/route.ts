import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/prisma";
import { getCurrentUser } from "../../../../lib/auth";

export async function GET(req: Request) {
  try {
    console.log("pricing profiles GET headers:", Object.fromEntries(req.headers.entries()));

    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const url = new URL(req.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";

    const profiles = await prisma.pricingProfile.findMany({
      where: {
        businessId: user.businessId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        businessId: true,
        name: true,
        type: true,
        category: true,
        defaultMaterialCost: true,
        defaultLaborMinutes: true,
        defaultHourlyRate: true,
        defaultOverheadPercent: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      count: profiles.length,
      profiles,
    });
  } catch (error) {
    console.error("pricing profiles get error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}

export async function POST(req: Request) {
  try {
    console.log("pricing profiles POST headers:", Object.fromEntries(req.headers.entries()));

    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await req.json();

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json(
        { error: "name is required" },
        { status: 400 }
      );
    }

    if (body.type !== "PRODUCT" && body.type !== "SERVICE") {
      return NextResponse.json(
        { error: "type must be PRODUCT or SERVICE" },
        { status: 400 }
      );
    }

    const defaultMaterialCost = Number(body.defaultMaterialCost ?? 0);
    const defaultLaborMinutes = Number(body.defaultLaborMinutes ?? 0);
    const defaultHourlyRate = Number(body.defaultHourlyRate ?? 0);
    const defaultOverheadPercent = Number(body.defaultOverheadPercent ?? 10);

    if (Number.isNaN(defaultMaterialCost) || defaultMaterialCost < 0) {
      return NextResponse.json(
        { error: "defaultMaterialCost must be a non-negative number" },
        { status: 400 }
      );
    }

    if (Number.isNaN(defaultLaborMinutes) || defaultLaborMinutes < 0) {
      return NextResponse.json(
        { error: "defaultLaborMinutes must be a non-negative number" },
        { status: 400 }
      );
    }

    if (Number.isNaN(defaultHourlyRate) || defaultHourlyRate < 0) {
      return NextResponse.json(
        { error: "defaultHourlyRate must be a non-negative number" },
        { status: 400 }
      );
    }

    if (Number.isNaN(defaultOverheadPercent) || defaultOverheadPercent < 0) {
      return NextResponse.json(
        { error: "defaultOverheadPercent must be a non-negative number" },
        { status: 400 }
      );
    }

    const profile = await prisma.pricingProfile.create({
      data: {
        businessId: user.businessId,
        name: body.name.trim(),
        type: body.type,
        category: body.category?.trim() || null,
        defaultMaterialCost,
        defaultLaborMinutes,
        defaultHourlyRate,
        defaultOverheadPercent,
        isActive: body.isActive ?? true,
      },
      select: {
        id: true,
        businessId: true,
        name: true,
        type: true,
        category: true,
        defaultMaterialCost: true,
        defaultLaborMinutes: true,
        defaultHourlyRate: true,
        defaultOverheadPercent: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(
      {
        success: true,
        profile,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("pricing profiles post error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}