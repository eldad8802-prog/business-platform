"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useConsumeQueryFlag } from "@/hooks/useConsumeQueryFlag";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getLeads,
  createLead,
  setLeadFollowUp,
  clearLeadFollowUp,
  LEAD_CHANGED_EVENT,
  type LeadListRow,
  type LeadStatusFilter,
  type LeadRankingConfidence,
} from "@/lib/api/leads";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { LeadRow } from "@/components/leads/LeadRow";
import { LEAD_SOURCE_OPTION_KEYS } from "@/components/leads/lead-display";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

/**
 * Leads Inbox (master).
 *
 * Lives in the stable `leads/layout` so it is fetched once and never remounts
 * when the selected lead changes — only the detail region swaps. Mirrors
 * `CustomersList` deliberately: same fetch discipline, same skeletons, same
 * error panel, same modal shape.
 *
 * Filters are a work queue, not a taxonomy: "דורש טיפול" first (follow-ups that
 * have come due), then open, then closed, then everything.
 */

type FilterKey = "needsAction" | "open" | "closed" | "all";

const FILTERS: Array<{ key: FilterKey; label: MessageKey }> = [
  { key: "needsAction", label: "customers.leads.list.filters.needsAction" },
  { key: "open", label: "customers.leads.list.filters.open" },
  { key: "closed", label: "customers.leads.list.filters.closed" },
  { key: "all", label: "customers.leads.list.filters.all" },
];

function toQuery(filter: FilterKey): {
  status: LeadStatusFilter;
  needsAction: boolean;
} {
  if (filter === "needsAction") return { status: "open", needsAction: true };
  if (filter === "closed") return { status: "closed", needsAction: false };
  if (filter === "all") return { status: "all", needsAction: false };
  return { status: "open", needsAction: false };
}

