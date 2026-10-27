/**
 * Leads L1 · G-05 — the ONE "needs attention" queue.
 *
 * `evaluateLeadAttention` is the contract. Every surface that answers "which leads want the owner"
 * — the Home "מה מחכה" items and לידים badge (/api/business-status), /leads?needsAction=true, the
 * ranking of the Leads list, the Home count — reads THIS queue, so they can no longer disagree.
 *
 *   1. candidates  one tenant-scoped SQL predicate that is a SUPERSET of the evaluator (day cutoffs
 *                  one day lenient, so Israel-local day arithmetic can only over-include, never hide);
 *                  it also reads the facts the evaluator needs (customer wrote, missed call nobody
 *                  returned, open identity proposal) in the same statement — no N+1;
 *   2. evaluate    the evaluator decides; a candidate it rejects is dropped;
 *   3. order       priority DESC → the clock that made it urgent ASC → id ASC, BEFORE any caller caps
 *                  the list — a customer who called can never be cut by eight routine follow-ups.
 *
 * Bounded: above LEAD_ATTENTION_CANDIDATE_CAP candidates the answer is a best-effort slice of the MOST URGENT
 * (SQL urgency tiers) and the caller is TOLD so (`overflow`), never handed a silent approximation.
 * Runs on the caller's tenant transaction (RLS) and filters by businessId on every table.
 */

import { Prisma } from "@prisma/client";
import type { Translator } from "@/lib/i18n/translate";
import { evaluateLeadAttention, type LeadAttention } from "./lead-attention";
import { OPEN_LEAD_STATUSES, endOfLeadDayUtc, startOfLeadDayUtc, type LeadStatusValue } from "./lead-core";
import { QUOTE_CHECK_AFTER_DAYS, STALLED_AFTER_DAYS } from "./lead-lifecycle-core";

export const LEAD_ATTENTION_CANDIDATE_CAP = 500;

export type LeadAttentionRaw = {
  id: number;
  customerName: string | null;
  status: string;
  nextFollowUpAt: Date | null;
  followUpNote: string | null;
  createdAt: Date;
  /** M5 — lifecycle facts the attention contract reads. */
  lastActivityAt: Date | null;
  lastCustomerInboundAt: Date | null;
  /** M7-A — the latest missed inbound call of the lead's customer nobody returned. */
  lastUnreturnedCallAt?: Date | null;
  openIdentityProposals: number;
  /** G-03 — the owner's first lifecycle action (a handled NEW lead is not "new and untouched"). */
  firstHandledAt?: Date | null;
};

export type LeadAttentionQueueItem = { row: LeadAttentionRaw; attention: LeadAttention };

export type LeadAttentionQueue = {
  /** Only leads the evaluator says need the owner, most urgent first. */
  items: LeadAttentionQueueItem[];
  /** More candidates existed than were read: the queue is a best-effort slice. */
  overflow: boolean;
};

type Db = { $queryRaw: Prisma.TransactionClient["$queryRaw"] };

/** The evaluator's input for one row (shared, so no surface can pass fewer facts than another). */
export function leadAttentionInput(r: LeadAttentionRaw) {
  return {
    status: r.status as LeadStatusValue,
    nextFollowUpAt: r.nextFollowUpAt,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    lastCustomerInboundAt: r.lastCustomerInboundAt,
    lastUnreturnedCallAt: r.lastUnreturnedCallAt ?? null,
    openIdentityProposals: r.openIdentityProposals,
    firstHandledAt: r.firstHandledAt ?? null,
  };
}

