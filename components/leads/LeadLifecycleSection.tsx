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
  LEAD_NEXT_ACTION_LABELS,
} from "@/lib/services/crm/lead-lifecycle-core";
import { formatDateTime, isClosed, leadStatusLabel } from "@/components/leads/lead-display";
import type { LeadStatusValue } from "@/lib/services/crm/lead-core";

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
        <h2 className="crm-section__title">מסלול הליד</h2>
      </div>

      {attention.reason ? (
        <p className="crm-note__body" style={{ margin: "0 0 10px" }}>
          <span
            className="crm-badge"
            style={{ marginInlineEnd: 8 }}
            title={
              attention.evidenceClass === "fact"
                ? "עובדה: נתון שנרשם במערכת"
                : "מסקנה: חישוב קבוע מתוך הנתונים שנרשמו"
            }
          >
            {attention.evidenceClass === "fact" ? "עובדה" : "מסקנה מהנתונים"}
          </span>
          <strong>{attention.label}</strong>
          {attention.summary ? ` — ${attention.summary}` : null}
        </p>
      ) : null}

      {!closed && suggestion ? (
        <div className="crm-panel" style={{ marginBottom: 12 }}>
          <p className="crm-panel__title" style={{ marginBottom: 4 }}>
            דוביז מציע: {suggestion.label}
          </p>
          <p className="crm-panel__body" style={{ marginTop: 0 }}>
            {suggestion.why} זו הצעה — שום דבר לא ישתנה בלי אישור שלכם.
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
                  "לא הצלחנו לקבוע את הפעולה הבאה"
                )
              }
            >
              קבעו: {LEAD_NEXT_ACTION_LABELS[suggestion.kind]}
            </button>
            <button
              type="button"
              className="crm-btn crm-btn--ghost"
              disabled={busy}
              onClick={() =>
                onMutate(
                  () => dismissLeadSuggestion(lead.id, suggestion.ruleId, version),
                  "לא הצלחנו לעדכן"
                )
              }
            >
              לא עכשיו
            </button>
          </div>
        </div>
      ) : null}

      {!closed && lead.nextFollowUpAt ? (
        <label className="crm-id__field" style={{ display: "block", marginBottom: 12 }}>
          <span className="crm-id__label">מה הפעולה הבאה</span>
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
                "לא הצלחנו לעדכן את הפעולה הבאה"
              );
            }}
          >
            <option value="">לא צוין</option>
            {LEAD_NEXT_ACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {LEAD_NEXT_ACTION_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <details style={{ marginBottom: 8 }}>
        <summary className="crm-id__label" style={{ cursor: "pointer" }}>
          סכומים
        </summary>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <label className="crm-id__field">
            <span className="crm-id__label">הערכת שווי העסקה (לא הצעת מחיר ולא הכנסה)</span>
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
                    "לא הצלחנו לשמור את הסכום"
                  )
                }
              >
                שמירה
              </button>
            </div>
          </label>
          {lead.status === "WON" ? (
            <label className="crm-id__field">
              <span className="crm-id__label">הסכום שסוכם (לא סכום שנגבה)</span>
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
                      "לא הצלחנו לשמור את הסכום"
                    )
                  }
                >
                  שמירה
                </button>
              </div>
            </label>
          ) : null}
        </div>
      </details>

      <details>
        <summary className="crm-id__label" style={{ cursor: "pointer" }}>
          היסטוריה ({history.length})
        </summary>
        {history.length === 0 ? (
          <p className="crm-note-empty">עוד לא נרשם כלום.</p>
        ) : (
          <ol className="crm-list" style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
            {history.map((h) => (
              <li className="crm-item" key={h.seq}>
                <div className="crm-item__main">
                  <div className="crm-item__title">
                    {h.label}
                    {h.kind === "status_changed" && h.fromStatus && h.toStatus
                      ? `: ${leadStatusLabel(h.fromStatus as LeadStatusValue)} ← ${leadStatusLabel(
                          h.toStatus as LeadStatusValue
                        )}`
                      : null}
                    {h.nextActionLabel ? ` · ${h.nextActionLabel}` : null}
                    {h.amount ? ` · ${h.amount}` : null}
                  </div>
                  <div className="crm-item__meta">
                    {formatDateTime(h.occurredAt) ?? ""}
                    {h.source === "BACKFILL" ? " · שוחזר מנתונים קודמים" : null}
                    {h.evidenceKind === "suggestion" ? " · לפי הצעת דוביז" : null}
                    {h.evidenceKind === "intake_event" ? " · מפנייה נכנסת" : null}
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
