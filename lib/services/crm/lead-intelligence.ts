/**
 * Lead Intelligence — W3.
 *
 * Dubiz already understands conversations: the Conversation State Writer keeps
 * `Conversation` live, and `lib/inbox-view/*` turns a conversation row into a
 * signal, a temperature, a situation and a next best action. Until W3 all of
 * that stopped at the Inbox, so the screen where the owner actually decides —
 * Leads — showed a bare list of conversation ids.
 *
 * This module is the bridge, and it is deliberately thin:
 *
 *   - It computes NOTHING that `lib/inbox-view` already computes. Every signal
 *     here comes out of `serializeInboxItem`, the same function the Inbox uses,
 *     so the two surfaces can never disagree. There is no lead temperature
 *     engine and there never should be.
 *   - It is PURE: no I/O, no Prisma, no clock of its own (`now` is injected).
 *     The callers own the queries; this owns the meaning.
 *   - It is READ-TIME. Nothing here is stored, so nothing here can drift.
 *
 * ── The boundary this file must never cross ────────────────────────────────
 *
 * `Conversation.currentStage` is EVIDENCE — what the system observed happening
 * in the thread. `Lead.status` is the OWNER'S DECISION about the opportunity.
 * A conversation that reads as NEGOTIATION next to a lead the owner still calls
 * "בטיפול" is not a conflict to be reconciled; it is the system reporting and
 * the owner deciding. Nothing in this module returns a status, suggests a
 * status write, or is consumed by a status write.
 */

import {
  serializeInboxItem,
  type SerializeInboxItemInput,
} from "@/lib/inbox-view/inbox-item.serializer";
import type {
  InboxItemViewModel,
  PrimarySignalKind,
  TemperatureBucket,
} from "@/lib/inbox-view/inbox-item.types";
import type { LeadAttention } from "@/lib/services/crm/lead-attention";
import { isClosedLeadStatus, type LeadStatusValue } from "@/lib/services/crm/lead-core";

/* ────────────────────────────── public shape ───────────────────────────── */

/**
 * What the lead surfaces get to know about the live conversation.
 *
 * Every field is a READOUT of conversation state — never a lead field, never a
 * status, never anything the owner has to accept.
 */
export type LeadConversationIntelligence = {
  /** The conversation these readings describe. See `pickPrimaryConversation`. */
  conversationId: number;
  /** How many conversations the lead has in total (this one is the primary). */
  conversationCount: number;
  /** Evidence stage — NOT the lead's status. */
  conversationStage: string | null;
  temperatureBucket: TemperatureBucket;
  temperatureScore: number | null;
  primarySignal: PrimarySignalKind;
  signalLabel: string;
  signalSeverity: InboxItemViewModel["signalSeverity"];
  /** Minutes the customer has been waiting for a reply, when they are waiting. */
  waitingMinutes: number | null;
  /** Customer-inbound messages since the business last spoke, on the primary. */
  unansweredInboundCount: number;
  /** Most recent message across ALL of the lead's conversations. */
  lastMessageAt: string | null;
  /** What Dubiz suggests doing about the thread. Advisory only. */
  nextBestAction: { kind: string; label: string; reason: string } | null;
  /** The owner-facing reading of the situation, when one is derived. */
  businessSituation: { kind: string; label: string } | null;
};

/** Why a lead sits where it sits in the queue. */
export type LeadPriorityReasonKind =
  | "FOLLOWUP_OVERDUE"
  | "CUSTOMER_WAITING_LONG"
  | "FOLLOWUP_DUE_TODAY"
  | "CUSTOMER_WAITING"
  | "NEW_UNHANDLED"
  | "HOT_THREAD"
  | "NONE";

export type LeadPriority = {
  /** 0–100, comparable across every reason so one queue sorts honestly. */
  score: number;
  reason: LeadPriorityReasonKind;
  /** Short Hebrew explanation of the score. Never an internal enum name. */
  label: string;
  /**
   * Every reason that applied, strongest first — so the UI can show one line
   * without pretending the others do not exist.
   */
  contributing: LeadPriorityReasonKind[];
};

/* ─────────────────────── conversation → view models ────────────────────── */

/**
 * The rows this module needs. Structurally identical to what the Inbox route
 * already selects, so callers can reuse that exact include shape.
 */
export type LeadConversationRow = SerializeInboxItemInput["conversation"];

/**
 * How long a customer may wait before waiting becomes the loudest thing about
 * the lead. Four hours matches the threshold `evaluatePrimarySignal` already
 * uses to escalate `customer_waiting`, so the two surfaces agree on "long".
 */
export const LONG_WAIT_MINUTES = 4 * 60;

const HOT_SIGNALS: ReadonlySet<PrimarySignalKind> = new Set<PrimarySignalKind>([
  "hot_negotiation",
  "fresh_lead",
]);

