/**
 * Leads W2 — the Needs-Attention contract.
 *
 * ONE deterministic answer to "does this lead want the owner right now, why,
 * how badly, and what is the next thing to do". Every Leads surface — the
 * Inbox, Home, Attention — derives from THIS function, so the three can never
 * disagree about the same lead.
 *
 * Pure, like `lead-core.ts`: no Prisma, no ambient clock. Derived at READ time
 * and never stored — a stored `needsAttention` is a second source of truth that
 * goes stale the moment a day passes without a write.
 *
 * ── What it deliberately does NOT use ───────────────────────────────────────
 * Nothing here reads `Conversation.temperatureScore`, `unansweredInboundCount`,
 * `currentStage` or the inbound/outbound timestamps.
 *
 *   - `currentStage` / `temperatureScore` / `closeProbabilitySnapshot` are written
 *     ONLY by `applyMessageEvent`, behind `CONVERSATION_STATE_WRITER_ENABLED`.
 *     That flag IS defined in Production, but its effective value is not
 *     readable (recorded as UNKNOWN at the Business Intake M1 gate, owner
 *     decision 2026-09-26). Deriving "hot" or "stalled quote" from columns that
 *     may be unpopulated would render a confident badge over possibly no
 *     evidence.
 *   - the timestamps and `unansweredInboundCount` are, since Business Intake M2,
 *     written for every message by `conversation-activity.ts`, independent of
 *     that flag — so a "waiting" signal could be derived from them. Doing so is
 *     a lead-lifecycle change (M5), not made here.
 *
 * So W2 surfaces only what W1 genuinely writes: the follow-up clock, the
 * status, and when the lead arrived. Conversation-derived signals can be added
 * here — additively, behind their own evidence check — without changing
 * anything that already works.
 */

import {
  evaluateLeadFollowUp,
  isClosedLeadStatus,
  leadDayKey,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";
import {
  QUOTE_CHECK_AFTER_DAYS,
  STALLED_AFTER_DAYS,
  customerWroteSinceLastActivity,
  suggestNextAction,
  type LeadSuggestion,
} from "@/lib/services/crm/lead-lifecycle-core";

/** Why a lead is asking for the owner. Ordered most- to least-urgent. */
export type LeadAttentionReason =
  | "FOLLOWUP_OVERDUE"
  | "CUSTOMER_CALLED"
  | "CUSTOMER_WROTE"
  | "FOLLOWUP_DUE_TODAY"
  | "AWAITING_OWNER_DECISION"
  | "NEW_UNHANDLED"
  | "QUOTE_NO_ACTIVITY"
  | "STALLED";

/**
 * M5 — how much the system is claiming. A FACT is recorded data read back (a
 * due time the owner set, a message that arrived, an open question to the
 * owner). An INFERENCE is a deterministic rule over facts ("no recorded
 * activity for N days"). A suggestion is never a reason: it is Dubiz
 * proposing, carried separately in `suggestion`.
 */
export type LeadEvidenceClass = "fact" | "inference";

export const LEAD_REASON_EVIDENCE: Record<LeadAttentionReason, LeadEvidenceClass> = {
  FOLLOWUP_OVERDUE: "fact",
  CUSTOMER_CALLED: "fact",
  CUSTOMER_WROTE: "fact",
  FOLLOWUP_DUE_TODAY: "fact",
  AWAITING_OWNER_DECISION: "fact",
  NEW_UNHANDLED: "inference",
  QUOTE_NO_ACTIVITY: "inference",
  STALLED: "inference",
};

/** What the owner should do next. `none` = nothing is being asked of them. */
export type LeadNextActionKind =
  | "complete_followup"
  | "call_back"
  | "contact_new_lead"
  | "set_followup"
  | "none";

export type LeadNextAction = {
  kind: LeadNextActionKind;
  label: string;
};

export type LeadAttention = {
  needsAttention: boolean;
  reason: LeadAttentionReason | null;
  /** M5 — fact or deterministic inference (null when nothing is asked). */
  evidenceClass?: LeadEvidenceClass | null;
  /** M5 — Dubiz's proposed next action, if any. A proposal; never applied by itself. */
  suggestion?: LeadSuggestion | null;
  /** 0–100. Comparable ACROSS reasons so one queue can be sorted honestly. */
  priority: number;
  nextAction: LeadNextAction;
};

/**
 * How long a brand-new lead may sit untouched before it counts as neglected.
 *
 * A calendar day, not an hour count: a lead that arrives at 23:50 has not been
 * neglected at 00:10. The comparison is on Israel-local day keys, the same
 * clock the follow-up rules use.
 */
export const NEW_LEAD_GRACE_DAYS = 1;

export type LeadAttentionInput = {
  status: LeadStatusValue;
  nextFollowUpAt: Date | null | undefined;
  createdAt: Date;
  /** M5 (optional): last lead write — enables the QUOTE_NO_ACTIVITY / STALLED inferences. */
  lastActivityAt?: Date | null;
  /** M5 (optional): latest customer-inbound message on a conversation linked to the lead. */
  lastCustomerInboundAt?: Date | null;
  /**
   * M7-A (optional): the latest inbound call from this lead's customer that was missed and not
   * returned (CallActivity). Recorded lead activity after it counts as handled.
   */
  lastUnreturnedCallAt?: Date | null;
  /** M5 (optional): open M4 identity proposals naming this lead. */
  openIdentityProposals?: number;
  /** M5 (optional): suggestion rules dismissed at the lead's current version. */
  dismissedRuleIds?: readonly string[];
};

function dayDelta(from: Date, to: Date): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(leadDayKey(to)) - toUtc(leadDayKey(from))) / 86_400_000);
}

