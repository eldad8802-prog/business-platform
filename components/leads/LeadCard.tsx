"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getLeadCard,
  updateLeadStatus,
  setLeadFollowUp,
  clearLeadFollowUp,
  type LeadCardDTO,
} from "@/lib/api/leads";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import {
  LEAD_STATUSES,
  leadFollowUpLabel,
  type LeadStatusValue,
} from "@/lib/services/crm/lead-core";
import { NotesThread } from "@/components/crm/NotesThread";
import { AttachmentList } from "@/components/crm/AttachmentList";
import {
  followUpTone,
  formatDate,
  formatDateTime,
  isClosed,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
} from "@/components/leads/lead-display";

/**
 * Lead workspace — the SAME representation shown full-page on mobile and inside
 * the desktop Master–Detail panel.
 *
 * CUSTOMER CONTINUITY: notes and files are rendered by the generic CRM engines
 * with `subjectType="LEAD"`, and the customer's identity and conversations are
 * shown by REFERENCE with a link across to the customer card. Nothing is copied
 * into lead-owned storage, so there is exactly one home for each fact.
 *
 * Every mutation returns the full card, so the screen re-renders from the
 * server's answer instead of guessing — a refresh always agrees with what was
 * just shown.
 */

type State =
  | { status: "loading" }
  | { status: "ready"; card: LeadCardDTO }
  | { status: "notFound" }
  | { status: "error"; message: string };

/** Follow-up presets, in days. Two taps to schedule; the picker is the fallback. */
const FOLLOWUP_PRESETS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 1, label: "מחר" },
  { days: 3, label: "בעוד 3 ימים" },
  { days: 7, label: "בשבוע הבא" },
];

/** 09:00 Israel time, `days` from now — a follow-up is a morning task. */
function presetIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** `<input type="datetime-local">` value → ISO instant. */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function LeadCard() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);

  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Returns the next state; never sets it — the effect updates state only after
  // the request resolves. Depends only on `id`, so a soft navigation fetches the
  // card exactly once. (Same discipline as CustomerCard.)
  const fetchCard = useCallback(async (): Promise<State> => {
    if (!Number.isInteger(id) || id <= 0) return { status: "notFound" };
    try {
      const card = await getLeadCard(id);
      return { status: "ready", card };
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return { status: "loading" };
      }
      const message = err instanceof Error ? err.message : "לא הצלחנו לטעון את הליד";
      return message.includes("not found") || message.includes("לא נמצא")
        ? { status: "notFound" }
        : { status: "error", message };
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void fetchCard().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCard]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void fetchCard().then(setState);
  }, [fetchCard]);

  /** Run a mutation, adopt the returned card, surface any failure inline. */
  const mutate = useCallback(
    async (fn: () => Promise<LeadCardDTO>, fallback: string) => {
      if (busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const card = await fn();
        setState({ status: "ready", card });
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        setActionError(err instanceof Error ? err.message : fallback);
      } finally {
        setBusy(false);
      }
    },
    [busy]
  );

  return (
    <div className="crm-page crm-reading">
      <Link className="crm-hd__back" href="/leads">
        › חזרה ללידים
      </Link>

      {state.status === "loading" ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : state.status === "notFound" ? (
        <div className="crm-panel">
          <p className="crm-panel__title">הליד לא נמצא</p>
          <p className="crm-panel__body">ייתכן שהליד נמחק או שאין לך גישה אליו.</p>
          <Link className="crm-btn crm-btn--ghost" href="/leads">
            חזרה ללידים
          </Link>
        </div>
      ) : state.status === "error" ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">משהו השתבש</p>
          <p className="crm-panel__body">{state.message}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            נסו שוב
          </button>
        </div>
      ) : (
        <LeadCardBody
          card={state.card}
          busy={busy}
          actionError={actionError}
          onStatus={(status, lostReason) =>
            void mutate(
              () => updateLeadStatus(id, status, lostReason),
              "לא הצלחנו לעדכן את הסטטוס"
            )
          }
          onFollowUp={(iso, note) =>
            void mutate(
              () => setLeadFollowUp(id, iso, note),
              "לא הצלחנו לקבוע מעקב"
            )
          }
          onFollowUpDone={() =>
            void mutate(() => clearLeadFollowUp(id), "לא הצלחנו לסגור את המעקב")
          }
        />
      )}
    </div>
  );
}

