import { prisma } from "@/lib/prisma";

export type DedupResult =
  | { ok: true }
  | { ok: false; reason: "message_attachment" | "content_hash" };

export async function checkEmailImportDedup(params: {
  businessId: number;
  provider: "gmail";
  messageId: string;
  attachmentId: string;
  contentHashSha256?: string;
}): Promise<DedupResult> {
  const byMessageAttachment = await prisma.emailAttachmentImport.findFirst({
    where: {
      businessId: params.businessId,
      provider: params.provider,
      messageId: params.messageId,
      attachmentId: params.attachmentId,
    },
    select: { id: true },
  });

  if (byMessageAttachment) {
    return { ok: false, reason: "message_attachment" };
  }

  if (params.contentHashSha256) {
    const byHash = await prisma.emailAttachmentImport.findFirst({
      where: {
        businessId: params.businessId,
        contentHashSha256: params.contentHashSha256,
      },
      select: { id: true },
    });

    if (byHash) {
      return { ok: false, reason: "content_hash" };
    }
  }

  return { ok: true };
}