const NOTHING: LeadAttention = {
  needsAttention: false,
  reason: null,
  priority: 0,
  nextAction: { kind: "none", label: "" },
};

/**
 * Evaluate a lead.
 *
 * Priority bands are chosen so the reasons stay ordered no matter how old an
 * item gets: an overdue follow-up always outranks one due today, which always
 * outranks an untouched new lead. Age moves an item WITHIN its band, never
 * across one — otherwise a two-week-old new lead would outrank a follow-up the
 * owner promised for this morning.
 */
export function evaluateLeadAttention(
  input: LeadAttentionInput,
  now: Date
): LeadAttention {
  const base = evaluateCoreAttention(input, now);
  if (isClosedLeadStatus(input.status)) return base;
  const suggestion = suggestNextAction(
    {
      status: input.status,
      nextFollowUpAt: input.nextFollowUpAt,
      createdAt: input.createdAt,
      lastActivityAt: input.lastActivityAt ?? null,
      lastCustomerInboundAt: input.lastCustomerInboundAt ?? null,
      openIdentityProposals: input.openIdentityProposals,
      dismissedRuleIds: input.dismissedRuleIds,
    },
    now
  );
  return {
    ...base,
    evidenceClass: base.reason ? LEAD_REASON_EVIDENCE[base.reason] : null,
    suggestion,
  };
}

function evaluateCoreAttention(
  input: LeadAttentionInput,
  now: Date
): LeadAttention {
  // A decided lead asks nothing of anyone.
  if (isClosedLeadStatus(input.status)) return NOTHING;

  const followUp = evaluateLeadFollowUp(input.nextFollowUpAt, now);

  if (followUp.kind === "overdue") {
    return {
      needsAttention: true,
      reason: "FOLLOWUP_OVERDUE",
      priority: Math.min(95, 80 + Math.min(followUp.overdueDays, 15)),
      nextAction: { kind: "complete_followup", label: "חזרו אליו — המעקב באיחור" },
    };
  }

  // M7-A — the customer CALLED, the call was missed, nobody called back, and nothing
  // was recorded on the lead since (a fact, from CallActivity). Ranked above a
  // written message: a caller is waiting on the phone, not in a thread.
  if (input.lastUnreturnedCallAt) {
    const handledAt = Math.max(input.createdAt.getTime(), input.lastActivityAt?.getTime() ?? 0);
    if (input.lastUnreturnedCallAt.getTime() > handledAt) {
      return {
        needsAttention: true,
        reason: "CUSTOMER_CALLED",
        priority: 78,
        nextAction: { kind: "call_back", label: "הלקוח התקשר — חזרו אליו" },
      };
    }
  }

  // M5 — the customer wrote after the last recorded activity on the lead (a
  // fact, from M2's per-message conversation timestamps).
  if (
    input.lastCustomerInboundAt !== undefined &&
    customerWroteSinceLastActivity({
      status: input.status,
      nextFollowUpAt: input.nextFollowUpAt,
      createdAt: input.createdAt,
      lastActivityAt: input.lastActivityAt ?? null,
      lastCustomerInboundAt: input.lastCustomerInboundAt,
    })
  ) {
    return {
      needsAttention: true,
      reason: "CUSTOMER_WROTE",
      priority: 75,
      nextAction: { kind: "set_followup", label: "הלקוח כתב — ענו לו" },
    };
  }

  if (followUp.kind === "due_today") {
    return {
      needsAttention: true,
      reason: "FOLLOWUP_DUE_TODAY",
      priority: 70,
      nextAction: { kind: "complete_followup", label: "היום צריך לחזור אליו" },
    };
  }

  // M5 — Dubiz asked the owner who this lead is (an open M4 identity proposal).
  if ((input.openIdentityProposals ?? 0) > 0) {
    return {
      needsAttention: true,
      reason: "AWAITING_OWNER_DECISION",
      priority: 66,
      nextAction: { kind: "set_followup", label: "אשרו למי שייך הליד" },
    };
  }

  // An untouched new lead: it arrived, nobody moved it, and nobody promised to.
  if (input.status === "NEW" && !input.nextFollowUpAt) {
    const age = dayDelta(input.createdAt, now);
    if (age >= NEW_LEAD_GRACE_DAYS) {
      return {
        needsAttention: true,
        reason: "NEW_UNHANDLED",
        priority: Math.min(65, 45 + Math.min(age, 20)),
        nextAction: { kind: "contact_new_lead", label: "ליד חדש — צרו קשר" },
      };
    }
  }

  // M5 — deterministic inferences over the lead's OWN recorded activity. Worded
  // as "no recorded activity", never "no response": a message is not a lead write.
  if (followUp.kind === "none" && input.lastActivityAt !== undefined) {
    const idle = dayDelta(input.lastActivityAt ?? input.createdAt, now);
    if (input.status === "QUOTED" && idle >= QUOTE_CHECK_AFTER_DAYS) {
      return {
        needsAttention: true,
        reason: "QUOTE_NO_ACTIVITY",
        priority: Math.min(44, 35 + Math.min(idle, 9)),
        nextAction: { kind: "set_followup", label: "בדקו אם ההצעה התקבלה" },
      };
    }
    if ((input.status === "OPEN" || input.status === "QUALIFIED") && idle >= STALLED_AFTER_DAYS) {
      return {
        needsAttention: true,
        reason: "STALLED",
        priority: Math.min(34, 20 + Math.min(idle - STALLED_AFTER_DAYS, 14)),
        nextAction: { kind: "set_followup", label: "הליד תקוע — קבעו צעד הבא" },
      };
    }
  }

  // Open, nothing overdue — but a lead with no follow-up at all is one the
  // owner is relying on memory for. Suggest the fix without demanding it.
  if (followUp.kind === "none") {
    return {
      ...NOTHING,
      nextAction: { kind: "set_followup", label: "קבעו מתי לחזור אליו" },
    };
  }

  return NOTHING;
}

