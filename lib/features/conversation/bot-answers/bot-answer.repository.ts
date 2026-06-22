/**
 * BotFieldAnswer repository — thin persistence helpers.
 *
 * These touch Prisma (this is the persistence layer), but NO live conversation
 * path calls them in this stage — they are imported only by the module index
 * and exist as foundation for a future, explicit capture step. They never
 * write to Customer/Appointment and never run inside the webhook.
 *
 * "Current" answer per (conversationId, fieldKey) = the row with
 * `supersededAt IS NULL`, enforced at the DB level by a partial unique index.
 */

import { prisma } from "@/lib/prisma";
import type { BotFieldAnswer, PrismaClient } from "@prisma/client";
import { buildAnswerCreateData } from "./bot-answer.mapper";
import type { CaptureAnswerInput } from "./bot-answer.types";

/** Marks the current answer (if any) for a field as superseded. */
export async function supersedePreviousAnswer(
  conversationId: number,
  fieldKey: string,
  client: PrismaClient = prisma
): Promise<number> {
  const res = await client.botFieldAnswer.updateMany({
    where: { conversationId, fieldKey, supersededAt: null },
    data: { supersededAt: new Date() },
  });
  return res.count;
}

/**
 * Captures a new answer: supersedes the current one (if any) and inserts the
 * new row atomically, so at most one current answer exists per
 * (conversationId, fieldKey).
 */
export async function captureAnswer(
  input: CaptureAnswerInput,
  client: PrismaClient = prisma
): Promise<BotFieldAnswer> {
  const data = buildAnswerCreateData(input);
  return client.$transaction(async (tx) => {
    await tx.botFieldAnswer.updateMany({
      where: {
        conversationId: data.conversationId,
        fieldKey: data.fieldKey,
        supersededAt: null,
      },
      data: { supersededAt: new Date() },
    });
    return tx.botFieldAnswer.create({ data });
  });
}

/** All current answers for a conversation (one per field). */
export async function getCurrentAnswersForConversation(
  conversationId: number,
  client: PrismaClient = prisma
): Promise<BotFieldAnswer[]> {
  return client.botFieldAnswer.findMany({
    where: { conversationId, supersededAt: null },
    orderBy: { fieldKey: "asc" },
  });
}

/** Full history for a single field, oldest first (includes superseded rows). */
export async function getAnswerHistoryForField(
  conversationId: number,
  fieldKey: string,
  client: PrismaClient = prisma
): Promise<BotFieldAnswer[]> {
  return client.botFieldAnswer.findMany({
    where: { conversationId, fieldKey },
    orderBy: { capturedAt: "asc" },
  });
}
