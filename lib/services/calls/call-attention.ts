/**
 * M7-A — the Secretary's view of business calls (docs/business-intake-m7-decision-v1.md §10).
 *
 * Read-time, tenant-scoped, nothing stored, nothing sent, nothing changed. Two answers:
 *
 *   lastUnreturnedCallByLead   per lead: the latest missed inbound call of the lead's customer that
 *                              nobody returned (feeds the CUSTOMER_CALLED reason of the ONE attention
 *                              contract, so the lead card, Home and the briefing agree)
 *   loadCallBriefing           the calls the owner may still owe a call back — known customers vs
 *                              UNKNOWN numbers (grouped by their per-business hash, so three calls from
 *                              one number are one item), and how many came with a hidden caller id
 *
 * Owner authority: the briefing never turns a call into a lead or a customer, never shows a number it
 * does not have (an unknown caller is a count and a time, not a person), and proposes nothing on its own.
 */

import { Prisma } from "@prisma/client";
import { UNRETURNED_OUTCOMES } from "@/lib/intake/calls/canonical";

type Tx = Prisma.TransactionClient;

/** How far back the call briefing looks. */
export const CALL_BRIEFING_DAYS = 7;
const TOP_UNKNOWN = 5;

export async function lastUnreturnedCallByLead(tx: Tx, businessId: number, leadIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  if (leadIds.length === 0) return out;
  const rows = await tx.$queryRaw<Array<{ id: number; at: Date | null }>>`
    SELECT l."id",
           (SELECT max(ca."startedAt") FROM "CallActivity" ca
             WHERE ca."businessId" = l."businessId"
               AND (ca."leadId" = l."id" OR (l."customerId" IS NOT NULL AND ca."customerId" = l."customerId"))
               AND ca."direction" = 'inbound' AND ca."outcome" IN (${Prisma.join([...UNRETURNED_OUTCOMES])})
               AND ca."returnedAt" IS NULL) AS "at"
      FROM "Lead" l
     WHERE l."businessId" = ${businessId} AND l."id" IN (${Prisma.join(leadIds)})`;
  for (const r of rows) if (r.at) out.set(r.id, r.at);
  return out;
}

export type CallBriefing = {
  /** Missed inbound calls not returned, in the window. */
  unreturned: { knownCustomers: number; unknownNumbers: number; hiddenCallerCalls: number };
  /** Repeat unknown callers (strongest first): a count and the latest time — never a number. */
  unknownCallers: Array<{ key: string; calls: number; lastAt: string }>;
  windowDays: number;
};

export function emptyCallBriefing(): CallBriefing {
  return { unreturned: { knownCustomers: 0, unknownNumbers: 0, hiddenCallerCalls: 0 }, unknownCallers: [], windowDays: CALL_BRIEFING_DAYS };
}

export async function loadCallBriefing(tx: Tx, businessId: number, now: Date): Promise<CallBriefing> {
  const since = new Date(now.getTime() - CALL_BRIEFING_DAYS * 86_400_000);
  const outcomes = [...UNRETURNED_OUTCOMES];
  const [agg] = await tx.$queryRaw<Array<{ known: number; unknown: number; hidden: number }>>`
    SELECT count(DISTINCT ca."customerId") FILTER (WHERE ca."customerId" IS NOT NULL)::int AS "known",
           count(DISTINCT ca."callerHash") FILTER (WHERE ca."callerHash" IS NOT NULL)::int AS "unknown",
           count(*) FILTER (WHERE ca."callerState" = 'hidden')::int AS "hidden"
      FROM "CallActivity" ca
     WHERE ca."businessId" = ${businessId} AND ca."startedAt" >= ${since}
       AND ca."direction" = 'inbound' AND ca."outcome" IN (${Prisma.join(outcomes)}) AND ca."returnedAt" IS NULL`;
  const groups = await tx.$queryRaw<Array<{ h: string; n: number; last: Date }>>`
    SELECT ca."callerHash" AS "h", count(*)::int AS "n", max(ca."startedAt") AS "last"
      FROM "CallActivity" ca
     WHERE ca."businessId" = ${businessId} AND ca."startedAt" >= ${since}
       AND ca."direction" = 'inbound' AND ca."callerHash" IS NOT NULL AND ca."customerId" IS NULL
     GROUP BY ca."callerHash"
     ORDER BY count(*) DESC, max(ca."startedAt") DESC
     LIMIT ${TOP_UNKNOWN}`;
  return {
    unreturned: { knownCustomers: agg?.known ?? 0, unknownNumbers: agg?.unknown ?? 0, hiddenCallerCalls: agg?.hidden ?? 0 },
    // An opaque per-briefing key (a hash prefix is enough to tell items apart; it names nobody).
    unknownCallers: groups.map((g) => ({ key: g.h.slice(7, 19), calls: g.n, lastAt: g.last.toISOString() })),
    windowDays: CALL_BRIEFING_DAYS,
  };
}
