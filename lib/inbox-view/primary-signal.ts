import type {
  ConversationStage,
  ConversationStatus,
} from "@prisma/client";
import type {
  PrimarySignalKind,
  SignalSeverity,
} from "./inbox-item.types";

/**
 * Pure rule-based primary signal evaluator.
 *
 * Returns the single most important signal for a conversation given its
 * current state, plus a Hebrew display label and severity bucket.
 *
 * Priority order (locked, v1):
 *   1. customer_waiting
 *   2. stalled_quote
 *   3. hot_negotiation
 *   4. needs_followup
 *   5. cooling
 *   6. fresh_lead
 *   7. neutral
 *
 * Conservative defaults: when state fields are null (because the writer
 * has not yet stamped the conversation), the evaluator degrades to the
 * weakest applicable signal — never inflates importance.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOT_TEMPERATURE = 0.7;
const COLD_TEMPERATURE = 0.3;

export type SignalEvaluationInput = {
  status: ConversationStatus;
  currentStage: ConversationStage | null;
  unansweredInboundCount: number;
  customerLastInboundAt: Date | null;
  businessLastOutboundAt: Date | null;
  lastMessageAt: Date | null;
  temperatureScore: number | null;
  hasPendingSuggestion: boolean;
  now: Date;
};

export type SignalEvaluationResult = {
  kind: PrimarySignalKind;
  label: string;
  severity: SignalSeverity;
};

export function evaluatePrimarySignal(
  input: SignalEvaluationInput
): SignalEvaluationResult {
  const {
    status,
    currentStage,
    unansweredInboundCount,
    customerLastInboundAt,
    businessLastOutboundAt,
    lastMessageAt,
    temperatureScore,
    now,
  } = input;

  if (status !== "OPEN") {
    return { kind: "neutral", label: "סגורה", severity: "info" };
  }

  // 1. customer_waiting — at least one unanswered inbound from the customer
  if (unansweredInboundCount >= 1 && customerLastInboundAt) {
    const waitMs = now.getTime() - customerLastInboundAt.getTime();
    if (waitMs > DAY_MS) {
      const days = Math.max(1, Math.floor(waitMs / DAY_MS));
      return {
        kind: "customer_waiting",
        label: `ממתין ${days} ימים`,
        severity: "critical",
      };
    }
    if (waitMs > 4 * HOUR_MS) {
      return {
        kind: "customer_waiting",
        label: "ממתין למענה",
        severity: "high",
      };
    }
    return {
      kind: "customer_waiting",
      label: "ממתין למענה",
      severity: "medium",
    };
  }

  // 2. stalled_quote — QUOTED, business sent last, customer did not reply
  if (
    currentStage === "QUOTED" &&
    businessLastOutboundAt &&
    (!customerLastInboundAt ||
      customerLastInboundAt.getTime() < businessLastOutboundAt.getTime())
  ) {
    const sinceQuoteMs = now.getTime() - businessLastOutboundAt.getTime();
    if (sinceQuoteMs > 3 * DAY_MS) {
      return {
        kind: "stalled_quote",
        label: "הצעת מחיר תקועה",
        severity: "critical",
      };
    }
    if (sinceQuoteMs > DAY_MS) {
      return {
        kind: "stalled_quote",
        label: "הצעת מחיר ממתינה",
        severity: "high",
      };
    }
  }

  // 3. hot_negotiation — NEGOTIATION + temperature is high
  if (
    currentStage === "NEGOTIATION" &&
    temperatureScore !== null &&
    temperatureScore >= HOT_TEMPERATURE
  ) {
    return {
      kind: "hot_negotiation",
      label: "משא ומתן חם",
      severity: "high",
    };
  }

  // 4. needs_followup — business sent last, extended silence, not a quote
  if (
    currentStage !== "QUOTED" &&
    businessLastOutboundAt &&
    (!customerLastInboundAt ||
      customerLastInboundAt.getTime() < businessLastOutboundAt.getTime())
  ) {
    const sinceMs = now.getTime() - businessLastOutboundAt.getTime();
    if (sinceMs > 3 * DAY_MS) {
      return {
        kind: "needs_followup",
        label: "מומלץ מעקב",
        severity: "medium",
      };
    }
  }

  // 5. cooling — temperature dropped and no recent activity
  if (
    temperatureScore !== null &&
    temperatureScore < COLD_TEMPERATURE &&
    lastMessageAt &&
    now.getTime() - lastMessageAt.getTime() > 2 * DAY_MS
  ) {
    return {
      kind: "cooling",
      label: "שיחה התקררה",
      severity: "medium",
    };
  }

  // 6. fresh_lead — NEW (or null) recently active, OR QUALIFIED
  if (
    (currentStage === "NEW" || currentStage === null) &&
    lastMessageAt &&
    now.getTime() - lastMessageAt.getTime() < DAY_MS
  ) {
    return {
      kind: "fresh_lead",
      label: "ליד חדש",
      severity: "medium",
    };
  }
  if (currentStage === "NEW" || currentStage === null) {
    return {
      kind: "fresh_lead",
      label: "ליד חדש",
      severity: "low",
    };
  }
  if (currentStage === "QUALIFIED") {
    return {
      kind: "fresh_lead",
      label: "ליד פעיל",
      severity: "low",
    };
  }

  // 7. neutral — fallback
  return { kind: "neutral", label: "שיחה פעילה", severity: "info" };
}
