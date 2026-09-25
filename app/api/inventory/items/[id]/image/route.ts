import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { receivePublicAssetUpload } from "@/lib/services/storage/public-asset-upload";
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

    const item = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction((tx) =>
          tx.inventoryItem.findFirst({
            where: {
              id: itemId,
              businessId: user.businessId,
            },
          })
        )
    );

    if (!item) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    // M-2: rate limit + byte-verified raster acceptance + safe serving metadata.
    const upload = await receivePublicAssetUpload({
      req: request,
      user,
      domain: "inventory",
      source: "inventory_item_image",
    });
    if (!upload.ok) {
      return NextResponse.json(
        { error: upload.error },
        { status: upload.status }
      );
    }
    const imageUrl = upload.stored.publicUrl;

    // Tenant-scoped write inside a tenant transaction (no id-only window).
    const updated = await runWithTenantContext(
      { businessId: user.businessId },
      () =>
        withTenantTransaction(async (tx) => {
          const result = await tx.inventoryItem.updateMany({
            where: { id: itemId, businessId: user.businessId },
            data: { imageUrl },
          });
          if (result.count !== 1) {
            throw new Error("INVALID_ID");
          }
          return tx.inventoryItem.findFirst({
            where: { id: itemId, businessId: user.businessId },
          });
        })
    );

    return NextResponse.json({
      success: true,
      item: updated,
    });
  } catch (err: any) {
    if (err instanceof StorageConfigError) {
      // Log the full internal detail server-side only; never leak env var names,
      // storage provider names, or other infrastructure details to the client.
      console.error("Inventory item image upload — storage config error:", err);
      return NextResponse.json(
        { error: "לא ניתן להעלות תמונת מוצר כרגע. נסה שוב מאוחר יותר." },
        { status: 503 }
      );
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