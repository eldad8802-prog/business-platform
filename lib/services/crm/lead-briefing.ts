/**
 * Business Intake M5 — the Secretary's lead briefing.
 *
 * "Today: 2 new leads need handling · 3 follow-ups due · 1 waiting on your
 * decision". Derived at READ time from the same contract every lead surface
 * uses (`evaluateLeadAttention`), so the Secretary, Home and Attention can never
 * disagree about a lead. Nothing here is stored, nothing is sent, nothing is
 * changed: the briefing informs and proposes; the owner decides.
 *
 * Every item states its evidence class — FACT (recorded data) or INFERENCE (a
 * deterministic rule) — and a Dubiz suggestion is always shown as a proposal.
 * Works with zero LLM availability: there is no model anywhere in this path.
 */

import { Prisma } from "@prisma/client";
import {
  evaluateLeadAttention,
  leadAttentionReasonLabel,
  leadAttentionSummary,
  type LeadAttentionReason,
  type LeadEvidenceClass,
} from "@/lib/services/crm/lead-attention";
import { OPEN_LEAD_STATUSES, type LeadStatusValue } from "@/lib/services/crm/lead-core";
import type { LeadSuggestion } from "@/lib/services/crm/lead-lifecycle-core";
import { dismissedSuggestionRules } from "@/lib/services/crm/lead-lifecycle.service";

type Tx = Prisma.TransactionClient;

/** Upper bound on open leads read for one briefing (counts beyond it are not claimed). */
export const LEAD_BRIEFING_SCAN_CAP = 500;
const TOP_ITEMS = 5;

export type LeadBriefingFacts = {
  id: number;
  customerName: string | null;
  status: string;
  nextFollowUpAt: Date | null;
  followUpNote: string | null;
  createdAt: Date;
  lastActivityAt: Date | null;
  lastCustomerInboundAt: Date | null;
  openIdentityProposals: number;
  dismissedRuleIds?: readonly string[];
};

export type LeadBriefingItem = {
  leadId: number;
  name: string;
  reason: LeadAttentionReason;
  label: string;
  summary: string;
  evidenceClass: LeadEvidenceClass;
  priority: number;
  suggestion: Pick<LeadSuggestion, "ruleId" | "kind" | "label" | "why"> | null;
  href: string;
};

export type LeadBriefingCounts = Record<LeadAttentionReason, number> & {
  open: number;
  needsAttention: number;
  withSuggestion: number;
};

export type LeadBriefing = {
  state: "CALM" | "BUSY" | "CRITICAL";
  counts: LeadBriefingCounts;
  items: LeadBriefingItem[];
  /** false when more open leads exist than were scanned — counts are then a floor. */
  complete: boolean;
  generatedAt: string;
};

function emptyCounts(): LeadBriefingCounts {
  return {
    open: 0,
    needsAttention: 0,
    withSuggestion: 0,
    FOLLOWUP_OVERDUE: 0,
    CUSTOMER_WROTE: 0,
    FOLLOWUP_DUE_TODAY: 0,
    AWAITING_OWNER_DECISION: 0,
    NEW_UNHANDLED: 0,
    QUOTE_NO_ACTIVITY: 0,
    STALLED: 0,
  };
}

/** Pure: facts in, briefing out. */
export function deriveLeadBriefing(
  rows: readonly LeadBriefingFacts[],
  now: Date,
  complete = true
): LeadBriefing {
  const counts = emptyCounts();
  const items: LeadBriefingItem[] = [];

  for (const r of rows) {
    const status = r.status as LeadStatusValue;
    if (!(OPEN_LEAD_STATUSES as readonly string[]).includes(status)) continue;
    counts.open += 1;
    const attention = evaluateLeadAttention(
      {
        status,
        nextFollowUpAt: r.nextFollowUpAt,
        createdAt: r.createdAt,
        lastActivityAt: r.lastActivityAt,
        lastCustomerInboundAt: r.lastCustomerInboundAt,
        openIdentityProposals: r.openIdentityProposals,
        dismissedRuleIds: r.dismissedRuleIds ?? [],
      },
      now
    );
    if (attention.suggestion) counts.withSuggestion += 1;
    if (!attention.needsAttention || !attention.reason) continue;
    counts.needsAttention += 1;
    counts[attention.reason] += 1;
    const name = r.customerName?.trim() || "ליד ללא שם";
    items.push({
      leadId: r.id,
      name,
      reason: attention.reason,
      label: leadAttentionReasonLabel(attention.reason),
      summary: [leadAttentionSummary(attention, r.nextFollowUpAt, now), r.followUpNote?.trim()]
        .filter((v): v is string => Boolean(v))
        .join(" "),
      evidenceClass: attention.evidenceClass ?? "fact",
      priority: attention.priority,
      suggestion: attention.suggestion
        ? {
            ruleId: attention.suggestion.ruleId,
            kind: attention.suggestion.kind,
            label: attention.suggestion.label,
            why: attention.suggestion.why,
          }
        : null,
      href: `/leads/${r.id}`,
    });
  }

  items.sort((a, b) => b.priority - a.priority || a.leadId - b.leadId);
  const state: LeadBriefing["state"] =
    counts.FOLLOWUP_OVERDUE > 0 || counts.CUSTOMER_WROTE > 0
      ? "CRITICAL"
      : counts.needsAttention > 0
        ? "BUSY"
        : "CALM";

  return { state, counts, items: items.slice(0, TOP_ITEMS), complete, generatedAt: now.toISOString() };
}

/** Tenant-scoped read of every open lead's lifecycle facts (bounded). */
export async function loadLeadBriefingFacts(
  tx: Tx,
  businessId: number
): Promise<{ rows: LeadBriefingFacts[]; complete: boolean }> {
  const open = [...OPEN_LEAD_STATUSES];
  const rows = await tx.$queryRaw<LeadBriefingFacts[]>`
    SELECT l."id", l."customerName", l."status"::text AS "status", l."nextFollowUpAt", l."followUpNote",
           l."createdAt", l."lastActivityAt",
           (SELECT max(c."customerLastInboundAt") FROM "Conversation" c
             WHERE c."businessId" = l."businessId" AND c."leadId" = l."id") AS "lastCustomerInboundAt",
           (SELECT count(*)::int FROM "IdentityProposal" p
             WHERE p."businessId" = l."businessId" AND p."leadId" = l."id" AND p."state" = 'proposed') AS "openIdentityProposals"
    FROM "Lead" l
    WHERE l."businessId" = ${businessId} AND l."status"::text IN (${Prisma.join(open)})
    ORDER BY l."nextFollowUpAt" ASC NULLS LAST, l."createdAt" DESC
    LIMIT ${LEAD_BRIEFING_SCAN_CAP + 1}`;
  const complete = rows.length <= LEAD_BRIEFING_SCAN_CAP;
  const scanned = rows.slice(0, LEAD_BRIEFING_SCAN_CAP);
  const dismissed = await dismissedSuggestionRules(tx, businessId, scanned.map((r) => r.id));
  return {
    rows: scanned.map((r) => ({ ...r, dismissedRuleIds: dismissed.get(r.id) ?? [] })),
    complete,
  };
}

export async function getLeadBriefing(tx: Tx, businessId: number, now = new Date()): Promise<LeadBriefing> {
  const { rows, complete } = await loadLeadBriefingFacts(tx, businessId);
  return deriveLeadBriefing(rows, now, complete);
}
