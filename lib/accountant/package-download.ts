/**
 * Hands a stored package to whoever has already been authorized for it — the owner (session) or the
 * accountant (a valid link). SERVER-ONLY.
 *
 * Production storage is R2: the response is JSON carrying a presigned GET that lives five minutes;
 * the page navigates to it. The ZIP never passes through a function response (whose size is capped),
 * no long-lived URL to the object ever exists, and the bearer header the page authenticates with is
 * never forwarded to the storage host. The local adapter (refused in production) cannot presign; there the
 * bytes are returned directly so development works the same way end to end.
 */

import { getStorageService, loadStorageConfig } from "@/lib/storage";

export const PACKAGE_SIGNED_URL_TTL_SECONDS = 300;

export async function servePackageObject(
  storageKey: string,
  downloadName: string,
  contentType = "application/zip"
): Promise<Response> {
  const storage = getStorageService();
  if (loadStorageConfig().provider === "local") {
    const object = await storage.getObject(storageKey);
    return new Response(new Uint8Array(object.body), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${downloadName}"`,
        "Content-Length": String(object.body.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  }
  const url = await storage.getSignedDownloadUrl(storageKey, PACKAGE_SIGNED_URL_TTL_SECONDS);
  return Response.json(
    { url, fileName: downloadName },
    { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } }
  );
}

/** ASCII file name for the download (the Hebrew period label lives inside the ZIP). */
export function packageDownloadName(periodKey: string, version: number): string {
  return `accountant-package-${periodKey}-v${version}.zip`;
}