function LeadCardBody({
  card,
  busy,
  actionError,
  onStatus,
  onFollowUp,
  onFollowUpDone,
}: {
  card: LeadCardDTO;
  busy: boolean;
  actionError: string | null;
  onStatus: (status: LeadStatusValue, lostReason?: string | null) => void;
  onFollowUp: (iso: string, note: string | null) => void;
  onFollowUpDone: () => void;
}) {
  const { lead, customer, followUp, conversations, needsAttention, intelligence } = card;
  const closed = isClosed(lead.status);
  const tone = leadStatusTone(lead.status);

  const identityFields: Array<{ label: string; value: string }> = [];
  if (lead.phone) {
    identityFields.push({ label: "טלפון", value: formatPhoneForDisplay(lead.phone) });
  }
  if (lead.email) identityFields.push({ label: "אימייל", value: lead.email });
  const sourceLabel = leadSourceLabel(lead.sourceChannel);
  if (sourceLabel) identityFields.push({ label: "מקור", value: sourceLabel });
  const created = formatDate(lead.createdAt);
  if (created) identityFields.push({ label: "נכנס", value: created });
  if (closed && lead.closedAt) {
    const closedAt = formatDate(lead.closedAt);
    if (closedAt) identityFields.push({ label: "נסגר", value: closedAt });
  }
  if (lead.lostReason) {
    identityFields.push({ label: "סיבה", value: lead.lostReason });
  }

  return (
    <>
      <div className="crm-id">
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <h1 className="crm-id__name">{lead.name ?? "ליד ללא שם"}</h1>
          <span
            className="crm-badge"
            style={{
              background: tone.bg,
              color: tone.color,
              border: `1px solid ${tone.border}`,
              flexShrink: 0,
            }}
          >
            {leadStatusLabel(lead.status)}
          </span>
        </div>

        {identityFields.length > 0 ? (
          <div className="crm-id__grid">
            {identityFields.map((f) => (
              <div className="crm-id__field" key={f.label}>
                <div className="crm-id__label">{f.label}</div>
                <div className="crm-id__value">{f.value}</div>
              </div>
            ))}
          </div>
        ) : null}

        {customer ? (
          <div className="crm-chips">
            <Link
              className="crm-chip"
              href={`/customers/${customer.id}`}
              style={{ textDecoration: "none" }}
            >
              כרטיס הלקוח: {customer.name} ‹
            </Link>
          </div>
        ) : null}
      </div>

      {actionError ? (
        <div className="crm-panel crm-panel--error" style={{ marginBottom: 16 }}>
          <p className="crm-panel__body" style={{ margin: 0 }}>
            {actionError}
          </p>
        </div>
      ) : null}

      {/* Quick actions: pure deep links — no integration, no 24h window, no
          promise the platform cannot keep. */}
      {lead.phone ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <a
            className="crm-btn crm-btn--primary"
            href={`https://wa.me/${lead.phone.replace(/\D/g, "")}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            וואטסאפ
          </a>
          <a className="crm-btn crm-btn--ghost" href={`tel:+${lead.phone.replace(/\D/g, "")}`}>
            חיוג
          </a>
        </div>
      ) : null}

      {lead.intentSnapshot ? (
        <div className="crm-section">
          <div className="crm-section__head">
            <h2 className="crm-section__title">מה הוא צריך</h2>
          </div>
          {/* `overflowWrap: anywhere` so a pasted URL or an unbroken string
              cannot push the 390px layout sideways. */}
          <p
            className="crm-note__body"
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {lead.intentSnapshot}
          </p>
        </div>
      ) : null}

      <NowSection intelligence={intelligence} status={lead.status} />

      <FollowUpSection
        lead={lead}
        followUp={followUp}
        needsAttention={needsAttention}
        closed={closed}
        busy={busy}
        onFollowUp={onFollowUp}
        onFollowUpDone={onFollowUpDone}
      />

      <StatusSection status={lead.status} busy={busy} onStatus={onStatus} />

      <div className="crm-section">
        <div className="crm-section__head">
          <h2 className="crm-section__title">שיחות</h2>
          <span className="crm-section__count">{conversations.total}</span>
        </div>
        {conversations.items.length === 0 ? (
          <p className="crm-note-empty">אין עדיין שיחות מקושרות לליד הזה.</p>
        ) : (
          <div className="crm-list">
            {conversations.items.map((c) => (
              <div className="crm-item" key={c.id}>
                <div className="crm-item__main">
                  <div className="crm-item__title">{c.channel}</div>
                  <div className="crm-item__meta">
                    {formatDateTime(c.lastMessageAt ?? c.startedAt) ?? ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Generic CRM engines — leads inherit them by being a CRM subject. */}
      <NotesThread subjectType="LEAD" subjectId={lead.id} />
      <AttachmentList subjectType="LEAD" subjectId={lead.id} />
    </>
  );
}


/**
 * "מה קורה עכשיו" — what Dubiz observed in the conversation.
 *
 * OWNER AUTHORITY IS THE POINT OF THIS SECTION. Everything it renders is a
 * READING: the thread looks like a negotiation, the customer has been waiting
 * eighteen minutes, three messages went unanswered. None of it is the lead's
 * status, none of it changes the lead's status, and the section says so out
 * loud by printing the owner's status right underneath the evidence. A
 * conversation that reads as "משא ומתן" beside a lead the owner still calls
 * "בטיפול" is the system reporting and the owner deciding — not a conflict.
 *
 * Nothing here prints an internal enum. `NEGOTIATION` is a database value;
 * "נראה כמו משא ומתן" is what a person reads.
 */
function NowSection({
  intelligence,
  status,
}: {
  intelligence: LeadCardDTO["intelligence"];
  status: LeadStatusValue;
}) {
  if (!intelligence) return null;

  const lines: string[] = [];

  if (intelligence.waitingMinutes != null && intelligence.unansweredInboundCount > 0) {
    lines.push(
      intelligence.unansweredInboundCount > 1
        ? `${intelligence.unansweredInboundCount} הודעות ללא מענה · ממתין ${formatWaitLabel(intelligence.waitingMinutes)}`
        : `ממתין לתשובה ${formatWaitLabel(intelligence.waitingMinutes)}`
    );
  } else if (intelligence.signalLabel) {
    lines.push(intelligence.signalLabel);
  }

  if (intelligence.businessSituation?.label) {
    lines.push(`השיחה נראית: ${intelligence.businessSituation.label}`);
  }

  if (intelligence.conversationCount > 1) {
    lines.push(`מתוך ${intelligence.conversationCount} שיחות עם הליד הזה`);
  }

  if (lines.length === 0 && !intelligence.nextBestAction) return null;

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">מה קורה עכשיו</h2>
        {intelligence.temperatureBucket === "hot" ? (
          <span className="crm-section__count" aria-label="שיחה חמה">
            🔥 חם
          </span>
        ) : null}
      </div>

      {lines.map((line) => (
        <p key={line} className="crm-note__body" style={{ margin: "2px 0" }}>
          {line}
        </p>
      ))}

      {intelligence.nextBestAction?.label ? (
        <p
          className="crm-note__body"
          style={{ marginTop: 8, fontWeight: 600, color: "var(--crm-ink)" }}
        >
          {`מומלץ: ${intelligence.nextBestAction.label}`}
        </p>
      ) : null}

      {/* The line that keeps the boundary visible to the owner. */}
      <p className="crm-note-empty" style={{ marginTop: 8 }}>
        {`סטטוס הליד נשאר שלך: ${leadStatusLabel(status)}`}
      </p>
    </div>
  );
}

function formatWaitLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} דק׳`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} שע׳`;
  return `${Math.floor(hours / 24)} ימים`;
}

function FollowUpSection({
  lead,
  followUp,
  needsAttention,
  closed,
  busy,
  onFollowUp,
  onFollowUpDone,
}: {
  lead: LeadCardDTO["lead"];
  followUp: LeadCardDTO["followUp"];
  needsAttention: boolean;
  closed: boolean;
  busy: boolean;
  onFollowUp: (iso: string, note: string | null) => void;
  onFollowUpDone: () => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [note, setNote] = useState("");

  const tone = followUpTone(followUp);
  const label = leadFollowUpLabel(followUp);

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">מעקב</h2>
        {tone && label ? (
          <span
            className="crm-badge"
            style={{
              background: tone.bg,
              color: tone.color,
              border: `1px solid ${tone.border}`,
            }}
          >
            {label}
          </span>
        ) : null}
      </div>

      {closed ? (
        <p className="crm-note-empty">הליד סגור — אין צורך במעקב.</p>
      ) : (
        <>
          {followUp.kind === "none" ? (
            <p className="crm-note-empty" style={{ marginBottom: 10 }}>
              עוד לא נקבע מעקב. קבעו מתי לחזור אליו כדי שלא יישכח.
            </p>
          ) : (
            <p className="crm-note-empty" style={{ marginBottom: 10 }}>
              {needsAttention ? "צריך לחזור אליו: " : "מעקב ל־"}
              {formatDateTime(lead.nextFollowUpAt) ?? ""}
              {lead.followUpNote ? ` — ${lead.followUpNote}` : ""}
            </p>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {FOLLOWUP_PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                className="crm-btn crm-btn--ghost"
                disabled={busy}
                onClick={() => onFollowUp(presetIso(p.days), note.trim() || null)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className="crm-btn crm-btn--ghost"
              disabled={busy}
              onClick={() => setCustomOpen((v) => !v)}
            >
              תאריך אחר
            </button>
            {followUp.kind !== "none" ? (
              <button
                type="button"
                className="crm-btn crm-btn--primary"
                disabled={busy}
                onClick={onFollowUpDone}
              >
                {busy ? "מעדכן…" : "טופל"}
              </button>
            ) : null}
          </div>

          {customOpen ? (
            <div style={{ marginTop: 12 }}>
              <div className="crm-field">
                <label className="crm-field__label" htmlFor="lead-followup-at">
                  מתי לחזור
                </label>
                <input
                  id="lead-followup-at"
                  className="crm-input"
                  type="datetime-local"
                  value={customValue}
                  onChange={(e) => setCustomValue(e.target.value)}
                />
              </div>
              <div className="crm-field">
                <label className="crm-field__label" htmlFor="lead-followup-note">
                  על מה
                </label>
                <input
                  id="lead-followup-note"
                  className="crm-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="לא חובה"
                />
              </div>
              <button
                type="button"
                className="crm-btn crm-btn--primary"
                disabled={busy || !customValue}
                onClick={() => {
                  const iso = localInputToIso(customValue);
                  if (iso) {
                    onFollowUp(iso, note.trim() || null);
                    setCustomOpen(false);
                  }
                }}
              >
                קבע מעקב
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function StatusSection({
  status,
  busy,
  onStatus,
}: {
  status: LeadStatusValue;
  busy: boolean;
  onStatus: (next: LeadStatusValue, lostReason?: string | null) => void;
}) {
  const [lostOpen, setLostOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">סטטוס</h2>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {LEAD_STATUSES.map((s) => {
          const selected = s === status;
          if (s === "LOST") {
            return (
              <button
                key={s}
                type="button"
                className="crm-chip"
                aria-pressed={selected}
                disabled={busy}
                onClick={() => setLostOpen((v) => !v)}
                style={{
                  cursor: "pointer",
                  border: `1px solid ${selected ? "transparent" : "var(--crm-line)"}`,
                  ...(selected
                    ? { background: "var(--crm-accent)", color: "var(--crm-on-accent)" }
                    : {}),
                }}
              >
                {leadStatusLabel(s)}
              </button>
            );
          }
          return (
            <button
              key={s}
              type="button"
              className="crm-chip"
              aria-pressed={selected}
              disabled={busy}
              onClick={() => onStatus(s)}
              style={{
                cursor: "pointer",
                border: `1px solid ${selected ? "transparent" : "var(--crm-line)"}`,
                ...(selected
                  ? { background: "var(--crm-accent)", color: "var(--crm-on-accent)" }
                  : {}),
              }}
            >
              {leadStatusLabel(s)}
            </button>
          );
        })}
      </div>

      {lostOpen ? (
        <div style={{ marginTop: 12 }}>
          <div className="crm-field">
            <label className="crm-field__label" htmlFor="lead-lost-reason">
              למה לא נסגר
            </label>
            <input
              id="lead-lost-reason"
              className="crm-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="מחיר, תזמון, בחר מתחרה…"
            />
          </div>
          <button
            type="button"
            className="crm-btn crm-btn--primary"
            disabled={busy}
            onClick={() => {
              onStatus("LOST", reason.trim() || null);
              setLostOpen(false);
            }}
          >
            {busy ? "מעדכן…" : "סמן כלא נסגר"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
