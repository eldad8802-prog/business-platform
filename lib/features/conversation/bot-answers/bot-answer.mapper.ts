/**
 * Pure mapper for BotFieldAnswer creation. No I/O, no Prisma client, no
 * conversation-flow coupling — safe to unit-test without a database.
 */

import type { AnswerCreateData, CaptureAnswerInput } from "./bot-answer.types";

/**
 * Builds the scalar create payload from a capture input, applying defaults:
 *   - partyRole  -> "CUSTOMER"
 *   - rawKind    -> "text"
 *   - parseStatus-> "UNPARSED" (parsing fills the rest later)
 *
 * `rawValue` is preserved VERBATIM — no trim/normalize — because it is the
 * immutable snapshot of what the customer answered.
 */
export function buildAnswerCreateData(input: CaptureAnswerInput): AnswerCreateData {
  return {
    businessId: input.businessId,
    conversationId: input.conversationId,
    sourceMessageId: input.sourceMessageId ?? null,
    fieldKey: input.fieldKey,
    partyRole: input.partyRole ?? "CUSTOMER",
    rawValue: input.rawValue,
    rawKind: input.rawKind ?? "text",
    parseStatus: "UNPARSED",
  };
}
