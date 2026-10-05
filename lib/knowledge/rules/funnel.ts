/**
 * All-Feature Learning Coverage · W3 — the sales funnel: leads and conversations.
 *
 * Every rule here learns OWNER BEHAVIOUR or a LEDGER FACT, from the domain's own records:
 *
 *   Lead (createdAt, firstHandledAt, status, closedAt) and LeadLifecycleEvent — the M5 lead ledger
 *   Message (direction, providerMessageId, sendStatus, sentAt) — what was actually received and sent
 *
 * The LEAD_* and CONVERSATION_* sensors duplicate these ledgers (their learning role says so), so no
 * rule here reads LearningEvent.
 *
 * THE MESSAGE EVIDENCE BOUNDARY (docs/learning/SENSOR_COVERAGE.md):
 *   - An inbound message counts only with a `providerMessageId` — a real WhatsApp delivery (COVERED).
 *     An "inbound" posted through the app route is indistinguishable from a simulation
 *     (BLOCKED_PRODUCT_SEMANTICS), so it is not a customer writing.
 *   - `senderType` is client-asserted (PARTIAL), so it is NOT read. A reply is any OUTBOUND message
 *     that did not fail to send: no autonomous send path exists (the manifest's "Bot / template
 *     message sent" row), so every outbound message is the business answering through its own session.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *   - Lead value / deal size: `valueEstimate` is a guess the owner typed, not revenue. Revenue is
 *     learned from invoices (W2), and there is no lead → invoice link to join them by.
 *   - Customer sentiment, intent and "temperature": those are model outputs stored on Message and
 *     Conversation, not observations. Learning from them would be learning from a model's opinion.
 *   - Reply-suggestion adoption: shown / sent / edited are client-asserted and `sentMessageId` is never
 *     written (manifest GAP). Learning from it would be learning from what the browser claimed.
 */
import type { MeasureResult } from "../measure.contract";
import type { EvidenceSource, KnowledgeRule, RuleDescriptor } from "../rule.contract";
import { DAY_MS } from "../rule.contract";
import { latencyMeasure, shareMeasure, valueMeasure, type LatencyPoint, type SharePoint, type ValuePoint } from "../rule-kit";

export const FUNNEL_WINDOW_DAYS = 365;
/** A first inbound message younger than this has not yet had its chance to be answered. */
export const ANSWER_WINDOW_HOURS = 24;

/* ─────────────────────────────── observation types ─────────────────────────────── */

export type LeadObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly createdAt: Date;
  /** The first OWNER lifecycle action on the lead (M5 FIRST_HANDLING_KINDS); null if never handled. */
  readonly firstHandledAt: Date | null;
  readonly status: "NEW" | "OPEN" | "QUALIFIED" | "QUOTED" | "WON" | "LOST" | "DROPPED";
  readonly closedAt: Date | null;
};

/** A completed next action, and the day it had been due (LeadLifecycleEvent `next_action_completed`). */
export type FollowUpObservation = {
  readonly recordId: number;
  readonly businessId: number;
  readonly completedAt: Date;
  readonly dueAt: Date;
};

/**
 * One conversation's opening exchange: the customer's first real message and the first reply the business
 * sent after it (null if none yet). Built by the loader from Message rows.
 */
export type ConversationOpeningObservation = {
  readonly recordId: number; // conversation id
  readonly businessId: number;
  readonly firstInboundAt: Date;
  readonly firstReplyAt: Date | null;
};

/* ─────────────────────────────── descriptors ─────────────────────────────── */

const FRESH: RuleDescriptor["freshness"] = ["NEW_EVIDENCE", "WINDOW_ROLLED", "EVIDENCE_REVERSED", "RULE_VERSION_CHANGED"];
const desc = (d: Omit<RuleDescriptor, "versionLabel" | "freshness" | "windowDays" | "entityType">): RuleDescriptor =>
  ({ versionLabel: "v1", freshness: FRESH, windowDays: FUNNEL_WINDOW_DAYS, entityType: null, ...d });

