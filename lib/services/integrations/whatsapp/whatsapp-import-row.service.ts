import { prisma } from "@/lib/prisma";
import { syntheticContentHashForPreBytesFailure } from "./whatsapp-import-dedup.service";

const MAX_ERROR_LEN = 240;

export function truncateImportError(message: string): string {
  const trimmed = message.trim();
  if (trimmed.length <= MAX_ERROR_LEN) return trimmed;
  return `${trimmed.slice(0, MAX_ERROR_LEN - 3)}...`;
}

function mimeFromRoutingMediaType(
  mediaType: "image" | "document"
): string {
  return mediaType === "document" ? "application/pdf" : "image/jpeg";
}

export async function createWhatsAppFailedImport(params: {
  businessId: number;
  wamid: string;
  mediaId: string;
  phoneNumberId: string;
  fromPhone: string;
  mediaType: "image" | "document";
  error: string;
  contentHashSha256?: string;
  mimeType?: string;
  sizeBytes?: number | null;
  filename?: string | null;
}): Promise<{ id: number }> {
  const row = await prisma.whatsAppAttachmentImport.create({
    data: {
      businessId: params.businessId,
      wamid: params.wamid,
      mediaId: params.mediaId,
      phoneNumberId: params.phoneNumberId,
      fromPhone: params.fromPhone,
      mimeType: params.mimeType ?? mimeFromRoutingMediaType(params.mediaType),
      sizeBytes: params.sizeBytes ?? null,
      filename: params.filename ?? null,
      contentHashSha256:
        params.contentHashSha256 ??
        syntheticContentHashForPreBytesFailure(params.businessId, params.wamid),
      status: "failed",
      error: truncateImportError(params.error),
    },
    select: { id: true },
  });
  return row;
}

export async function claimWhatsAppProcessingImport(params: {
  businessId: number;
  wamid: string;
  mediaId: string;
  phoneNumberId: string;
  fromPhone: string;
  mimeType: string;
  sizeBytes: number;
  filename: string | null;
  contentHashSha256: string;
}): Promise<
  | { ok: true; importId: number }
  | { ok: false; reason: "wamid" | "content_hash" }
> {
  try {
    const row = await prisma.whatsAppAttachmentImport.create({
      data: {
        businessId: params.businessId,
        wamid: params.wamid,
        mediaId: params.mediaId,
        phoneNumberId: params.phoneNumberId,
        fromPhone: params.fromPhone,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        filename: params.filename,
        contentHashSha256: params.contentHashSha256,
        status: "processing",
      },
      select: { id: true },
    });
    return { ok: true, importId: row.id };
  } catch (error: unknown) {
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code;
    if (code === "P2002") {
      const byWamid = await prisma.whatsAppAttachmentImport.findFirst({
        where: {
          businessId: params.businessId,
          wamid: params.wamid,
        },
        select: { id: true },
      });
      if (byWamid) {
        return { ok: false, reason: "wamid" };
      }
      return { ok: false, reason: "content_hash" };
    }
    throw error;
  }
}

export async function markWhatsAppImportImported(params: {
  importId: number;
  documentId: number;
}): Promise<void> {
  await prisma.whatsAppAttachmentImport.update({
    where: { id: params.importId },
    data: {
      status: "imported",
      documentId: params.documentId,
      error: null,
    },
  });
}

export async function markWhatsAppImportFailed(params: {
  importId: number;
  error: string;
}): Promise<void> {
  await prisma.whatsAppAttachmentImport.update({
    where: { id: params.importId },
    data: {
      status: "failed",
      error: truncateImportError(params.error),
    },
  });
}
