/**
 * Client-side access to the original document source file.
 *
 * Wraps the existing, auth-protected endpoint `GET /api/documents/[id]/file`
 * (Bearer token required, see getCurrentUser). No new endpoint is introduced —
 * this only connects the UI to the file layer that already exists.
 */

export function getStoredAuthHeader(): string | null {
  if (typeof window === "undefined") return null;
  const token = window.localStorage.getItem("token");
  return token ? `Bearer ${token}` : null;
}

/** Fetch the original file as a Blob. Throws on auth/availability failure. */
export async function fetchDocumentFileBlob(
  documentId: number,
  options?: { signal?: AbortSignal }
): Promise<Blob> {
  const authHeader = getStoredAuthHeader();
  if (!authHeader) {
    throw new Error("not_authenticated");
  }

  const res = await fetch(`/api/documents/${documentId}/file`, {
    headers: { authorization: authHeader },
    cache: "no-store",
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`file_unavailable_${res.status}`);
  }

  return res.blob();
}

function extFromMime(mime: string | null | undefined): string {
  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("heic")) return "heic";
  if (m.includes("heif")) return "heif";
  if (m.includes("tiff")) return "tiff";
  if (m.includes("bmp")) return "bmp";
  if (m.startsWith("image/")) return "img";
  return "file";
}

/** Human-friendly, filesystem-safe download name for a document. */
export function buildDocumentDownloadName(input: {
  documentId: number;
  vendorName?: string | null;
  mimeType?: string | null;
}): string {
  const ext = extFromMime(input.mimeType);
  const safeVendor = String(input.vendorName || "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const base = safeVendor || "מסמך";
  return `${base}-${input.documentId}.${ext}`;
}

/** Trigger a direct browser download of the original file. */
export async function downloadDocumentFile(
  documentId: number,
  filename: string
): Promise<void> {
  const blob = await fetchDocumentFileBlob(documentId);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after a tick so the browser can start the download first.
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}