export const LEAD01 = desc({ ruleId: "LEAD-01", domain: "leads", measureKey: "leads.first_handling_days", policyKey: "leads-first-handling-days",
  minSupport: 5, valueUnit: "days", question: "How long after a lead arrives does this owner usually first act on it?" });
export const LEAD02 = desc({ ruleId: "LEAD-02", domain: "leads", measureKey: "leads.win_share", policyKey: "leads-win-share",
  minSupport: 5, valueUnit: "ratio", question: "What share of this business's closed leads were won?" });
export const LEAD03 = desc({ ruleId: "LEAD-03", domain: "leads", measureKey: "leads.follow_up_punctuality", policyKey: "leads-follow-up-punctuality",
  minSupport: 5, valueUnit: "days", question: "How many days after (or before) its due day does this owner usually complete a lead's next action?" });
export const LEAD04 = desc({ ruleId: "LEAD-04", domain: "leads", measureKey: "leads.days_to_win", policyKey: "leads-days-to-win",
  minSupport: 3, valueUnit: "days", question: "How long does a won lead usually take from arrival to win?" });
export const CONV01 = desc({ ruleId: "CONV-01", domain: "conversations", measureKey: "conversations.first_reply_days", policyKey: "conversations-first-reply-days",
  minSupport: 5, valueUnit: "days", question: "How long after a customer's first message does this business usually reply?" });
export const CONV02 = desc({ ruleId: "CONV-02", domain: "conversations", measureKey: "conversations.unanswered_24h_share", policyKey: "conversations-unanswered-24h-share",
  minSupport: 5, valueUnit: "ratio", question: "What share of customers' opening messages got no reply from the business within 24 hours?" });

/* ─────────────────────────────── derivation (pure) ─────────────────────────────── */

const days = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY_MS;
const CLOSED = new Set(["WON", "LOST", "DROPPED"]);

export function deriveFirstHandling(rows: readonly LeadObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: ValuePoint[] = rows.filter((l) => l.firstHandledAt !== null && l.firstHandledAt.getTime() >= l.createdAt.getTime())
    .map((l) => ({ recordId: l.recordId, businessId: l.businessId, at: l.firstHandledAt as Date, value: days(l.createdAt, l.firstHandledAt as Date) }));
  return [valueMeasure({ measureKey: LEAD01.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "lead",
    minSupport: LEAD01.minSupport, windowDays: LEAD01.windowDays, trendMinDelta: 0.5 }, pts, now, businessId)];
}

export function deriveWinShare(rows: readonly LeadObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: SharePoint[] = rows.filter((l) => CLOSED.has(l.status) && l.closedAt !== null)
    .map((l) => ({ recordId: l.recordId, businessId: l.businessId, at: l.closedAt as Date, hit: l.status === "WON" }));
  return [shareMeasure({ measureKey: LEAD02.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "lead",
    minSupport: LEAD02.minSupport, windowDays: LEAD02.windowDays }, pts, now, businessId)];
}

export function deriveFollowUpPunctuality(rows: readonly FollowUpObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: LatencyPoint[] = rows.map((f) => ({ recordId: f.recordId, businessId: f.businessId, at: f.completedAt, expectedAt: f.dueAt }));
  return [latencyMeasure({ measureKey: LEAD03.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "lead-lifecycle-event",
    minSupport: LEAD03.minSupport, windowDays: LEAD03.windowDays, trendMinDelta: 1 }, pts, now, businessId)];
}

export function deriveDaysToWin(rows: readonly LeadObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: ValuePoint[] = rows.filter((l) => l.status === "WON" && l.closedAt !== null && l.closedAt.getTime() >= l.createdAt.getTime())
    .map((l) => ({ recordId: l.recordId, businessId: l.businessId, at: l.closedAt as Date, value: days(l.createdAt, l.closedAt as Date) }));
  return [valueMeasure({ measureKey: LEAD04.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "lead",
    minSupport: LEAD04.minSupport, windowDays: LEAD04.windowDays }, pts, now, businessId)];
}

