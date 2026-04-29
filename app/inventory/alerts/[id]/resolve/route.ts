import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const params = await context.params;
    const alertId = Number(params.id);

    if (!alertId || Number.isNaN(alertId)) {
      return NextResponse.json(
        { error: "Invalid alert id" },
        { status: 400 }
      );
    }

    const alert = await prisma.inventoryAlert.findUnique({
      where: { id: alertId },
    });

    if (!alert) {
      return NextResponse.json(
        { error: "Alert not found" },
        { status: 404 }
      );
    }

    await prisma.inventoryAlert.update({
      where: { id: alertId },
      data: {
        isResolved: true,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Resolve alert error:", error);

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}