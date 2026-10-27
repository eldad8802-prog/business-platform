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
 * Bounded: above LEAD_ATTENTION_CANDIDATE_CAP candidates the answer is a best-effort slice of the
 * oldest-due and the caller is TOLD so (`overflow`), never handed a silent approximation.
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
  return db.$queryRaw<LeadAttentionRaw[]>`
    SELECT l."id", l."customerName", l."status"::text AS "status", l."nextFollowUpAt", l."followUpNote",
           l."createdAt", l."lastActivityAt",
           (SELECT max(c."customerLastInboundAt") FROM "Conversation" c
             WHERE c."businessId" = l."businessId" AND c."leadId" = l."id") AS "lastCustomerInboundAt",
           (SELECT max(ca."startedAt") FROM "CallActivity" ca
             WHERE ca."businessId" = l."businessId"
               AND (ca."leadId" = l."id" OR (l."customerId" IS NOT NULL AND ca."customerId" = l."customerId"))
               AND ca."direction" = 'inbound' AND ca."outcome" IN ('missed', 'voicemail', 'busy', 'rejected')
               AND ca."returnedAt" IS NULL) AS "lastUnreturnedCallAt",
           (SELECT count(*)::int FROM "IdentityProposal" p
             WHERE p."businessId" = l."businessId" AND p."leadId" = l."id" AND p."state" = 'proposed') AS "openIdentityProposals"
    FROM "Lead" l
    WHERE l."businessId" = ${businessId}
      AND l."status"::text IN (${Prisma.join(open)})
      AND (
        l."nextFollowUpAt" <= ${endOfLeadDayUtc(now)}
        OR (l."status" = 'NEW' AND l."nextFollowUpAt" IS NULL AND l."createdAt" < ${startOfLeadDayUtc(now)})
        OR (l."nextFollowUpAt" IS NULL AND l."status" = 'QUOTED'
            AND COALESCE(l."lastActivityAt", l."createdAt") < ${quoteCutoff})
        OR (l."nextFollowUpAt" IS NULL AND l."status" IN ('OPEN', 'QUALIFIED')
            AND COALESCE(l."lastActivityAt", l."createdAt") < ${stallCutoff})
        OR EXISTS (SELECT 1 FROM "IdentityProposal" p
                    WHERE p."businessId" = l."businessId" AND p."leadId" = l."id" AND p."state" = 'proposed')
        OR EXISTS (SELECT 1 FROM "Conversation" c
                    WHERE c."businessId" = l."businessId" AND c."leadId" = l."id"
                      AND c."customerLastInboundAt" > COALESCE(l."lastActivityAt", l."createdAt"))
        -- M7-A — a missed call of this lead's customer nobody returned (the evaluator decides).
        OR EXISTS (SELECT 1 FROM "CallActivity" ca
                    WHERE ca."businessId" = l."businessId"
                      AND (ca."leadId" = l."id" OR (l."customerId" IS NOT NULL AND ca."customerId" = l."customerId"))
                      AND ca."direction" = 'inbound' AND ca."outcome" IN ('missed', 'voicemail', 'busy', 'rejected')
                      AND ca."returnedAt" IS NULL)
      )
    ORDER BY l."nextFollowUpAt" ASC NULLS LAST, l."createdAt" ASC, l."id" ASC
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
