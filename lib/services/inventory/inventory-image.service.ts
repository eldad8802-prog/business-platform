import { putPublicAsset } from "@/lib/services/storage/public-asset-storage.service";

/**
 * Store an inventory item image. Acceptance is owned by putPublicAsset (M-2):
 * raster only (png/jpeg/webp/gif), magic bytes verified against the declared
 * type and the filename, active content refused, 5MB ceiling, stored with the
 * VERIFIED Content-Type. A rejection throws PublicAssetRejectedError and
 * writes nothing.
 *
 * The HTTP route uses receivePublicAssetUpload (which adds rate limits); this
 * is the programmatic entry point.
 */
export async function saveInventoryImage(input: {
  businessId: number;
  file: File;
}): Promise<string> {
  const { businessId, file } = input;

  if (!file) {
    throw new Error("No file provided");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const stored = await putPublicAsset({
    businessId,
    domain: "inventory",
    body: buffer,
    contentType: file.type,
    fileName: file.name,
    custom: { source: "inventory_item_image" },
  });

  return stored.publicUrl;
}
