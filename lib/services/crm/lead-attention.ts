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
 * `currentStage` or the inbound/outbound timestamps. Those fields are written
 * ONLY by `applyMessageEvent`, which is gated behind
 * `CONVERSATION_STATE_WRITER_ENABLED` — a flag that is absent from every
 * environment. Deriving "hot", "cooling", "waiting" or "stalled quote" from
 * columns nobody populates would render a confident badge over no evidence.
 *
 * So W2 surfaces only what W1 genuinely writes: the follow-up clock, the
 * status, and when the lead arrived. When the state writer is switched on, the
 * conversation-derived signals can be added here — additively, behind their own
 * evidence check — without changing anything that already works.
 */

import {
  evaluateLeadFollowUp,
  isClosedLeadStatus,
  leadDayKey,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";

/** Why a lead is asking for the owner. Ordered most- to least-urgent. */
export type LeadAttentionReason =
  | "FOLLOWUP_OVERDUE"
  | "FOLLOWUP_DUE_TODAY"
  | "NEW_UNHANDLED";

/** What the owner should do next. `none` = nothing is being asked of them. */
export type LeadNextActionKind =
  | "complete_followup"
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

  if (followUp.kind === "due_today") {
    return {
      needsAttention: true,
      reason: "FOLLOWUP_DUE_TODAY",
      priority: 70,
      nextAction: { kind: "complete_followup", label: "היום צריך לחזור אליו" },
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
    case "NEW_UNHANDLED":
      return "ליד חדש שלא טופל";
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
    default:
      return "";
  }
}