export function deriveFirstReply(rows: readonly ConversationOpeningObservation[], now: Date, businessId: number): MeasureResult[] {
  const pts: ValuePoint[] = rows.filter((c) => c.firstReplyAt !== null)
    .map((c) => ({ recordId: c.recordId, businessId: c.businessId, at: c.firstReplyAt as Date, value: days(c.firstInboundAt, c.firstReplyAt as Date) }));
  return [valueMeasure({ measureKey: CONV01.measureKey, entityType: null, entityId: null, valueUnit: "days", evidenceKind: "conversation",
    minSupport: CONV01.minSupport, windowDays: CONV01.windowDays, trendMinDelta: 0.25 }, pts, now, businessId)];
}

export function deriveUnanswered24h(rows: readonly ConversationOpeningObservation[], now: Date, businessId: number): MeasureResult[] {
  const span = ANSWER_WINDOW_HOURS * 3_600_000;
  const pts: SharePoint[] = rows.filter((c) => now.getTime() - c.firstInboundAt.getTime() >= span)
    .map((c) => ({ recordId: c.recordId, businessId: c.businessId, at: c.firstInboundAt,
      hit: c.firstReplyAt === null || c.firstReplyAt.getTime() - c.firstInboundAt.getTime() > span }));
  return [shareMeasure({ measureKey: CONV02.measureKey, entityType: null, entityId: null, valueUnit: "ratio", evidenceKind: "conversation",
    minSupport: CONV02.minSupport, windowDays: CONV02.windowDays }, pts, now, businessId)];
}

/**
 * Pure: a conversation's opening exchange from its messages. The first REAL inbound (it carries a
 * provider message id), then the first outbound at or after it that did not fail to send. Messages
 * before the first real inbound (an owner-opened conversation) do not count as replies to anything.
 */
export type OpeningMessage = { at: Date; direction: "INBOUND" | "OUTBOUND"; fromProvider: boolean; sendFailed: boolean };
export function openingOf(messages: readonly OpeningMessage[]): { firstInboundAt: Date; firstReplyAt: Date | null } | null {
  const sorted = [...messages].sort((a, b) => a.at.getTime() - b.at.getTime());
  const inbound = sorted.find((m) => m.direction === "INBOUND" && m.fromProvider);
  if (!inbound) return null;
  const reply = sorted.find((m) => m.direction === "OUTBOUND" && !m.sendFailed && m.at.getTime() >= inbound.at.getTime());
  return { firstInboundAt: inbound.at, firstReplyAt: reply?.at ?? null };
}

/* ─────────────────────────────── rules ─────────────────────────────── */

export const makeLeadSource = (load: EvidenceSource<LeadObservation>["load"]): EvidenceSource<LeadObservation> =>
  ({ key: "leads.leads", windowDays: FUNNEL_WINDOW_DAYS, load });
export const makeFollowUpSource = (load: EvidenceSource<FollowUpObservation>["load"]): EvidenceSource<FollowUpObservation> =>
  ({ key: "leads.follow-ups", windowDays: FUNNEL_WINDOW_DAYS, load });
export const makeConversationOpeningSource = (load: EvidenceSource<ConversationOpeningObservation>["load"]): EvidenceSource<ConversationOpeningObservation> =>
  ({ key: "conversations.openings", windowDays: FUNNEL_WINDOW_DAYS, load });

type R<T> = KnowledgeRule<T>;
const rule = <T extends { readonly businessId: number }>(
  descriptor: RuleDescriptor, source: EvidenceSource<T>,
  derive: (rows: readonly T[], now: Date, businessId: number) => MeasureResult[],
): R<T> => ({ descriptor, source, derive: (rows, now) => derive(rows, now, rows[0]?.businessId ?? 0) });

export function funnelRules(
  leads: EvidenceSource<LeadObservation>,
  followUps: EvidenceSource<FollowUpObservation>,
  openings: EvidenceSource<ConversationOpeningObservation>,
): R<never>[] {
  return [
    rule(LEAD01, leads, deriveFirstHandling),
    rule(LEAD02, leads, deriveWinShare),
    rule(LEAD03, followUps, deriveFollowUpPunctuality),
    rule(LEAD04, leads, deriveDaysToWin),
    rule(CONV01, openings, deriveFirstReply),
    rule(CONV02, openings, deriveUnanswered24h),
  ] as unknown as R<never>[];
}
