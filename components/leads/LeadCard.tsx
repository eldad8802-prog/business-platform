"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import BackButton from "@/components/ui/back-button";
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
import { LEAD_STATUSES, type LeadStatusValue } from "@/lib/services/crm/lead-core";
import { NotesThread } from "@/components/crm/NotesThread";
import { AttachmentList } from "@/components/crm/AttachmentList";
import { LeadLifecycleSection } from "@/components/leads/LeadLifecycleSection";
import {
  followUpTone,
  formatDate,
  formatDateTime,
  formatWait,
  isClosed,
  leadFollowUpText,
  leadSourceLabel,
  leadStatusLabel,
  leadStatusTone,
} from "@/components/leads/lead-display";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

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
const FOLLOWUP_PRESETS: ReadonlyArray<{ days: number; label: MessageKey }> = [
  { days: 1, label: "customers.leads.followUpSection.presets.tomorrow" },
  { days: 3, label: "customers.leads.followUpSection.presets.inThreeDays" },
  { days: 7, label: "customers.leads.followUpSection.presets.nextWeek" },
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
  const { t } = useI18n();
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
      const message = err instanceof Error ? err.message : t("customers.leads.card.loadError");
      return message.includes("not found") || message.includes("לא נמצא")
        ? { status: "notFound" }
        : { status: "error", message };
    }
  }, [id, t]);

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
      <div className="crm-hd__back">
        <BackButton />
      </div>

      {state.status === "loading" ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : state.status === "notFound" ? (
        <div className="crm-panel">
          <p className="crm-panel__title">{t("customers.leads.card.notFoundTitle")}</p>
          <p className="crm-panel__body">{t("customers.leads.card.notFoundBody")}</p>
          <Link className="crm-btn crm-btn--ghost" href="/leads">
            {t("customers.leads.card.backToList")}
          </Link>
        </div>
      ) : state.status === "error" ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">{t("customers.leads.common.errorTitle")}</p>
          <p className="crm-panel__body">{state.message}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            {t("customers.leads.common.retry")}
          </button>
        </div>
      ) : (
        <LeadCardBody
          card={state.card}
          busy={busy}
          actionError={actionError}
          onStatus={(status, lostReason) =>
            void mutate(
              // M5 — the version this screen shows: a newer change elsewhere is refused, not overwritten.
              () => updateLeadStatus(id, status, lostReason, state.card.lead.lifecycleVersion),
              t("customers.leads.card.statusError")
            )
          }
          onFollowUp={(iso, note) =>
            void mutate(
              () => setLeadFollowUp(id, iso, note),
              t("customers.leads.card.followUpSetError")
            )
          }
          onFollowUpDone={() =>
            void mutate(() => clearLeadFollowUp(id), t("customers.leads.card.followUpClearError"))
          }
          onMutate={(fn, fallback) => void mutate(fn, fallback)}
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
  onMutate,
}: {
  card: LeadCardDTO;
  busy: boolean;
  actionError: string | null;
  onStatus: (status: LeadStatusValue, lostReason?: string | null) => void;
  onFollowUp: (iso: string, note: string | null) => void;
  onFollowUpDone: () => void;
  onMutate: (fn: () => Promise<LeadCardDTO>, fallback: string) => void;
}) {
  const { t, locale } = useI18n();
  const { lead, customer, followUp, conversations, needsAttention, intelligence } = card;
  const closed = isClosed(lead.status);
  const tone = leadStatusTone(lead.status);

  const identityFields: Array<{ label: string; value: string }> = [];
  if (lead.phone) {
    identityFields.push({ label: t("customers.leads.card.fields.phone"), value: formatPhoneForDisplay(lead.phone) });
  }
  // G-01b — the phone typed into an anonymous enquiry: shown for what it is, never as the lead's verified phone.
  if (lead.claimedPhone) {
    identityFields.push({ label: t("customers.leads.card.fields.claimedPhone"), value: formatPhoneForDisplay(lead.claimedPhone) });
  }
  // The number the quick actions use (Lead.phone first). Calling or messaging it verifies and links nothing.
  const reachPhone = lead.contactPhone?.value ?? null;
  if (lead.email) identityFields.push({ label: t("customers.leads.card.fields.email"), value: lead.email });
  const sourceLabel = leadSourceLabel(lead.sourceChannel, t);
  if (sourceLabel) identityFields.push({ label: t("customers.leads.card.fields.source"), value: sourceLabel });
  const created = formatDate(lead.createdAt, locale);
  if (created) identityFields.push({ label: t("customers.leads.card.fields.created"), value: created });
  if (closed && lead.closedAt) {
    const closedAt = formatDate(lead.closedAt, locale);
    if (closedAt) identityFields.push({ label: t("customers.leads.card.fields.closed"), value: closedAt });
  }
  if (lead.lostReason) {
    identityFields.push({ label: t("customers.leads.card.fields.reason"), value: lead.lostReason });
  }

  return (
    <>
      <div className="crm-id">
        <div className="crm-id__head">
          <h1 className="crm-id__name">
            <bdi>{lead.name ?? t("customers.leads.common.unnamed")}</bdi>
          </h1>
          <span
            className="crm-badge"
            style={{
              background: tone.bg,
              color: tone.color,
              border: `1px solid ${tone.border}`,
              flexShrink: 0,
            }}
          >
            {leadStatusLabel(lead.status, t)}
          </span>
        </div>

        {identityFields.length > 0 ? (
          <div className="crm-id__grid">
            {identityFields.map((f) => (
              <div className="crm-id__field" key={f.label}>
                <div className="crm-id__label">{f.label}</div>
                {/* `bdi` so a phone / email keeps its own direction inside the
                    RTL card instead of reordering against the label. */}
                <div className="crm-id__value">
                  <bdi>{f.value}</bdi>
                </div>
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
              {t("customers.leads.card.customerLink", { name: customer.name })}
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
      {reachPhone ? (
        <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
          <a
            className="crm-btn crm-btn--primary"
            href={`https://wa.me/${reachPhone.replace(/\D/g, "")}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("customers.leads.card.whatsapp")}
          </a>
          <a className="crm-btn crm-btn--ghost" href={`tel:+${reachPhone.replace(/\D/g, "")}`}>
            {t("customers.leads.card.dial")}
          </a>
        </div>
      ) : null}

      {lead.intentSnapshot ? (
        <div className="crm-section">
          <div className="crm-section__head">
            <h2 className="crm-section__title">{t("customers.leads.card.intentTitle")}</h2>
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

      <LeadLifecycleSection card={card} busy={busy} onMutate={onMutate} />

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
          <h2 className="crm-section__title">{t("customers.leads.card.conversationsTitle")}</h2>
          <span className="crm-section__count">{conversations.total}</span>
        </div>
        {conversations.items.length === 0 ? (
          <p className="crm-note-empty">{t("customers.leads.card.noConversations")}</p>
        ) : (
          <div className="crm-list">
            {conversations.items.map((c) => (
              <div className="crm-item" key={c.id}>
                <div className="crm-item__main">
                  <div className="crm-item__title">{c.channel}</div>
                  <div className="crm-item__meta">
                    {formatDateTime(c.lastMessageAt ?? c.startedAt, locale) ?? ""}
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
  const { t } = useI18n();
  if (!intelligence) return null;

  const lines: string[] = [];

  if (intelligence.waitingMinutes != null && intelligence.unansweredInboundCount > 0) {
    lines.push(
      intelligence.unansweredInboundCount > 1
        ? t("customers.leads.now.unansweredWaiting", {
            count: intelligence.unansweredInboundCount,
            wait: formatWait(intelligence.waitingMinutes, t),
          })
        : t("customers.leads.now.waitingReply", { wait: formatWait(intelligence.waitingMinutes, t) })
    );
  } else if (intelligence.signalLabel) {
    lines.push(intelligence.signalLabel);
  }

  if (intelligence.businessSituation?.label) {
    lines.push(t("customers.leads.now.situation", { label: intelligence.businessSituation.label }));
  }

  if (intelligence.conversationCount > 1) {
    lines.push(t("customers.leads.now.conversationCount", { count: intelligence.conversationCount }));
  }

  if (lines.length === 0 && !intelligence.nextBestAction) return null;

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">{t("customers.leads.now.title")}</h2>
        {intelligence.temperatureBucket === "hot" ? (
          <span className="crm-section__count" aria-label={t("customers.leads.now.hotAria")}>
            {t("customers.leads.now.hot")}
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
          {t("customers.leads.now.recommended", { label: intelligence.nextBestAction.label })}
        </p>
      ) : null}

      {/* The line that keeps the boundary visible to the owner. */}
      <p className="crm-note-empty" style={{ marginTop: 8 }}>
        {t("customers.leads.now.statusYours", { status: leadStatusLabel(status, t) })}
      </p>
    </div>
  );
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
  const { t, locale } = useI18n();
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [note, setNote] = useState("");

  const tone = followUpTone(followUp);
  const label = leadFollowUpText(followUp, t);

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">{t("customers.leads.followUpSection.title")}</h2>
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
        <p className="crm-note-empty">{t("customers.leads.followUpSection.closed")}</p>
      ) : (
        <>
          {followUp.kind === "none" ? (
            <p className="crm-note-empty" style={{ marginBottom: 10 }}>
              {t("customers.leads.followUpSection.none")}
            </p>
          ) : (
            <p className="crm-note-empty" style={{ marginBottom: 10 }}>
              {needsAttention ? t("customers.leads.followUpSection.needsReturn") : t("customers.leads.followUpSection.scheduledFor")}
              {formatDateTime(lead.nextFollowUpAt, locale) ?? ""}
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
                {t(p.label)}
              </button>
            ))}
            <button
              type="button"
              className="crm-btn crm-btn--ghost"
              disabled={busy}
              onClick={() => setCustomOpen((v) => !v)}
            >
              {t("customers.leads.followUpSection.otherDate")}
            </button>
            {followUp.kind !== "none" ? (
              <button
                type="button"
                className="crm-btn crm-btn--primary"
                disabled={busy}
                onClick={onFollowUpDone}
              >
                {busy ? t("customers.leads.common.updating") : t("customers.leads.common.done")}
              </button>
            ) : null}
          </div>

          {customOpen ? (
            <div style={{ marginTop: 12 }}>
              <div className="crm-field">
                <label className="crm-field__label" htmlFor="lead-followup-at">
                  {t("customers.leads.followUpSection.whenLabel")}
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
                  {t("customers.leads.followUpSection.aboutLabel")}
                </label>
                <input
                  id="lead-followup-note"
                  className="crm-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("customers.leads.followUpSection.optional")}
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
                {t("customers.leads.followUpSection.set")}
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
  const { t } = useI18n();
  const [lostOpen, setLostOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className="crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">{t("customers.leads.statusSection.title")}</h2>
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
                {leadStatusLabel(s, t)}
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
              {leadStatusLabel(s, t)}
            </button>
          );
        })}
      </div>

      {lostOpen ? (
        <div style={{ marginTop: 12 }}>
          <div className="crm-field">
            <label className="crm-field__label" htmlFor="lead-lost-reason">
              {t("customers.leads.statusSection.lostReasonLabel")}
            </label>
            <input
              id="lead-lost-reason"
              className="crm-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("customers.leads.statusSection.lostReasonPlaceholder")}
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
            {busy ? t("customers.leads.common.updating") : t("customers.leads.statusSection.markLost")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
