import fs from "fs/promises";
import path from "path";

const UPLOAD_DIR = path.join(process.cwd(), "public/uploads/inventory");

export async function saveInventoryImage(file: File) {
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

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  const ext = file.type.split("/")[1] || "jpg";
  const fileName = `item-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2)}.${ext}`;

  const filePath = path.join(UPLOAD_DIR, fileName);

  const buffer = Buffer.from(await file.arrayBuffer());

  await fs.writeFile(filePath, buffer);

  return `/uploads/inventory/${fileName}`;
}