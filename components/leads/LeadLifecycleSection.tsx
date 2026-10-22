"use client";

import { useState } from "react";
import {
  dismissLeadSuggestion,
  setLeadNextAction,
  setLeadValue,
  type LeadCardDTO,
  type LeadNextActionKindValue,
} from "@/lib/api/leads";
import {
  LEAD_NEXT_ACTION_KINDS,
  isLeadNextActionKind,
  type LeadLifecycleEventKind,
} from "@/lib/services/crm/lead-lifecycle-core";
import { formatDateTime, isClosed, leadStatusLabel } from "@/components/leads/lead-display";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

/** Next-action labels by kind (same wording as LEAD_NEXT_ACTION_LABELS, which stays Hebrew server-side). */
const NEXT_ACTION_LABEL_KEYS: Record<LeadNextActionKindValue, MessageKey> = {
  call: "customers.leads.lifecycle.nextActions.call",
  send_quote: "customers.leads.lifecycle.nextActions.sendQuote",
  check_quote: "customers.leads.lifecycle.nextActions.checkQuote",
  follow_up: "customers.leads.lifecycle.nextActions.followUp",
  schedule_meeting: "customers.leads.lifecycle.nextActions.scheduleMeeting",
  collect_info: "customers.leads.lifecycle.nextActions.collectInfo",
  wait_for_customer: "customers.leads.lifecycle.nextActions.waitForCustomer",
  other: "customers.leads.lifecycle.nextActions.other",
};

/** History labels by event kind (same wording as LEAD_LIFECYCLE_EVENT_LABELS, which stays Hebrew server-side). */
const EVENT_LABEL_KEYS: Record<LeadLifecycleEventKind, MessageKey> = {
  created: "customers.leads.lifecycle.events.created",
  intake_attached: "customers.leads.lifecycle.events.intakeAttached",
  status_changed: "customers.leads.lifecycle.events.statusChanged",
  next_action_set: "customers.leads.lifecycle.events.nextActionSet",
  next_action_rescheduled: "customers.leads.lifecycle.events.nextActionRescheduled",
  next_action_completed: "customers.leads.lifecycle.events.nextActionCompleted",
  next_action_cleared: "customers.leads.lifecycle.events.nextActionCleared",
  value_updated: "customers.leads.lifecycle.events.valueUpdated",
  suggestion_dismissed: "customers.leads.lifecycle.events.suggestionDismissed",
  contact_attached: "customers.leads.lifecycle.events.contactAttached",
  contact_detached: "customers.leads.lifecycle.events.contactDetached",
  conversation_linked: "customers.leads.lifecycle.events.conversationLinked",
};

/**
 * M5 — the lead's lifecycle, for an owner with two minutes.
 *
 * Progressive disclosure: one line on why the lead wants you (and whether that
 * is a FACT or Dubiz's INFERENCE), one Dubiz suggestion you can accept or wave
 * off, WHAT the next action is, and — folded away — the amounts and the full
 * history. Nothing here acts on its own: every change is the owner's tap, and
 * every write carries the version the owner saw, so a stale screen is refused
 * instead of overwriting a newer decision.
 */
