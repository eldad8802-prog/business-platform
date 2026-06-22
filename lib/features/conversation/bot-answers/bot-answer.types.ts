/**
 * BotFieldAnswer — Stage (Answer persistence foundation) types.
 *
 * The structured capture of a customer's answer to one bot field. This module
 * defines the input shape + re-exports the Prisma enum. No live consumer wires
 * these into the conversation flow in this stage.
 */

import type { BotAnswerParseStatus } from "@prisma/client";

export type { BotAnswerParseStatus };

/** Input for capturing a single answer. Defaults applied by the mapper. */
export type CaptureAnswerInput = {
  businessId: number;
  conversationId: number;
  fieldKey: string;
  /** Verbatim customer answer — stored as-is (never trimmed/normalized). */
  rawValue: string;
  /** Provenance to the Message this came from. Optional. */
  sourceMessageId?: number | null;
  /** Party role context. Defaults to "CUSTOMER". */
  partyRole?: string;
  /** "text" | "media" — defaults to "text". */
  rawKind?: string;
};

/**
 * Pure create payload (scalars only) — what the repository inserts. parsed /
 * confidence are intentionally omitted so the DB defaults (null / UNPARSED)
 * apply; parsing fills them later.
 */
export type AnswerCreateData = {
  businessId: number;
  conversationId: number;
  sourceMessageId: number | null;
  fieldKey: string;
  partyRole: string;
  rawValue: string;
  rawKind: string;
  parseStatus: BotAnswerParseStatus;
};
