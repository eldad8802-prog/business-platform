import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { syntheticContentHashForPreBytesFailure } from "./whatsapp-import-dedup.service";

// D2/P7-W4B: every mutation is tenant-attributable — creates carry
// businessId, and status transitions are atomic tenant-scoped updateMany
// (id-only updates removed so a foreign importId can never be a mutation
// handle). Optional TenantTx keeps each call on the caller's GUC connection.
type TxOptions = { tx?: Prisma.TransactionClient };

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

export async function createWhatsAppFailedImport(
  params: {
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
  },
  options?: TxOptions
): Promise<{ id: number }> {
  const db = options?.tx ?? prisma;
  const row = await db.whatsAppAttachmentImport.create({
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

export async function claimWhatsAppProcessingImport(
  params: {
    businessId: number;
    wamid: string;
    mediaId: string;
    phoneNumberId: string;
    fromPhone: string;
    mimeType: string;
    sizeBytes: number;
    filename: string | null;
    contentHashSha256: string;
  },
  options?: TxOptions
): Promise<
  | { ok: true; importId: number }
  | { ok: false; reason: "wamid" | "content_hash" }
> {
  const db = options?.tx ?? prisma;
  // Inside a caller-provided interactive tx a P2002 must PROPAGATE (the tx is
  // aborted by Postgres) so the caller can disambiguate on a fresh tx.
  if (options?.tx) {
    const row = await db.whatsAppAttachmentImport.create({
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
  }
  try {
    const row = await db.whatsAppAttachmentImport.create({
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
      // NOTE: when called INSIDE an interactive transaction the caller must
      // treat a P2002 as fatal for that tx (Postgres aborts it) and re-run
      // this disambiguation on a fresh transaction. The default (no-tx) path
      // resolves it inline.
      const byWamid = await (options?.tx ?? prisma).whatsAppAttachmentImport.findFirst({
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

export async function markWhatsAppImportImported(
  params: {
    importId: number;
    businessId: number;
    documentId: number;
  },
  options?: TxOptions
): Promise<void> {
  const db = options?.tx ?? prisma;
  await db.whatsAppAttachmentImport.updateMany({
    where: { id: params.importId, businessId: params.businessId },
    data: {
      status: "imported",
      documentId: params.documentId,
      error: null,
    },
  });
}

export async function markWhatsAppImportFailed(
  params: {
    importId: number;
    businessId: number;
    error: string;
  },
  options?: TxOptions
): Promise<void> {
  const db = options?.tx ?? prisma;
  await db.whatsAppAttachmentImport.updateMany({
    where: { id: params.importId, businessId: params.businessId },
    data: {
      status: "failed",
      error: truncateImportError(params.error),
    },
  });
}
