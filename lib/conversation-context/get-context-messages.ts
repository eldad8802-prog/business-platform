import { prisma } from "@/lib/prisma";

export async function getContextMessages(
  conversationId: number,
  limit: number = 5
) {
  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return messages.reverse();
}