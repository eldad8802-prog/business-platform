import type { ConversationStage } from "@prisma/client";

/**
 * Stage mapping rules — Conversation State Writer v1.
 *
 * Conservative by design:
 *   - No demotion. Ever.
 *   - WON / LOST / INACTIVE are LOCKED — never mutated automatically.
 *   - A transition only happens when there is an unambiguous business signal.
 *   - When in doubt, return null (no-op).
 *
 * The function is pure (no I/O, no Prisma) and takes the message + analysis
 * as input. It returns the next stage, or null if no transition should occur.
 */

export type AnalysisIntent =
  | "price"
  | "availability"
  | "booking"
  | "follow_up_request"
  | "unclear";
export type AnalysisStage = "early" | "middle" | "closing";

export type AnalysisInput = {
  intent: AnalysisIntent;
  stage: AnalysisStage;
} | null;

export type StageMappingInput = {
  currentStage: ConversationStage | null;
  direction: "INBOUND" | "OUTBOUND";
  senderType: "CUSTOMER" | "BUSINESS_USER" | "SYSTEM" | "AI";
  contentText: string | null;
  analysis: AnalysisInput;
};

const LOCKED_STAGES = new Set<ConversationStage>(["WON", "LOST", "INACTIVE"]);

const STAGE_RANK: Record<ConversationStage, number> = {
  NEW: 0,
  QUALIFIED: 1,
  QUOTED: 2,
  NEGOTIATION: 3,
  WON: 4,
  LOST: 4,
  INACTIVE: 4,
};

const CLEAR_INTEREST_INTENTS: ReadonlySet<AnalysisIntent> = new Set<AnalysisIntent>([
  "price",
  "availability",
  "booking",
]);

const PRICE_KEYWORDS = [
  "מחיר",
  "עולה",
  "עלות",
  "הצעה",
  "מחירון",
  'ש"ח',
  "שח",
  "שקל",
  "שקלים",
] as const;

/**
 * Detects an unambiguous price/quote signal in an OUTBOUND business message.
 * Conservative: requires either an explicit currency glyph (₪) or a numeric
 * value (>= 2 digits) co-located with a price keyword. Borderline messages
 * are intentionally NOT detected — better to under-promote than to write a
 * wrong stage.
 */
function detectOutboundPriceSignal(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();

  if (normalized.includes("₪")) return true;

  const hasMultiDigitNumber = /\d{2,}/.test(normalized);
  if (!hasMultiDigitNumber) return false;

  return PRICE_KEYWORDS.some((kw) => normalized.includes(kw));
}

export function mapAnalysisToConversationStage(
  input: StageMappingInput
): ConversationStage | null {
  const current: ConversationStage = input.currentStage ?? "NEW";

  if (LOCKED_STAGES.has(current)) {
    return null;
  }

  let next: ConversationStage = current;

  const isCustomerInbound =
    input.direction === "INBOUND" && input.senderType === "CUSTOMER";
  const isOutbound = input.direction === "OUTBOUND";

  // NEW → QUALIFIED — only on a customer inbound with clear interest intent.
  // Interest is signalled by intent (price/availability/booking), NOT by
  // analysisStage alone.
  if (
    next === "NEW" &&
    isCustomerInbound &&
    input.analysis !== null &&
    CLEAR_INTEREST_INTENTS.has(input.analysis.intent)
  ) {
    next = "QUALIFIED";
  }

  // QUALIFIED → QUOTED — strictly from QUALIFIED, on OUTBOUND with an
  // explicit price signal. NEW does NOT skip directly to QUOTED — the
  // customer must have signalled interest first (NEW → QUALIFIED).
  // No analysis runs on outbound today, so we rely on a deliberately strict
  // text detector.
  if (
    next === "QUALIFIED" &&
    isOutbound &&
    detectOutboundPriceSignal(input.contentText)
  ) {
    next = "QUOTED";
  }

  // QUOTED → NEGOTIATION — any customer inbound after the business has
  // quoted. This covers follow-up questions, hesitation, and objections
  // (the analyzer does not emit "objection" today, so the inbound itself
  // is the trigger).
  if (next === "QUOTED" && isCustomerInbound) {
    next = "NEGOTIATION";
  }

  // closing analyzer override — a "closing" inbound can fast-forward
  // QUALIFIED → NEGOTIATION (skipping QUOTED), but never WON.
  if (
    isCustomerInbound &&
    input.analysis?.stage === "closing" &&
    next === "QUALIFIED"
  ) {
    next = "NEGOTIATION";
  }

  if (next === current) return null;

  // Belt-and-suspenders: never demote.
  if (STAGE_RANK[next] < STAGE_RANK[current]) return null;

  return next;
}