/** Step 1 — every open lead that COULD need attention, with the facts to decide it. */
export async function loadLeadAttentionCandidates(
  db: Db,
  businessId: number,
  now: Date,
  limit: number = LEAD_ATTENTION_CANDIDATE_CAP + 1
): Promise<LeadAttentionRaw[]> {
  const dayMs = 86_400_000;
  const quoteCutoff = startOfLeadDayUtc(new Date(now.getTime() - (QUOTE_CHECK_AFTER_DAYS - 1) * dayMs));
  const stallCutoff = startOfLeadDayUtc(new Date(now.getTime() - (STALLED_AFTER_DAYS - 1) * dayMs));
  const open = [...OPEN_LEAD_STATUSES];
  // The LIMIT keeps the most URGENT candidates (G-05 · above the cap): a coarse SQL tier that mirrors the
  // evaluator's priority bands orders the cut, so a business with hundreds of untouched NEW leads can never
  // push a caller, a customer who wrote or an overdue promise out of the queue. The evaluator still decides
  // and orders exactly; the tier only chooses WHICH rows are read when there are too many.
  // ONE pass per related table per query (G-05 performance): the conversation / call / proposal facts are
  // aggregated once for this business and joined, instead of a correlated subquery per lead — "Conversation"
  // has no (businessId, leadId) index (a migration for later, owner-approved), so per-row lookups would scan it
  // once per candidate. Same semantics as the evaluator's inputs; still one statement, no N+1.
  return db.$queryRaw<LeadAttentionRaw[]>`
    WITH conv AS (
      SELECT c."leadId", max(c."customerLastInboundAt") AS "at"
        FROM "Conversation" c
       WHERE c."businessId" = ${businessId} AND c."leadId" IS NOT NULL AND c."customerLastInboundAt" IS NOT NULL
       GROUP BY c."leadId"
    ), calls AS (
      -- M7-A — missed inbound calls nobody returned (few by nature; the evaluator decides what they mean).
      SELECT ca."leadId", ca."customerId", ca."startedAt"
        FROM "CallActivity" ca
       WHERE ca."businessId" = ${businessId} AND ca."direction" = 'inbound'
         AND ca."outcome" IN ('missed', 'voicemail', 'busy', 'rejected') AND ca."returnedAt" IS NULL
    ), props AS (
      SELECT p."leadId", count(*)::int AS "n"
        FROM "IdentityProposal" p
       WHERE p."businessId" = ${businessId} AND p."state" = 'proposed' AND p."leadId" IS NOT NULL
       GROUP BY p."leadId"
    ), base AS (
      SELECT l."id", l."customerName", l."status"::text AS "status", l."nextFollowUpAt", l."followUpNote",
             l."createdAt", l."lastActivityAt", l."firstHandledAt",
             conv."at" AS "lastCustomerInboundAt",
             (SELECT max(k."startedAt") FROM calls k
               WHERE k."leadId" = l."id" OR (l."customerId" IS NOT NULL AND k."customerId" = l."customerId")) AS "lastUnreturnedCallAt",
             COALESCE(props."n", 0) AS "openIdentityProposals"
        FROM "Lead" l
        LEFT JOIN conv ON conv."leadId" = l."id"
        LEFT JOIN props ON props."leadId" = l."id"
       WHERE l."businessId" = ${businessId}
         AND l."status"::text IN (${Prisma.join(open)})
    )
    SELECT q."id", q."customerName", q."status", q."nextFollowUpAt", q."followUpNote", q."createdAt",
           q."lastActivityAt", q."lastCustomerInboundAt", q."lastUnreturnedCallAt", q."openIdentityProposals", q."firstHandledAt"
    FROM base q
    WHERE q."nextFollowUpAt" <= ${endOfLeadDayUtc(now)}
       OR (q."status" = 'NEW' AND q."nextFollowUpAt" IS NULL AND q."firstHandledAt" IS NULL)
       OR (q."nextFollowUpAt" IS NULL AND q."status" = 'QUOTED' AND COALESCE(q."lastActivityAt", q."createdAt") < ${quoteCutoff})
       OR (q."nextFollowUpAt" IS NULL AND (q."status" IN ('OPEN', 'QUALIFIED') OR (q."status" = 'NEW' AND q."firstHandledAt" IS NOT NULL)) AND COALESCE(q."lastActivityAt", q."createdAt") < ${stallCutoff})
       OR q."openIdentityProposals" > 0
       OR q."lastCustomerInboundAt" > COALESCE(q."lastActivityAt", q."createdAt")
       OR q."lastUnreturnedCallAt" IS NOT NULL
    ORDER BY
      CASE
        WHEN q."nextFollowUpAt" < ${startOfLeadDayUtc(now)} THEN 1                                      -- overdue (80–95)
        WHEN q."lastUnreturnedCallAt" > COALESCE(q."lastActivityAt", q."createdAt") THEN 2              -- called (78)
        WHEN q."lastCustomerInboundAt" > COALESCE(q."lastActivityAt", q."createdAt") THEN 3             -- wrote (75)
        WHEN q."nextFollowUpAt" IS NOT NULL THEN 4                                                       -- due today (70)
        WHEN q."openIdentityProposals" > 0 THEN 5                                                        -- identity (66)
        WHEN q."status" = 'NEW' AND q."firstHandledAt" IS NULL THEN 6                                                                   -- new (45–65)
        ELSE 7                                                                                           -- quote / stalled
      END ASC,
      q."nextFollowUpAt" ASC NULLS LAST, q."createdAt" ASC, q."id" ASC
    LIMIT ${limit}`;
}

/** Steps 2–3 — pure: evaluate, keep what needs the owner, order by urgency. */
export function rankLeadAttention(rows: readonly LeadAttentionRaw[], now: Date, t?: Translator): LeadAttentionQueueItem[] {
  const items: LeadAttentionQueueItem[] = [];
  for (const row of rows) {
    const attention = evaluateLeadAttention(leadAttentionInput(row), now, t);
    if (attention.needsAttention && attention.reason !== null) items.push({ row, attention });
  }
  const clock = (r: LeadAttentionRaw) => (r.nextFollowUpAt ?? r.createdAt).getTime();
  return items.sort((a, b) => b.attention.priority - a.attention.priority || clock(a.row) - clock(b.row) || a.row.id - b.row.id);
}

export async function loadLeadAttentionQueue(db: Db, businessId: number, now: Date, t?: Translator): Promise<LeadAttentionQueue> {
  const rows = await loadLeadAttentionCandidates(db, businessId, now);
  const overflow = rows.length > LEAD_ATTENTION_CANDIDATE_CAP;
  return { items: rankLeadAttention(overflow ? rows.slice(0, LEAD_ATTENTION_CANDIDATE_CAP) : rows, now, t), overflow };
}
