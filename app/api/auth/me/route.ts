import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const currentUser = await getCurrentUser(req);

    if (!currentUser) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: currentUser.id },
      include: {
        business: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        businessId: user.businessId,
        businessName: user.business?.name ?? null,
      },
    });
  } catch (error) {
    console.error("AUTH_ME_ERROR:", error);

    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}