/** Hebrew label for a reason — one wording, shared by every surface. */
export function leadAttentionReasonLabel(reason: LeadAttentionReason): string {
  switch (reason) {
    case "FOLLOWUP_OVERDUE":
      return "מעקב באיחור";
    case "FOLLOWUP_DUE_TODAY":
      return "מעקב להיום";
    case "CUSTOMER_CALLED":
      return "הלקוח התקשר ולא חזרתם";
    case "NEW_UNHANDLED":
      return "ליד חדש שלא טופל";
    case "CUSTOMER_WROTE":
      return "הלקוח כתב";
    case "AWAITING_OWNER_DECISION":
      return "מחכה להחלטה שלכם";
    case "QUOTE_NO_ACTIVITY":
      return "הצעה בלי המשך";
    case "STALLED":
      return "ליד תקוע";
  }
}

/**
 * Explanation shown on the Attention surface. States the evidence, so the owner
 * can tell whether the system is right rather than being asked to trust it.
 */
export function leadAttentionSummary(
  attention: LeadAttention,
  followUpAt: Date | null | undefined,
  now: Date
): string {
  switch (attention.reason) {
    case "FOLLOWUP_OVERDUE": {
      const state = evaluateLeadFollowUp(followUpAt, now);
      const days = state.kind === "overdue" ? state.overdueDays : 0;
      return days === 1
        ? "קבעתם לחזור אליו אתמול."
        : `קבעתם לחזור אליו לפני ${days} ימים.`;
    }
    case "FOLLOWUP_DUE_TODAY":
      return "קבעתם לחזור אליו היום.";
    case "NEW_UNHANDLED":
      return "הליד נכנס ועדיין לא נגעתם בו.";
    case "CUSTOMER_WROTE":
      return "הלקוח כתב אחרי העדכון האחרון שלכם בליד.";
    case "CUSTOMER_CALLED":
      return "הלקוח התקשר, השיחה לא נענתה, ולא חזרתם אליו מאז.";
    case "AWAITING_OWNER_DECISION":
      return "דוביז לא בטוח לאיזה לקוח הליד שייך, ומחכה לאישור שלכם.";
    case "QUOTE_NO_ACTIVITY":
      return "סומן שנשלחה הצעה, ומאז לא נרשמה פעילות על הליד.";
    case "STALLED":
      return "לא נרשמה פעילות על הליד כבר שבוע, ואין פעולה הבאה.";
    default:
      return "";
  }
}
