import {
  extensionFromMime,
  putPublicAsset,
} from "@/lib/services/storage/public-asset-storage.service";

export async function saveInventoryImage(input: {
  businessId: number;
  file: File;
}): Promise<string> {
  const { businessId, file } = input;

  if (!file) {
    throw new Error("No file provided");
  }

  if (!file.type.startsWith("image/")) {
    throw new Error("Only image files are allowed");
  }

  const MAX_SIZE = 5 * 1024 * 1024; // 5MB

  if (file.size > MAX_SIZE) {
    throw new Error("File too large (max 5MB)");
  }

  if (!extensionFromMime(file.type)) {
    throw new Error("Unsupported image type");
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  const stored = await putPublicAsset({
    businessId,
    domain: "inventory",
    body: buffer,
    contentType: file.type,
    custom: { source: "inventory_item_image" },
  });

  return stored.publicUrl;
}
