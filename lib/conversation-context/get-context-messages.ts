import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// D2/P7-W4B: optional TenantTx so reads run on the caller's GUC-carrying
// transaction once Message is under FORCE RLS.
export type TxOptions = { tx?: Prisma.TransactionClient };

export async function getContextMessages(
  conversationId: number,
  limit: number = 5,
  options?: TxOptions
) {
  const db = options?.tx ?? prisma;
  const messages = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return messages.reverse();
}
