import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type TxOptions = { tx?: Prisma.TransactionClient };
import { sha256Hex } from "@/lib/services/integrations/gmail/sha256.service";

export type WhatsAppDedupResult =
  | { ok: true }
  | { ok: false; reason: "wamid" | "content_hash" };

/** Deterministic placeholder hash when bytes were never fetched (media fetch failure). */
export function syntheticContentHashForPreBytesFailure(
  businessId: number,
  wamid: string
): string {
  return sha256Hex(
    Buffer.from(`whatsapp-import:no-bytes:${businessId}:${wamid}`, "utf8")
  );
}

export async function checkWhatsAppImportWamidDedup(
  params: {
    businessId: number;
    wamid: string;
  },
  options?: TxOptions
): Promise<WhatsAppDedupResult> {
  const db = options?.tx ?? prisma;
  const existing = await db.whatsAppAttachmentImport.findFirst({
    where: {
      businessId: params.businessId,
      wamid: params.wamid,
    },
    select: { id: true },
  });

  if (existing) {
    return { ok: false, reason: "wamid" };
  }

  return { ok: true };
}

export async function checkWhatsAppImportHashDedup(
  params: {
    businessId: number;
    contentHashSha256: string;
  },
  options?: TxOptions
): Promise<WhatsAppDedupResult> {
  const db = options?.tx ?? prisma;
  const existing = await db.whatsAppAttachmentImport.findFirst({
    where: {
      businessId: params.businessId,
      contentHashSha256: params.contentHashSha256,
    },
    select: { id: true },
  });

  if (existing) {
    return { ok: false, reason: "content_hash" };
  }

  return { ok: true };
}
