"use client";

import Link from "next/link";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { CrmRowMeta } from "@/components/crm/CrmRowMeta";
import type { LeadListRow } from "@/lib/api/leads";
import {
  followUpTone,
  formatLastActivity,
  leadFollowUpText,
  leadIntelligenceDetailText,
  leadIntelligenceHeadlineText,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
  type BadgeTone,
} from "@/components/leads/lead-display";
import { useI18n } from "@/components/i18n/I18nProvider";

/**
 * One lead row: avatar initials + name + status/follow-up badges + a single meta
 * line (phone · source · last activity).
 *
 * Built for a 390px screen first — the row never becomes a table, and the badges
 * wrap rather than pushing the layout sideways. An overdue follow-up gets a red
 * left rail so "who is waiting on me" reads at a glance, before any text.
 *
 * Uses next/link so selecting a lead is a client navigation that keeps the
 * stable list mounted (never a full reload / refetch).
 */

function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

function Badge({ tone, children }: { tone: BadgeTone; children: string }) {
  return (
    <span
      className="crm-badge"
      style={{
        background: tone.bg,
        color: tone.color,
        border: `1px solid ${tone.border}`,
      }}
    >
      {children}
    </span>
  );
}

export function LeadRow({
  lead,
  selected = false,
}: {
  lead: LeadListRow;
  selected?: boolean;
}) {
  const { t } = useI18n();
  // Values, not a joined string: `CrmRowMeta` owns the separators so the line
  // can wrap on a narrow screen and each value keeps its own bidi isolation.
  const metaParts = [
    lead.phone
      ? formatPhoneForDisplay(lead.phone)
      : lead.claimedPhone
        ? t("customers.leads.common.claimedPhoneShort", { phone: formatPhoneForDisplay(lead.claimedPhone) })
        : null,
    leadSourceLabel(lead.sourceChannel, t),
    formatLastActivity(lead.lastActivityAt, t),
  ];

  // W3 — at most TWO lines of conversation reading, never more. The row has to
  // stay readable on a 390px screen held in one hand, so the intelligence gets a
  // headline ("🔥 חם · ממתין 18 דק׳") and at most one supporting line; anything
  // further belongs on the card.
  const headline = leadIntelligenceHeadlineText(lead.intelligence ?? null, t);
  const detail = leadIntelligenceDetailText(lead.intelligence ?? null, t);

  const statusTone = leadStatusTone(lead.status);
  const fuTone = followUpTone(lead.followUp);
  const fuLabel = leadFollowUpText(lead.followUp, t);

  return (
    <Link
      className={`crm-row${selected ? " crm-row--selected" : ""}`}
      href={`/leads/${lead.id}`}
      aria-current={selected ? "true" : undefined}
      style={
        lead.needsAttention || (lead.priority?.score ?? 0) >= 70
          ? { borderInlineStart: "3px solid var(--crm-error)" }
          : undefined
      }
    >
      <span className="crm-row__avatar" aria-hidden>
        {initials(lead.name)}
      </span>
      <span className="crm-row__body">
        <span className="crm-row__name">
          <bdi>{lead.name ?? t("customers.leads.common.unnamed")}</bdi>
        </span>
        <span
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            margin: "4px 0 2px",
          }}
        >
          <Badge tone={statusTone}>{leadStatusLabel(lead.status, t)}</Badge>
          {fuTone && fuLabel ? <Badge tone={fuTone}>{fuLabel}</Badge> : null}
        </span>
        <CrmRowMeta
          parts={[headline]}
          style={{ color: "var(--crm-ink)", fontWeight: 600 }}
        />
        <CrmRowMeta parts={[detail]} />
        <CrmRowMeta parts={metaParts} />
      </span>
      <span className="crm-row__chevron" aria-hidden>
        {t("customers.leads.common.chevron")}
      </span>
    </Link>
  );
}
