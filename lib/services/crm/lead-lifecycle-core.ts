/**
 * Business Intake M5 — the CRM lead lifecycle contract (pure).
 *
 * No Prisma, no ambient clock. Everything here is deterministic and works with
 * ZERO LLM availability: the lifecycle never asks a model what is true.
 *
 * ── Four things that are NOT the same field ────────────────────────────────
 *   stage        Lead.status while open: NEW → OPEN → QUALIFIED → QUOTED.
 *                Permissive direction (W1): the owner may move back.
 *   state        open / closed — derived from status, never stored twice.
 *   outcome      the terminal status (WON / LOST / DROPPED) + closedAt
 *                (+ lostReason for LOST, + finalPrice for WON).
 *   next action  WHAT (Lead.nextActionKind) and WHEN (Lead.nextFollowUpAt),
 *                with the owner's own words in followUpNote. At most one.
 *
 * ── Who may change what (authority) ────────────────────────────────────────
 *   Automatic (deterministic, evidence-backed) — ONLY these:
 *     - `created`: a lead enters at NEW (owner, import, conversation, or an
 *       explicit intake lead event routed by M4's R4_EXPLICIT_LEAD);
 *     - `intake_attached`: an explicit intake lead event for a phone that
 *       already has an open lead attaches to it (M4's one-open-lead rule);
 *     - `next_action_cleared`: closing a lead drops its open next action;
 *     - `contact_attached` / `contact_detached`: the owner's M4 identity
 *       confirmation / undo relinks the lead's Customer.
 *   Owner only — every stage change, every outcome (won / lost / dropped),
 *   reopen, next action set / reschedule / complete, values.
 *   Dubiz proposes (SUGGESTIONS below) — never applies. A suggestion becomes a
 *   next action only when the owner accepts it, and the acceptance carries the
 *   lifecycleVersion the owner saw, so a stale suggestion can never overwrite a
 *   newer owner decision.
 *
 * NOT evidence of a transition (deliberately): a message received, a quote
 * document created, an invoice created or a payment. None of them is linked to
 * a Lead in the data model, and "quote created ≠ quote sent ≠ accepted",
 * "invoice ≠ won", "payment ≠ sales outcome".
 */

import {
  isClosedLeadStatus,
  leadDayKey,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";

export const LEAD_LIFECYCLE_POLICY_VERSION = "lead-lifecycle@1";

/* ------------------------------------------------------------ next action -- */

export const LEAD_NEXT_ACTION_KINDS = [
  "call",
  "send_quote",
  "check_quote",
  "follow_up",
  "schedule_meeting",
  "collect_info",
  "wait_for_customer",
  "other",
] as const;

export type LeadNextActionKindValue = (typeof LEAD_NEXT_ACTION_KINDS)[number];

export const LEAD_NEXT_ACTION_LABELS: Record<LeadNextActionKindValue, string> = {
  call: "להתקשר",
  send_quote: "לשלוח הצעת מחיר",
  check_quote: "לבדוק אם ההצעה התקבלה",
  follow_up: "לחזור אליו",
  schedule_meeting: "לקבוע פגישה",
  collect_info: "להשלים פרטים חסרים",
  wait_for_customer: "לחכות לתשובה שלו",
  other: "משימה אחרת",
};

export function isLeadNextActionKind(value: unknown): value is LeadNextActionKindValue {
  return typeof value === "string" && (LEAD_NEXT_ACTION_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------ event kinds -- */

export const LEAD_LIFECYCLE_EVENT_KINDS = [
  "created",
  "intake_attached",
  "status_changed",
  "next_action_set",
  "next_action_rescheduled",
  "next_action_completed",
  "next_action_cleared",
  "value_updated",
  "suggestion_dismissed",
  "contact_attached",
  "contact_detached",
  "conversation_linked",
] as const;

export type LeadLifecycleEventKind = (typeof LEAD_LIFECYCLE_EVENT_KINDS)[number];

/** Owner lifecycle actions that count as "the owner handled this lead". */
export const FIRST_HANDLING_KINDS: readonly LeadLifecycleEventKind[] = [
  "status_changed",
  "next_action_set",
  "next_action_completed",
  "value_updated",
];

export const LEAD_LIFECYCLE_EVENT_LABELS: Record<LeadLifecycleEventKind, string> = {
  created: "הליד נוצר",
  intake_attached: "פנייה נוספת צורפה לליד",
  status_changed: "השלב השתנה",
  next_action_set: "נקבעה הפעולה הבאה",
  next_action_rescheduled: "הפעולה הבאה נדחתה",
  next_action_completed: "הפעולה הבאה בוצעה",
  next_action_cleared: "הפעולה הבאה בוטלה עם סגירת הליד",
  value_updated: "עודכן סכום",
  suggestion_dismissed: "הצעה של דוביז נדחתה",
  contact_attached: "הליד שויך ללקוח",
  contact_detached: "שיוך הליד ללקוח בוטל",
  conversation_linked: "שיחה צורפה לליד",
};

/* --------------------------------------------------------------- money ---- */

export const LEAD_AMOUNT_MAX = 9_999_999_999_999_999.99;

/**
 * Parse an owner-entered amount: a finite, non-negative number with at most two
 * decimals, or null to clear it. Returned as a fixed-point string so it never
 * passes through a float on its way into NUMERIC(18,2).
 */
export function parseLeadAmount(value: unknown): string | null {
  if (value === null) return null;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > LEAD_AMOUNT_MAX) {
    throw new RangeError("amount must be a non-negative number");
  }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new RangeError("amount may have at most two decimals");
  }
  return n.toFixed(2);
}

/* ---------------------------------------------------------- suggestions --- */

/**
 * Dubiz PROPOSES a next action. Deterministic rules over lifecycle facts only;
 * each carries a versioned rule id so an owner's dismissal is remembered for
 * exactly that rule until the lead changes again.
 */
export type LeadSuggestionRuleId =
  | "S1_CONTACT_NEW@1"
  | "S2_CHECK_QUOTE@1"
  | "S3_REVIVE_STALLED@1"
  | "S4_REPLY_CUSTOMER@1";

export type LeadSuggestion = {
  ruleId: LeadSuggestionRuleId;
  kind: LeadNextActionKindValue;
  /** Proposed due moment, as a day offset from today (Israel-local). */
  dueInDays: number;
  label: string;
  /** The evidence, stated — so the owner can judge it rather than trust it. */
  why: string;
};

/** Days of no recorded lead activity before a quoted lead is worth checking. */
export const QUOTE_CHECK_AFTER_DAYS = 3;
/** Days of no recorded lead activity before an open lead counts as stalled. */
export const STALLED_AFTER_DAYS = 7;

export type LeadLifecycleFacts = {
  status: LeadStatusValue;
  nextFollowUpAt: Date | null | undefined;
  createdAt: Date;
  /** Last lead write (owner or system lifecycle action). Never a message. */
  lastActivityAt: Date | null | undefined;
  /** Latest customer-inbound message on a conversation linked to this lead. */
  lastCustomerInboundAt?: Date | null;
  /** Open M4 identity proposals that name this lead. */
  openIdentityProposals?: number;
  /** Suggestion rules the owner dismissed at the lead's CURRENT version. */
  dismissedRuleIds?: readonly string[];
};

export function daysBetween(from: Date, to: Date): number {
  const toUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(leadDayKey(to)) - toUtc(leadDayKey(from))) / 86_400_000);
}