/**
 * Rank a conversation by how much it is asking of the owner RIGHT NOW.
 *
 * This is the deterministic ordering behind `pickPrimaryConversation`; it is
 * intentionally coarse, because the fine-grained judgement already happened
 * inside the signal engine.
 */
function urgencyRank(item: InboxItemViewModel): number {
  if (item.status !== "OPEN") return 0;
  if (item.primarySignal === "customer_waiting") return 4;
  if (item.signalSeverity === "critical") return 3;
  if (item.temperatureBucket === "hot") return 2;
  return 1;
}

/**
 * Choose the one conversation whose readings represent the lead.
 *
 * A lead can carry several conversations (`Conversation.leadId` is a to-many),
 * and blending them would invent numbers nobody can explain — "waiting 18
 * minutes" must mean one real thread, not an average of three. So the contract
 * is: pick ONE, deterministically, and report only its readings.
 *
 * Order: highest urgency, then most recent message, then highest id. The last
 * tiebreak exists so the answer is stable for two conversations that are
 * identical in every other respect — the same input always yields the same
 * primary, which is what makes the priority score reproducible.
 *
 * Returns null when the lead has no conversations at all.
 */
export function pickPrimaryConversation<T extends { item: InboxItemViewModel }>(
  entries: readonly T[]
): T | null {
  if (entries.length === 0) return null;

  let best = entries[0];
  let bestRank = urgencyRank(best.item);

  for (let i = 1; i < entries.length; i += 1) {
    const candidate = entries[i];
    const rank = urgencyRank(candidate.item);
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
      continue;
    }
    if (rank < bestRank) continue;

    const a = candidate.item.lastActivityAt
      ? new Date(candidate.item.lastActivityAt).getTime()
      : 0;
    const b = best.item.lastActivityAt
      ? new Date(best.item.lastActivityAt).getTime()
      : 0;
    if (a > b || (a === b && candidate.item.conversationId > best.item.conversationId)) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Turn a lead's conversation rows into the single intelligence readout the
 * lead surfaces render.
 *
 * `lastMessageAt` is the ONE field aggregated across all conversations — "when
 * did I last hear anything from this person" is a question about the person,
 * not about a thread. Everything else describes the primary conversation, and
 * says so.
 */
export function deriveLeadConversationIntelligence(input: {
  conversations: readonly LeadConversationRow[];
  now?: Date;
}): LeadConversationIntelligence | null {
  const { conversations } = input;
  if (conversations.length === 0) return null;

  const now = input.now ?? new Date();

  // The view model carries the derived signals; the ROW carries the raw counters
  // the writer maintains (`temperatureScore`, `unansweredInboundCount`), which
  // the Inbox view model does not re-expose. Keeping them paired means the
  // readout never mixes one conversation's signal with another's numbers.
  const entries = conversations.map((conversation) => ({
    row: conversation,
    item: serializeInboxItem({ conversation, now }),
  }));

  const primary = pickPrimaryConversation(entries);
  if (!primary) return null;

  const lastMessageAt = entries.reduce<string | null>((latest, entry) => {
    const candidate = entry.row.lastMessageAt ?? entry.item.lastMessage?.at ?? null;
    if (!candidate) return latest;
    const iso = candidate instanceof Date ? candidate.toISOString() : candidate;
    if (!latest) return iso;
    return new Date(iso).getTime() > new Date(latest).getTime() ? iso : latest;
  }, null);

  const { item, row } = primary;

  return {
    conversationId: item.conversationId,
    conversationCount: entries.length,
    conversationStage: item.currentStage ?? null,
    temperatureBucket: item.temperatureBucket,
    temperatureScore: typeof row.temperatureScore === "number" ? row.temperatureScore : null,
    primarySignal: item.primarySignal,
    signalLabel: item.signalLabel,
    signalSeverity: item.signalSeverity,
    waitingMinutes: item.waitingMinutes ?? null,
    unansweredInboundCount: row.unansweredInboundCount ?? 0,
    lastMessageAt,
    nextBestAction: item.nextBestAction
      ? {
          kind: item.nextBestAction.kind,
          label: item.nextBestAction.label,
          reason: item.nextBestAction.reason,
        }
      : null,
    businessSituation: item.businessSituation
      ? {
          kind: item.businessSituation.kind,
          label: item.businessSituation.shortLabel || item.businessSituation.label || "",
        }
      : null,
  };
}

/* ────────────────────────────── priority ───────────────────────────────── */

const PRIORITY_LABELS: Record<LeadPriorityReasonKind, string> = {
  FOLLOWUP_OVERDUE: "המעקב באיחור",
  CUSTOMER_WAITING_LONG: "הלקוח ממתין לתשובה",
  FOLLOWUP_DUE_TODAY: "מעקב להיום",
  CUSTOMER_WAITING: "יש הודעה שלא נענתה",
  NEW_UNHANDLED: "ליד חדש שלא טופל",
  HOT_THREAD: "השיחה חמה",
  NONE: "",
};

/**
 * One comparable number for "who needs me next".
 *
 * The bands are chosen so the ORDER between reasons is fixed and age only moves
 * an item within its own band — the rule W2 established for follow-ups, now
 * extended to cover what the conversation says:
 *
 *   80–95  follow-up overdue        (unchanged from W2)
 *   72–78  customer waiting > 4h
 *   70     follow-up due today      (unchanged from W2)
 *   55–68  customer waiting
 *   45–65  new lead untouched       (unchanged from W2)
 *   40–50  hot thread, nobody waiting
 *   0      nothing is being asked
 *
 * A promise the owner made and broke still outranks everything, which is the
 * one ordering W2 proved and W3 must not quietly undo. A warm thread with
 * nobody waiting sits at the bottom on purpose: it is an OPPORTUNITY, not an
 * obligation, and inflating it would teach the owner to distrust the queue.
 *
 * CLOSED LEADS SCORE ZERO, always. A won deal with an old hot conversation must
 * never climb the list — the opportunity is over whatever the thread looks like.
 */
export function evaluateLeadPriority(input: {
  status: LeadStatusValue;
  attention: LeadAttention;
  intelligence: LeadConversationIntelligence | null;
}): LeadPriority {
  const { status, attention, intelligence } = input;

  if (isClosedLeadStatus(status)) {
    return { score: 0, reason: "NONE", label: "", contributing: [] };
  }

  const candidates: Array<{ score: number; reason: LeadPriorityReasonKind }> = [];

  if (attention.needsAttention && attention.reason) {
    candidates.push({ score: attention.priority, reason: attention.reason });
  }

  if (intelligence) {
    const waiting =
      intelligence.unansweredInboundCount > 0 &&
      intelligence.primarySignal === "customer_waiting";

    if (waiting) {
      const minutes = intelligence.waitingMinutes ?? 0;
      if (minutes >= LONG_WAIT_MINUTES) {
        // 72 → 78 as the wait stretches from 4h to 24h. Capped so it can never
        // reach the overdue band.
        const extra = Math.min(6, Math.floor((minutes - LONG_WAIT_MINUTES) / 200));
        candidates.push({ score: 72 + extra, reason: "CUSTOMER_WAITING_LONG" });
      } else {
        // 55 → 68 over the first four hours.
        const extra = Math.min(13, Math.floor(minutes / 18));
        candidates.push({ score: 55 + extra, reason: "CUSTOMER_WAITING" });
      }
    } else if (
      intelligence.temperatureBucket === "hot" &&
      HOT_SIGNALS.has(intelligence.primarySignal)
    ) {
      // Only a thread that is BOTH hot and reading as an opportunity counts —
      // a hot temperature alone is not a reason to interrupt anybody.
      candidates.push({ score: 45, reason: "HOT_THREAD" });
    }
  }

  if (candidates.length === 0) {
    return { score: 0, reason: "NONE", label: "", contributing: [] };
  }

  candidates.sort((a, b) => b.score - a.score);
  const winner = candidates[0];

  return {
    score: winner.score,
    reason: winner.reason,
    label: PRIORITY_LABELS[winner.reason],
    contributing: candidates.map((c) => c.reason),
  };
}

/**
 * Owner-facing one-liner for the list row: what the conversation is doing.
 *
 * Returns null when there is nothing worth a second line — an empty thread must
 * not produce decoration. Never renders an internal enum.
 */
export function leadIntelligenceHeadline(
  intelligence: LeadConversationIntelligence | null
): string | null {
  if (!intelligence) return null;

  const parts: string[] = [];

  if (intelligence.temperatureBucket === "hot") parts.push("🔥 חם");

  if (
    intelligence.unansweredInboundCount > 0 &&
    intelligence.waitingMinutes != null
  ) {
    parts.push(`ממתין ${formatWait(intelligence.waitingMinutes)}`);
  } else if (intelligence.signalLabel) {
    parts.push(intelligence.signalLabel);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Second line: the concrete evidence, when there is any worth stating. */
export function leadIntelligenceDetail(
  intelligence: LeadConversationIntelligence | null
): string | null {
  if (!intelligence) return null;

  if (intelligence.unansweredInboundCount > 1) {
    return `${intelligence.unansweredInboundCount} הודעות ללא מענה`;
  }
  if (intelligence.businessSituation?.label) {
    return intelligence.businessSituation.label;
  }
  return null;
}

function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} שע׳`;
  const days = Math.floor(hours / 24);
  return `${days} ימים`;
}
