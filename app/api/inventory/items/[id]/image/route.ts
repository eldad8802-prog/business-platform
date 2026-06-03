import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { saveInventoryImage } from "@/lib/services/inventory/inventory-image.service";
import { StorageConfigError } from "@/lib/storage/storage.errors";

function getItemId(request: NextRequest) {
  const parts = request.nextUrl.pathname.split("/");
  const id = Number(parts[parts.length - 2]);

  if (!id || Number.isNaN(id)) {
    throw new Error("INVALID_ID");
  }

  return id;
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser(request);
    if (!user) {
      throw new Error("UNAUTHORIZED");
    }
    const itemId = getItemId(request);

    const item = await prisma.inventoryItem.findFirst({
      where: {
        id: itemId,
        businessId: user.businessId,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json(
        { error: "File is required" },
        { status: 400 }
      );
    }

    const imageUrl = await saveInventoryImage({
      businessId: user.businessId,
      file,
    });

    const updated = await prisma.inventoryItem.update({
      where: { id: itemId },
      data: { imageUrl },
    });

    return NextResponse.json({
      success: true,
      item: updated,
    });
  } catch (err: any) {
    if (err instanceof StorageConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }

    if (err.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (err.message === "INVALID_ID") {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 });
    }

    return NextResponse.json(
      { error: err.message || "Upload failed" },
      { status: 500 }
    );
  }
}