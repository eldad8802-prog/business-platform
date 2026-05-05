import path from "path";
import { mkdir, unlink, writeFile } from "fs/promises";

function safeExtFromMime(mimeType: string): string {
  const t = mimeType.toLowerCase();
  if (t === "application/pdf") return ".pdf";
  if (t === "image/jpeg") return ".jpg";
  if (t === "image/png") return ".png";
  if (t === "image/webp") return ".webp";
  if (t === "image/gif") return ".gif";
  if (t.startsWith("image/")) return ".img";
  return ".bin";
}

export async function writeTempOcrFile(params: {
  bytes: Buffer;
  mimeType: string;
  filenameHint?: string | null;
}): Promise<{ tempPath: string; cleanup: () => Promise<void> }> {
  const tmpDir = path.join(process.cwd(), "tmp", "ocr");
  await mkdir(tmpDir, { recursive: true });

  const ext = safeExtFromMime(params.mimeType);
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fileName = `gmail-${unique}${ext}`;

  const tempPath = path.join(tmpDir, fileName);
  await writeFile(tempPath, params.bytes);

  return {
    tempPath,
    cleanup: async () => {
      try {
        await unlink(tempPath);
      } catch {
        // ignore
      }
    },
  };
}