export function LeadsList({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const { t } = useI18n();
  // Home links here with ?view=needsAction so the count it showed and the rows
  // shown here are the same set. Any other value falls back to the work queue.
  const searchParams = useSearchParams();
  const initialFilter: FilterKey =
    searchParams?.get("view") === "needsAction" ? "needsAction" : "open";
  const [leads, setLeads] = useState<LeadListRow[]>([]);
  const [query, setQuery] = useEntryState("query", "");
  const [filter, setFilter] = useEntryState<FilterKey>("filter", initialFilter);
  // How much the server is willing to claim about the order it returned. When
  // it is only "best-effort" the list must stop implying "this is THE most
  // urgent lead" — see the note rendered above the rows.
  const [ranking, setRanking] = useState<LeadRankingConfidence>("authoritative");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(searchParams.get("new") === "1");
  useConsumeQueryFlag("new");
  const searchedOnce = useRef(false);

  // Returns the result; never sets state — so the effect updates state only
  // after the request resolves, never synchronously.
  const fetchList = useCallback(
    async (
      q: string,
      f: FilterKey
    ): Promise<
      { leads: LeadListRow[]; ranking: LeadRankingConfidence } | { error: string } | null
    > => {
      const token = getClientAuthToken();
      if (!token) {
        redirectToLogin();
        return null;
      }
      try {
        const { status, needsAction } = toQuery(f);
        const data = await getLeads({ query: q, status, needsAction });
        return { leads: data.leads, ranking: data.ranking };
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return null;
        }
        return {
          error:
            err instanceof Error ? err.message : t("customers.leads.list.loadError"),
        };
      }
    },
    [t]
  );

  function apply(
    res: { leads: LeadListRow[]; ranking: LeadRankingConfidence } | { error: string } | null
  ) {
    if (!res) return;
    if ("error" in res) setError(res.error);
    else {
      setError(null);
      setLeads(res.leads);
      setRanking(res.ranking);
    }
    setLoading(false);
  }

  // Initial load. Honours the deep-link filter so arriving from Home lands on
  // exactly the rows Home counted.
  useEffect(() => {
    let cancelled = false;
    void fetchList("", initialFilter).then((res) => {
      if (!cancelled) apply(res);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchList, initialFilter]);

  /**
   * Handle a follow-up straight from the row. The owner is looking at the list
   * of things they owe people — making them open each one to say "done" is the
   * friction that turns a work queue into a wall.
   */
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const handleFollowUp = async (leadId: number, kind: "complete" | "snooze") => {
    if (rowBusy !== null) return;
    setRowBusy(leadId);
    try {
      if (kind === "complete") await clearLeadFollowUp(leadId);
      else
        await setLeadFollowUp(
          leadId,
          new Date(Date.now() + 3 * 86400000).toISOString()
        );
      const res = await fetchList(query, filter);
      if (res && !("error" in res)) setLeads(res.leads);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : t("customers.leads.list.followUpError"));
    } finally {
      setRowBusy(null);
    }
  };

  // Debounced server-side search + filter (skips the initial mount).
  useEffect(() => {
    if (!searchedOnce.current) {
      searchedOnce.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetchList(query, filter).then(apply);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, filter, fetchList]);

  // Re-read when the card beside us changes a lead. On desktop both panes are
  // visible at once, so without this the row would keep showing a follow-up the
  // owner has already handled. Silent by design: no skeleton, no scroll jump —
  // the list simply stops disagreeing with the card.
  useEffect(() => {
    const onChanged = () => {
      void fetchList(query, filter).then((res) => {
        if (res && !("error" in res)) setLeads(res.leads);
      });
    };
    window.addEventListener(LEAD_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LEAD_CHANGED_EVENT, onChanged);
  }, [query, filter, fetchList]);

  const retry = () => {
    setLoading(true);
    setError(null);
    void fetchList(query, filter).then(apply);
  };

  const isSearching = query.trim().length > 0;

  return (
    <div className="crm-page">
      <div className="crm-hd">
        <div>
          <h1 className="crm-hd__title">{t("customers.leads.list.title")}</h1>
          {!loading && !error ? (
            <div className="crm-hd__sub">
              {t(leads.length === 1 ? "customers.leads.list.countOne" : "customers.leads.list.countMany", { count: leads.length })}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="crm-btn crm-btn--primary"
          onClick={() => setCreateOpen(true)}
        >
          {t("customers.leads.list.newButton")}
        </button>
      </div>

      <input
        className="crm-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("customers.leads.list.searchPlaceholder")}
        inputMode="search"
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {FILTERS.map((f) => {
          const selected = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              className="crm-chip"
              onClick={() => setFilter(f.key)}
              aria-pressed={selected}
              style={{
                cursor: "pointer",
                border: `1px solid ${selected ? "transparent" : "var(--crm-line)"}`,
                ...(selected
                  ? { background: "var(--crm-accent)", color: "var(--crm-on-accent)" }
                  : {}),
              }}
            >
              {t(f.label)}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">{t("customers.leads.common.errorTitle")}</p>
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            {t("customers.leads.common.retry")}
          </button>
        </div>
      ) : loading ? (
        <div>
          <div className="crm-skel" />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : leads.length === 0 ? (
        <EmptyLeads
          isSearching={isSearching}
          filter={filter}
          onCreate={() => setCreateOpen(true)}
        />
      ) : (
        <div className="crm-rows">
          {/* FAIL-SAFE. When the server could not score every lead that might
              outrank these, the list stops implying "this is THE one to handle
              first" and says what it actually is: the most urgent it found.
              Each row's own reason is still exact — only the global superlative
              is withdrawn. Deliberately one quiet line, not a warning: the
              owner is not being told about a bound, they are being told not to
              read the top row as a verdict. */}
          {ranking === "best-effort" ? (
            <p className="crm-note-empty" style={{ margin: "0 0 8px" }}>
              {t("customers.leads.list.bestEffort")}
            </p>
          ) : null}
          {leads.map((l) => (
            <div key={l.id}>
              <LeadRow lead={l} selected={String(l.id) === selectedId} />
              {/* Sibling, not child: LeadRow is a <Link>, and nesting buttons
                  inside it would be invalid and keyboard-unreachable. */}
              {l.needsAttention && l.followUp.kind !== "none" ? (
                <div style={{ display: "flex", gap: 8, margin: "6px 4px 0", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="crm-chip"
                    disabled={rowBusy === l.id}
                    onClick={() => void handleFollowUp(l.id, "complete")}
                    style={{ cursor: "pointer", minHeight: 34, border: "1px solid var(--crm-line)" }}
                  >
                    {rowBusy === l.id ? t("customers.leads.common.updating") : t("customers.leads.common.done")}
                  </button>
                  <button
                    type="button"
                    className="crm-chip"
                    disabled={rowBusy === l.id}
                    onClick={() => void handleFollowUp(l.id, "snooze")}
                    style={{ cursor: "pointer", minHeight: 34, border: "1px solid var(--crm-line)" }}
                  >
                    {t("customers.leads.list.snooze")}
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {createOpen ? (
        <CreateLeadModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            router.push(`/leads/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Empty state that TEACHES rather than reporting absence: what a lead is, what
 * Dubiz will do with it, and one obvious way to make the first one. The narrower
 * "nothing matched this filter" cases stay short — the owner already knows what
 * a lead is by then.
 */
function EmptyLeads({
  isSearching,
  filter,
  onCreate,
}: {
  isSearching: boolean;
  filter: FilterKey;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  if (isSearching) {
    return (
      <div className="crm-panel">
        <p className="crm-panel__title">{t("customers.leads.empty.searchTitle")}</p>
        <p className="crm-panel__body">{t("customers.leads.empty.searchBody")}</p>
      </div>
    );
  }

  if (filter === "needsAction") {
    return (
      <div className="crm-panel">
        <p className="crm-panel__title">{t("customers.leads.empty.needsActionTitle")}</p>
        <p className="crm-panel__body">
          {t("customers.leads.empty.needsActionBody")}
        </p>
      </div>
    );
  }

  if (filter === "closed") {
    return (
      <div className="crm-panel">
        <p className="crm-panel__title">{t("customers.leads.empty.closedTitle")}</p>
        <p className="crm-panel__body">
          {t("customers.leads.empty.closedBody")}
        </p>
      </div>
    );
  }

  return (
    <div className="crm-panel">
      <p className="crm-panel__title">{t("customers.leads.empty.defaultTitle")}</p>
      <p className="crm-panel__body">
        {t("customers.leads.empty.defaultBody")}
      </p>
      <button type="button" className="crm-btn crm-btn--primary" onClick={onCreate}>
        {t("customers.leads.list.newButton")}
      </button>
    </div>
  );
}

/**
 * Create form — W1 fields only. Deliberately five inputs, one of them required:
 * a lead the owner cannot be bothered to type is a lead that never gets typed.
 *
 * Validation is client-side for immediacy AND server-side for truth; the server
 * is the authority (an invalid email is refused there even if this form is
 * bypassed). `saving` disables the button, so a double-tap cannot double-submit.
 */
function CreateLeadModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: LeadListRow) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [source, setSource] = useState("MANUAL");
  const [intent, setIntent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (saving) return;
    if (!name.trim()) {
      setError(t("customers.leads.create.nameRequired"));
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const created = await createLead({
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        sourceChannel: source,
        intentSnapshot: intent.trim() || null,
      });
      onCreated(created);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : t("customers.leads.create.error"));
      setSaving(false);
    }
  }

  return (
    <div
      className="crm-modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={t("customers.leads.create.title")}>
        <h2 className="crm-modal__title">{t("customers.leads.create.title")}</h2>

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="lead-new-name">
            {t("customers.leads.create.name")}
          </label>
          <input
            id="lead-new-name"
            className="crm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="lead-new-phone">
            {t("customers.leads.create.phone")}
          </label>
          <input
            id="lead-new-phone"
            className="crm-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="lead-new-email">
            {t("customers.leads.create.email")}
          </label>
          <input
            id="lead-new-email"
            className="crm-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="lead-new-source">
            {t("customers.leads.create.source")}
          </label>
          <select
            id="lead-new-source"
            className="crm-input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            {LEAD_SOURCE_OPTION_KEYS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="lead-new-intent">
            {t("customers.leads.create.intent")}
          </label>
          <textarea
            id="lead-new-intent"
            className="crm-input"
            style={{ minHeight: 72, resize: "vertical" }}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder={t("customers.leads.create.intentPlaceholder")}
          />
        </div>

        {error ? <div className="crm-modal__error">{error}</div> : null}

        <div className="crm-modal__actions">
          <button
            type="button"
            className="crm-btn crm-btn--primary crm-btn--full"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {saving ? t("customers.leads.common.saving") : t("customers.leads.common.save")}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("customers.leads.common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