export function LeadLifecycleSection({
  card,
  busy,
  onMutate,
}: {
  card: LeadCardDTO;
  busy: boolean;
  onMutate: (fn: () => Promise<LeadCardDTO>, fallback: string) => void;
}) {
  const { t, locale } = useI18n();
  const { lead, lifecycle } = card;
  const closed = isClosed(lead.status);
  const version = lead.lifecycleVersion;
  const { attention, suggestion, history } = lifecycle;

  const [estimate, setEstimate] = useState<string>(lead.valueEstimate ?? "");
  const [agreed, setAgreed] = useState<string>(lead.finalPrice ?? "");

  const amountOrNull = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">{t("customers.leads.lifecycle.title")}</h2>
      </div>

      {attention.reason ? (
        <p className="crm-note__body" style={{ margin: "0 0 10px" }}>
          <span
            className="crm-badge"
            style={{ marginInlineEnd: 8 }}
            title={
              attention.evidenceClass === "fact"
                ? t("customers.leads.lifecycle.factTitle")
                : t("customers.leads.lifecycle.inferenceTitle")
            }
          >
            {attention.evidenceClass === "fact" ? t("customers.leads.common.fact") : t("customers.leads.common.inference")}
          </span>
          <strong>{attention.label}</strong>
          {attention.summary ? ` — ${attention.summary}` : null}
        </p>
      ) : null}

      {!closed && suggestion ? (
        <div className="crm-panel" style={{ marginBottom: 12 }}>
          <p className="crm-panel__title" style={{ marginBottom: 4 }}>
            {t("customers.leads.common.dubizSuggests", { label: suggestion.label })}
          </p>
          <p className="crm-panel__body" style={{ marginTop: 0 }}>
            {suggestion.why} {t("customers.leads.lifecycle.suggestionNote")}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="crm-btn crm-btn--primary"
              disabled={busy}
              onClick={() =>
                onMutate(
                  () =>
                    setLeadNextAction(lead.id, {
                      followUpAt: suggestion.dueAt,
                      nextActionKind: suggestion.kind,
                      fromSuggestionRuleId: suggestion.ruleId,
                      expectedVersion: version,
                    }),
                  t("customers.leads.lifecycle.setActionError")
                )
              }
            >
              {t("customers.leads.lifecycle.setAction", { label: t(NEXT_ACTION_LABEL_KEYS[suggestion.kind]) })}
            </button>
            <button
              type="button"
              className="crm-btn crm-btn--ghost"
              disabled={busy}
              onClick={() =>
                onMutate(
                  () => dismissLeadSuggestion(lead.id, suggestion.ruleId, version),
                  t("customers.leads.lifecycle.updateError")
                )
              }
            >
              {t("customers.leads.lifecycle.dismiss")}
            </button>
          </div>
        </div>
      ) : null}

      {!closed && lead.nextFollowUpAt ? (
        <label className="crm-id__field" style={{ display: "block", marginBottom: 12 }}>
          <span className="crm-id__label">{t("customers.leads.lifecycle.nextActionLabel")}</span>
          <select
            className="crm-input"
            value={lead.nextActionKind ?? ""}
            disabled={busy}
            onChange={(e) => {
              const kind = (e.target.value || null) as LeadNextActionKindValue | null;
              onMutate(
                () =>
                  setLeadNextAction(lead.id, {
                    followUpAt: lead.nextFollowUpAt as string,
                    nextActionKind: kind,
                    followUpNote: lead.followUpNote,
                    expectedVersion: version,
                  }),
                t("customers.leads.lifecycle.nextActionError")
              );
            }}
          >
            <option value="">{t("customers.leads.lifecycle.notSpecified")}</option>
            {LEAD_NEXT_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(NEXT_ACTION_LABEL_KEYS[k])}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <details style={{ marginBottom: 8 }}>
        <summary className="crm-id__label" style={{ cursor: "pointer" }}>
          {t("customers.leads.lifecycle.amounts")}
        </summary>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <label className="crm-id__field">
            <span className="crm-id__label">{t("customers.leads.lifecycle.estimateLabel")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="crm-input"
                inputMode="decimal"
                value={estimate}
                onChange={(e) => setEstimate(e.target.value)}
                disabled={busy}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="crm-btn crm-btn--ghost"
                disabled={busy}
                onClick={() =>
                  onMutate(
                    () => setLeadValue(lead.id, "estimate", amountOrNull(estimate), version),
                    t("customers.leads.lifecycle.saveAmountError")
                  )
                }
              >
                {t("customers.leads.common.save")}
              </button>
            </div>
          </label>
          {lead.status === "WON" ? (
            <label className="crm-id__field">
              <span className="crm-id__label">{t("customers.leads.lifecycle.agreedLabel")}</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="crm-input"
                  inputMode="decimal"
                  value={agreed}
                  onChange={(e) => setAgreed(e.target.value)}
                  disabled={busy}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="crm-btn crm-btn--ghost"
                  disabled={busy}
                  onClick={() =>
                    onMutate(
                      () => setLeadValue(lead.id, "agreed", amountOrNull(agreed), version),
                      t("customers.leads.lifecycle.saveAmountError")
                    )
                  }
                >
                  {t("customers.leads.common.save")}
                </button>
              </div>
            </label>
          ) : null}
        </div>
      </details>

      <details>
        <summary className="crm-id__label" style={{ cursor: "pointer" }}>
          {t("customers.leads.lifecycle.history", { count: history.length })}
        </summary>
        {history.length === 0 ? (
          <p className="crm-note-empty">{t("customers.leads.lifecycle.historyEmpty")}</p>
        ) : (
          <ol className="crm-list" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {history.map((h) => (
              <li className="crm-item" key={h.seq}>
                <div className="crm-item__main">
                  <div className="crm-item__title">
                    {EVENT_LABEL_KEYS[h.kind] ? t(EVENT_LABEL_KEYS[h.kind]) : h.label}
                    {h.kind === "status_changed" && h.fromStatus && h.toStatus
                      ? t("customers.leads.lifecycle.statusChange", {
                          from: leadStatusLabel(h.fromStatus as LeadStatusValue, t),
                          to: leadStatusLabel(h.toStatus as LeadStatusValue, t),
                        })
                      : null}
                    {h.nextActionLabel
                      ? ` · ${isLeadNextActionKind(h.nextActionKind) ? t(NEXT_ACTION_LABEL_KEYS[h.nextActionKind]) : h.nextActionLabel}`
                      : null}
                    {h.amount ? ` · ${h.amount}` : null}
                  </div>
                  <div className="crm-item__meta">
                    {formatDateTime(h.occurredAt, locale) ?? ""}
                    {h.source === "BACKFILL" ? t("customers.leads.lifecycle.backfill") : null}
                    {h.evidenceKind === "suggestion" ? t("customers.leads.lifecycle.bySuggestion") : null}
                    {h.evidenceKind === "intake_event" ? t("customers.leads.lifecycle.fromIntake") : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}
