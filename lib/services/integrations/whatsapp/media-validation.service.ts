/** MVP intake policy — aligned with Documents upload / Gmail import. */
export const WHATSAPP_MEDIA_MAX_BYTES = 15 * 1024 * 1024;

export type MediaValidationFailureReason = "unsupported_mime" | "file_too_large";

export function isAllowedWhatsAppMediaMime(mimeType: string): boolean {
  const m = String(mimeType || "").toLowerCase().trim();
  return m === "application/pdf" || m.startsWith("image/");
}

export function validateWhatsAppMediaContent(params: {
  buffer: Buffer;
  mimeType: string;
}):
  | { ok: true; mimeType: string; sizeBytes: number }
  | { ok: false; reason: MediaValidationFailureReason } {
  const mimeType = String(params.mimeType || "").trim();
  if (!isAllowedWhatsAppMediaMime(mimeType)) {
    return { ok: false, reason: "unsupported_mime" };
  }

  const sizeBytes = params.buffer.length;
  if (sizeBytes > WHATSAPP_MEDIA_MAX_BYTES) {
    return { ok: false, reason: "file_too_large" };
  }

  if (sizeBytes === 0) {
    return { ok: false, reason: "unsupported_mime" };
  }

  return { ok: true, mimeType, sizeBytes };
}
