import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { getCurrentUser } from "../../../../../lib/auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const profileId = Number(id);

    if (Number.isNaN(profileId)) {
      return NextResponse.json({ error: "Invalid profile id" }, { status: 400 });
    }

    const profile = await prisma.pricingProfile.findFirst({
      where: {
        id: profileId,
        businessId: user.businessId,
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

    if (!profile) {
      return NextResponse.json(
        { error: "Pricing profile not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ profile });
  } catch (error) {
    console.error("pricing profile get by id error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const profileId = Number(id);

    if (Number.isNaN(profileId)) {
      return NextResponse.json({ error: "Invalid profile id" }, { status: 400 });
    }

    const existingProfile = await prisma.pricingProfile.findFirst({
      where: {
        id: profileId,
        businessId: user.businessId,
      },
    });

    if (!existingProfile) {
      return NextResponse.json(
        { error: "Pricing profile not found" },
        { status: 404 }
      );
    }

    const body = await req.json();

    const updateData: {
      name?: string;
      type?: "PRODUCT" | "SERVICE";
      category?: string | null;
      defaultMaterialCost?: number;
      defaultLaborMinutes?: number;
      defaultHourlyRate?: number;
      defaultOverheadPercent?: number;
      isActive?: boolean;
    } = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json(
          { error: "name must be a non-empty string" },
          { status: 400 }
        );
      }
      updateData.name = body.name.trim();
    }

    if (body.type !== undefined) {
      if (body.type !== "PRODUCT" && body.type !== "SERVICE") {
        return NextResponse.json(
          { error: "type must be PRODUCT or SERVICE" },
          { status: 400 }
        );
      }
      updateData.type = body.type;
    }

    if (body.category !== undefined) {
      if (body.category === null || body.category === "") {
        updateData.category = null;
      } else if (typeof body.category === "string") {
        updateData.category = body.category.trim();
      } else {
        return NextResponse.json(
          { error: "category must be a string or null" },
          { status: 400 }
        );
      }
    }

    if (body.defaultMaterialCost !== undefined) {
      const value = Number(body.defaultMaterialCost);
      if (Number.isNaN(value) || value < 0) {
        return NextResponse.json(
          { error: "defaultMaterialCost must be a non-negative number" },
          { status: 400 }
        );
      }
      updateData.defaultMaterialCost = value;
    }

    if (body.defaultLaborMinutes !== undefined) {
      const value = Number(body.defaultLaborMinutes);
      if (Number.isNaN(value) || value < 0) {
        return NextResponse.json(
          { error: "defaultLaborMinutes must be a non-negative number" },
          { status: 400 }
        );
      }
      updateData.defaultLaborMinutes = value;
    }

    if (body.defaultHourlyRate !== undefined) {
      const value = Number(body.defaultHourlyRate);
      if (Number.isNaN(value) || value < 0) {
        return NextResponse.json(
          { error: "defaultHourlyRate must be a non-negative number" },
          { status: 400 }
        );
      }
      updateData.defaultHourlyRate = value;
    }

    if (body.defaultOverheadPercent !== undefined) {
      const value = Number(body.defaultOverheadPercent);
      if (Number.isNaN(value) || value < 0) {
        return NextResponse.json(
          { error: "defaultOverheadPercent must be a non-negative number" },
          { status: 400 }
        );
      }
      updateData.defaultOverheadPercent = value;
    }

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") {
        return NextResponse.json(
          { error: "isActive must be a boolean" },
          { status: 400 }
        );
      }
      updateData.isActive = body.isActive;
    }

    const updatedProfile = await prisma.pricingProfile.update({
      where: { id: profileId },
      data: updateData,
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
      success: true,
      profile: updatedProfile,
    });
  } catch (error) {
    console.error("pricing profile patch error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const profileId = Number(id);

    if (Number.isNaN(profileId)) {
      return NextResponse.json({ error: "Invalid profile id" }, { status: 400 });
    }

    const existingProfile = await prisma.pricingProfile.findFirst({
      where: {
        id: profileId,
        businessId: user.businessId,
      },
    });

    if (!existingProfile) {
      return NextResponse.json(
        { error: "Pricing profile not found" },
        { status: 404 }
      );
    }

    const deletedProfile = await prisma.pricingProfile.update({
      where: { id: profileId },
      data: { isActive: false },
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
      success: true,
      profile: deletedProfile,
    });
  } catch (error) {
    console.error("pricing profile delete error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
        rawError: String(error),
      },
      { status: 400 }
    );
  }
}