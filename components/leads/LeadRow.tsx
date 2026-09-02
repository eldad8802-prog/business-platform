"use client";

import Link from "next/link";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { leadFollowUpLabel } from "@/lib/services/crm/lead-core";
import type { LeadListRow } from "@/lib/api/leads";
import {
  leadIntelligenceDetail,
  leadIntelligenceHeadline,
} from "@/lib/services/crm/lead-intelligence";
import {
  followUpTone,
  formatLastActivity,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
  type BadgeTone,
} from "@/components/leads/lead-display";

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
  const phone = lead.phone ? formatPhoneForDisplay(lead.phone) : null;
  const meta = [phone, leadSourceLabel(lead.sourceChannel), formatLastActivity(lead.lastActivityAt)]
    .filter((v): v is string => Boolean(v && v.trim()))
    .join(" · ");

  // W3 — at most TWO lines of conversation reading, never more. The row has to
  // stay readable on a 390px screen held in one hand, so the intelligence gets a
  // headline ("🔥 חם · ממתין 18 דק׳") and at most one supporting line; anything
  // further belongs on the card.
  const headline = leadIntelligenceHeadline(lead.intelligence ?? null);
  const detail = leadIntelligenceDetail(lead.intelligence ?? null);

  const statusTone = leadStatusTone(lead.status);
  const fuTone = followUpTone(lead.followUp);
  const fuLabel = leadFollowUpLabel(lead.followUp);

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
        <span className="crm-row__name">{lead.name ?? "ליד ללא שם"}</span>
        <span
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            margin: "4px 0 2px",
          }}
        >
          <Badge tone={statusTone}>{leadStatusLabel(lead.status)}</Badge>
          {fuTone && fuLabel ? <Badge tone={fuTone}>{fuLabel}</Badge> : null}
        </span>
        {headline ? (
          <span
            className="crm-row__meta"
            style={{ color: "var(--crm-ink)", fontWeight: 600 }}
          >
            {headline}
          </span>
        ) : null}
        {detail ? <span className="crm-row__meta">{detail}</span> : null}
        {meta ? <span className="crm-row__meta">{meta}</span> : null}
      </span>
      <span className="crm-row__chevron" aria-hidden>
        ‹
      </span>
    </Link>
  );
}
