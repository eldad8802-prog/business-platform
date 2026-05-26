import type { ConversationStatus } from "@prisma/client";
import type {
  InboxBotFlowStatus,
  NextBestAction,
  NextBestActionSource,
  PrimarySignalKind,
  SignalSeverity,
  SuggestedActionKind,
  TemperatureBucket,
} from "./inbox-item.types";

export type EvaluateNextBestActionInput = {
  status: ConversationStatus;
  primarySignal: PrimarySignalKind;
  signalSeverity: SignalSeverity;
  suggestedAction: SuggestedActionKind;
  suggestedActionLabel: string;
  needsHumanAttention: boolean;
  botFlowStatus: InboxBotFlowStatus;
  /** Passed for parity with serializer context; tiers use `replySuggestions` rows. */
  hasPendingSuggestion: boolean;
  waitingMinutes: number | null;
  temperatureBucket: TemperatureBucket;
  replySuggestions: ReadonlyArray<{
    status: string;
    suggestionType?: string | null;
  }>;
};

function withLegacy(
  partial: Omit<NextBestAction, "legacySuggestedAction"> & {
    legacySuggestedAction?: SuggestedActionKind;
  },
  legacy: SuggestedActionKind
): NextBestAction {
  return { ...partial, legacySuggestedAction: legacy };
}

/**
 * Deterministic single “next best action” for inbox (v1).
 * Does not replace `suggestedAction` / `suggestedActionLabel`; callers keep both.
 */
export function evaluateNextBestAction(
  input: EvaluateNextBestActionInput
): NextBestAction {
  const legacy = input.suggestedAction;

  if (input.status !== "OPEN") {
    return withLegacy(
      {
        kind: "none",
        label: "",
        severity: "info",
        reason: "nba.v1.conversation_not_open",
        source: "conversation_status",
      },
      legacy
    );
  }

  if (input.needsHumanAttention || input.signalSeverity === "critical") {
    const source: NextBestActionSource = input.needsHumanAttention
      ? "needs_human_attention_rule"
      : "signal_severity_critical";
    const reason = input.needsHumanAttention
      ? "nba.v1.needs_human_attention"
      : "nba.v1.signal_severity_critical";
    return withLegacy(
      {
        kind: "immediate_attention",
        label: "דורש תשומת לב מיידית",
        severity: "critical",
        reason,
        source,
      },
      legacy
    );
  }

  if (input.botFlowStatus === "HANDOFF") {
    return withLegacy(
      {
        kind: "agent_handoff",
        label: "טפל במעבר לנציג (בוט)",
        severity: "high",
        reason: "nba.v1.bot_flow_handoff",
        source: "bot_flow_handoff",
      },
      legacy
    );
  }

  const hasGeneratedOpen = input.replySuggestions.some(
    (s) => s.status === "GENERATED"
  );
  const hasStarterBotDraftOpen = input.replySuggestions.some(
    (s) => s.suggestionType === "STARTER_BOT_DRAFT"
  );

  if (hasGeneratedOpen || hasStarterBotDraftOpen) {
    const label = hasGeneratedOpen
      ? "טיוטה מהמערכת מוכנה לשליחה"
      : "טיוטה מהמערכת פתוחה · עברו להצעות למענה";
    const source: NextBestActionSource = hasGeneratedOpen
      ? "draft_ready_generated"
      : "draft_ready_starter_bot";
    const reason = hasGeneratedOpen
      ? "nba.v1.open_reply_suggestion_generated"
      : "nba.v1.starter_bot_draft_pending";
    return withLegacy(
      {
        kind: "send_ready_draft",
        label,
        severity: "high",
        reason,
        source,
      },
      legacy
    );
  }

  if (input.primarySignal === "customer_waiting") {
    let label =
      input.suggestedActionLabel.trim() || "לקוח ממתין למענה";
    const wm = input.waitingMinutes;
    if (wm !== null && wm > 0) {
      const clock = wm < 60 ? `${wm} דק׳` : `${Math.floor(wm / 60)} שעות`;
      if (!label.includes("דק") && !label.includes("שע")) {
        label = `${label} (${clock})`;
      }
    }
    // `critical` already handled above (immediate_attention); narrowed away here.
    const sev: SignalSeverity =
      input.signalSeverity === "high" ? "high" : "medium";
    return withLegacy(
      {
        kind: "respond_waiting_customer",
        label,
        severity: sev,
        reason: "nba.v1.primary_signal_customer_waiting",
        source: "customer_waiting_clock",
      },
      legacy
    );
  }

  if (input.primarySignal === "stalled_quote") {
    return withLegacy(
      {
        kind: "review_stalled_quote",
        label: input.suggestedActionLabel.trim() || "בדוק הצעת מחיר תקועה",
        severity: "high",
        reason: "nba.v1.primary_signal_stalled_quote",
        source: "stalled_quote_signal",
      },
      legacy
    );
  }

  if (
    input.primarySignal === "hot_negotiation" ||
    (input.temperatureBucket === "hot" && input.primarySignal === "fresh_lead")
  ) {
    const isNegotiation = input.primarySignal === "hot_negotiation";
    return withLegacy(
      {
        kind: "engage_hot_thread",
        label: isNegotiation
          ? "משא ומתן חם — התמקדו"
          : "ליד חם — התמקדו",
        severity: "high",
        reason: isNegotiation
          ? "nba.v1.hot_negotiation_signal"
          : "nba.v1.hot_temperature_fresh_lead",
        source: isNegotiation
          ? "hot_negotiation_signal"
          : "temperature_hot_bucket",
      },
      legacy
    );
  }

  if (
    input.primarySignal === "needs_followup" ||
    input.primarySignal === "cooling"
  ) {
    const source: NextBestActionSource =
      input.primarySignal === "needs_followup"
        ? "needs_followup_signal"
        : "cooling_signal";
    return withLegacy(
      {
        kind: "follow_up_or_warm",
        label:
          input.suggestedActionLabel.trim() || "שלח מעקב / חמם מחדש",
        severity: "medium",
        reason: "nba.v1.followup_or_cooling",
        source,
      },
      legacy
    );
  }

  if (input.primarySignal === "fresh_lead") {
    return withLegacy(
      {
        kind: "nurture_fresh_lead",
        label: input.suggestedActionLabel.trim() || "ליד חדש — עקבו",
        severity: "low",
        reason: "nba.v1.fresh_lead",
        source: "fresh_lead_signal",
      },
      legacy
    );
  }

  if (input.primarySignal === "neutral") {
    return withLegacy(
      {
        kind: "monitor_active",
        label: input.suggestedActionLabel.trim() || "שיחה פעילה",
        severity: "info",
        reason: "nba.v1.neutral_fallback",
        source: "neutral_fallback",
      },
      legacy
    );
  }

  return withLegacy(
    {
      kind: "none",
      label: "",
      severity: "info",
      reason: "nba.v1.unmatched_primary_signal",
      source: "neutral_fallback",
    },
    legacy
  );
}