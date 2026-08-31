import {
  evaluateLeadAttention,
  leadAttentionReasonLabel,
  leadAttentionSummary,
} from "@/lib/services/crm/lead-attention";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";
import type { LeadAttentionRaw } from "../loaders";
import type { BusinessStatusItemBuild, Severity } from "../types";

/**
 * Leads → Business Status (Attention).
 *
 * The domain contributes exactly the reasons W1 can evidence: a follow-up the
 * owner promised and has not kept, and a new lead nobody has touched. It does
 * NOT contribute "hot", "cooling", "waiting" or "stalled quote" — those derive
 * from Conversation columns that nothing currently writes (the state writer is
 * gated off in every environment), and a badge over no evidence is worse than
 * no badge.
 */

function leadLabel(name: string | null): string {
  const n = name?.trim();
  return n && n !== "" ? n : "ליד ללא שם";
}

const SEVERITY_BY_REASON: Record<string, Severity> = {
  FOLLOWUP_OVERDUE: "HIGH",
  FOLLOWUP_DUE_TODAY: "MEDIUM",
  NEW_UNHANDLED: "MEDIUM",
};

export function translateLeadsNeedingAttention(
  rows: LeadAttentionRaw[],
  now: Date
): BusinessStatusItemBuild[] {
  const builds: BusinessStatusItemBuild[] = [];

  for (const r of rows) {
    const attention = evaluateLeadAttention(
      {
        status: r.status as LeadStatusValue,
        nextFollowUpAt: r.nextFollowUpAt,
        createdAt: r.createdAt,
      },
      now
    );

    // The loader's SQL and this evaluator should already agree; if they ever
    // drift, trust the evaluator (it is the contract) and drop the row rather
    // than show an item that cannot explain itself.
    if (!attention.needsAttention || attention.reason === null) continue;

    const whom = leadLabel(r.customerName);
    const followUpNote = r.followUpNote?.trim();

    builds.push({
      itemId: `leads:${attention.reason.toLowerCase()}:${r.id}`,
      domain: "leads",
      semanticCategory: "ACTION_REQUIRED",
      title: `${whom} — ${leadAttentionReasonLabel(attention.reason)}`,
      summary:
        [leadAttentionSummary(attention, r.nextFollowUpAt, now), followUpNote]
          .filter((v): v is string => Boolean(v && v.trim()))
          .join(" ") || null,
      severity: SEVERITY_BY_REASON[attention.reason] ?? "MEDIUM",
      entityRef: { type: "lead", id: r.id },
      state: "open",
      createdAt: r.createdAt.toISOString(),
      primaryAction: {
        kind: "navigate",
        label: attention.nextAction.label || "פתח את הליד",
        href: `/leads/${r.id}`,
      },
      sourceEngine: "leads-attention",
      blocking: false,
      // The clock that made this urgent: the follow-up moment when there is
      // one, otherwise when the lead arrived. Feeds the shared priority score.
      priorityReferenceDate: r.nextFollowUpAt ?? r.createdAt,
      // Handled from the list itself — a follow-up the owner has already dealt
      // with should not require opening the lead just to say so.
      quickActions:
        attention.reason === "NEW_UNHANDLED"
          ? undefined
          : [
              { kind: "lead_followup_complete", label: "טופל", leadId: r.id },
              { kind: "lead_followup_snooze", label: "דחה ל־3 ימים", leadId: r.id, days: 3 },
            ],
    });
  }

  return builds;
}
