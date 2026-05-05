import { NextResponse } from "next/server";
import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";
import { runGoogleVisionOCR } from "@/lib/services/documents/google-vision-ocr.service";

export const runtime = "nodejs";

function safeExtFromMime(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t === "application/pdf") return ".pdf";
  if (t === "image/jpeg") return ".jpg";
  if (t === "image/png") return ".png";
  if (t === "image/webp") return ".webp";
  if (t === "image/gif") return ".gif";
  if (t.startsWith("image/")) return ".img";
  return "";
}

export async function POST(req: Request) {
  let tempFilePath: string | null = null;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file" },
        { status: 400 }
      );
    }

    const tmpDir = path.join(process.cwd(), "tmp", "ocr");
    await mkdir(tmpDir, { recursive: true });

    const originalName = String(file.name ?? "");
    const originalExt = path.extname(originalName);
    const mimeType = String(file.type ?? "");

    const ext = originalExt || safeExtFromMime(mimeType) || ".bin";
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileName = `debug-ocr-${unique}${ext}`;

    tempFilePath = path.join(tmpDir, fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(tempFilePath, buffer);

    const isPdf =
      mimeType === "application/pdf" || tempFilePath.toLowerCase().endsWith(".pdf");

    let rawText = "";

    if (isPdf) {
      rawText = await runGoogleVisionOCR(tempFilePath, mimeType);
    } else {
      rawText = await runGoogleVisionOCR(tempFilePath, mimeType);
    }

    return NextResponse.json({
      success: true,
      rawText: String(rawText ?? "").trim(),
    });
  } catch (error) {
    console.error("DEBUG OCR ERROR:", error);

    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  } finally {
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