export function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 3_600_000));
}

/** Did the customer write after the last recorded activity on the lead? */
export function customerWroteSinceLastActivity(facts: LeadLifecycleFacts): boolean {
  const inbound = facts.lastCustomerInboundAt;
  if (!inbound) return false;
  const last = facts.lastActivityAt ?? facts.createdAt;
  return inbound.getTime() > last.getTime();
}

export function suggestNextAction(facts: LeadLifecycleFacts, now: Date): LeadSuggestion | null {
  if (isClosedLeadStatus(facts.status)) return null;
  // A next action already exists — the owner has a plan; Dubiz does not second-guess it.
  if (facts.nextFollowUpAt) return null;

  const dismissed = new Set(facts.dismissedRuleIds ?? []);
  const idle = daysBetween(facts.lastActivityAt ?? facts.createdAt, now);
  const candidates: LeadSuggestion[] = [];

  if (customerWroteSinceLastActivity(facts)) {
    candidates.push({
      ruleId: "S4_REPLY_CUSTOMER@1",
      kind: "follow_up",
      dueInDays: 0,
      label: "לחזור ללקוח היום",
      why: "הלקוח כתב אחרי העדכון האחרון שלכם בליד.",
    });
  }
  if (facts.status === "NEW") {
    candidates.push({
      ruleId: "S1_CONTACT_NEW@1",
      kind: "call",
      dueInDays: 0,
      label: "ליצור קשר היום",
      why: "הליד חדש ואין לו עדיין פעולה הבאה.",
    });
  }
  if (facts.status === "QUOTED" && idle >= QUOTE_CHECK_AFTER_DAYS) {
    candidates.push({
      ruleId: "S2_CHECK_QUOTE@1",
      kind: "check_quote",
      dueInDays: 0,
      label: "לבדוק אם ההצעה התקבלה",
      why: `סומן שנשלחה הצעה, ולא נרשמה פעילות על הליד ${idle} ימים.`,
    });
  }
  if ((facts.status === "OPEN" || facts.status === "QUALIFIED") && idle >= STALLED_AFTER_DAYS) {
    candidates.push({
      ruleId: "S3_REVIVE_STALLED@1",
      kind: "follow_up",
      dueInDays: 0,
      label: "לחזור אליו",
      why: `לא נרשמה פעילות על הליד ${idle} ימים ואין פעולה הבאה.`,
    });
  }
  return candidates.find((c) => !dismissed.has(c.ruleId)) ?? null;
}

/**
 * The due moment for an accepted suggestion: 10:00 Israel-local on the proposed
 * day, or one hour from now when that moment has already passed today.
 */
export function suggestionDueAt(s: LeadSuggestion, now: Date): Date {
  const day = new Date(now.getTime() + s.dueInDays * 86_400_000);
  const key = leadDayKey(day); // YYYY-MM-DD, Israel-local
  // 10:00 Asia/Jerusalem is 07:00 or 08:00 UTC; take the later (safe in both DST states).
  const candidate = new Date(`${key}T08:00:00.000Z`);
  return candidate.getTime() > now.getTime() ? candidate : new Date(now.getTime() + 3_600_000);
}

/* ------------------------------------------------------------- sensors ---- */

/** Where a lead came from, as a closed vocabulary (the LEAD_LIFECYCLE_STARTED payload). */
export type LeadOrigin = "MANUAL" | "CONVERSATION" | "AUTO_CAPTURE" | "IMPORT" | "INTAKE";

export function leadOriginFor(sourceChannel: string | null, source: string | undefined): LeadOrigin {
  if (sourceChannel?.startsWith("intake:")) return "INTAKE";
  if (source === "IMPORT") return "IMPORT";
  if (source === "SYSTEM") return "AUTO_CAPTURE";
  if (sourceChannel && sourceChannel !== "MANUAL") return "CONVERSATION";
  return "MANUAL";
}
