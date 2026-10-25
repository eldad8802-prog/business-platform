"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useRouter, useSearchParams } from "next/navigation";
import {
  getCustomers,
  createCustomer,
  type CustomerListRow,
  type CustomerLifecycleFilter,
} from "@/lib/api/customers";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { CustomerRow } from "@/components/customers/CustomerRow";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

// Order follows the approved list design (הכול · פעילים · לא פעילים); the
// default selection stays "active".
const FILTERS: Array<{ key: CustomerLifecycleFilter; labelKey: MessageKey }> = [
  { key: "all", labelKey: "customers.customer.list.filters.all" },
  { key: "active", labelKey: "customers.customer.list.filters.active" },
  { key: "inactive", labelKey: "customers.customer.list.filters.inactive" },
];

/**
 * Customers list (master). Lives in the stable `customers/layout` so it is
 * fetched once and never remounts when the selected customer changes — only the
 * detail region swaps. `selectedId` (from the route) highlights the open row on
 * desktop; server-side search still refetches the list on query change (a user
 * action), but selecting a customer never does. The fetch depends on nothing
 * reactive, so navigation can't re-trigger it.
 */
export function CustomersList({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const [customers, setCustomers] = useState<CustomerListRow[]>([]);
  const [query, setQuery] = useEntryState("query", "");
  // Lifecycle filter (C2). The CRM surface defaults to "active"; the API/client
  // default stays "all" for Billing / legacy callers, so this only narrows the CRM.
  const [status, setStatus] = useEntryState<CustomerLifecycleFilter>("status", "active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `/customers?new=1` opens the create form on arrival — the same deep link
  // the leads list honours with `/leads?new=1` (Home's "לקוח חדש" shortcut).
  const [createOpen, setCreateOpen] = useState(searchParams.get("new") === "1");
  const searchedOnce = useRef(false);

  // Returns the result; never sets state — so the effect updates state only
  // after the request resolves, never synchronously.
  const fetchList = useCallback(
    async (
      q: string,
      st: CustomerLifecycleFilter,
    ): Promise<{ customers: CustomerListRow[] } | { error: string } | null> => {
      const token = getClientAuthToken();
      if (!token) {
        redirectToLogin();
        return null;
      }
      try {
        const data = await getCustomers({ query: q, status: st });
        return { customers: Array.isArray(data) ? data : [] };
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return null;
        }
        return {
          error: err instanceof Error ? err.message : t("customers.customer.list.loadError"),
        };
      }
    },
    [t],
  );

  function apply(res: { customers: CustomerListRow[] } | { error: string } | null) {
    if (!res) return;
    if ("error" in res) setError(res.error);
    else {
      setError(null);
      setCustomers(res.customers);
    }
    setLoading(false);
  }

  // Initial load (active by default).
  useEffect(() => {
    let cancelled = false;
    void fetchList("", "active").then((res) => {
      if (!cancelled) apply(res);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchList]);

  // Debounced server-side search + lifecycle filter (skips the initial mount).
  useEffect(() => {
    if (!searchedOnce.current) {
      searchedOnce.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void fetchList(query, status).then(apply);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, status, fetchList]);

  const retry = () => {
    setLoading(true);
    setError(null);
    void fetchList(query, status).then(apply);
  };

  const isSearching = query.trim().length > 0;

  return (
    <div className="crm-page">
      <div className="crm-hd">
        <div>
          <h1 className="crm-hd__title">{t("customers.customer.list.title")}</h1>
          {!loading && !error ? (
            <div className="crm-hd__sub">
              {customers.length === 1
                ? t("customers.customer.list.countOne", { count: customers.length })
                : t("customers.customer.list.countMany", { count: customers.length })}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="crm-btn crm-btn--primary"
          onClick={() => setCreateOpen(true)}
        >
          {t("customers.customer.list.newButton")}
        </button>
      </div>

      <div className="cust-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4.2-4.2" />
        </svg>
        <input
          className="crm-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("customers.customer.list.searchPlaceholder")}
          aria-label={t("customers.customer.list.searchPlaceholder")}
          inputMode="search"
        />
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 14,
        }}
      >
        {FILTERS.map((f) => {
          const selected = status === f.key;
          return (
            <button
              key={f.key}
              type="button"
              className="crm-chip"
              onClick={() => setStatus(f.key)}
              aria-pressed={selected}
              // Selection, not a primary action — the milky-sage treatment the
              // sidebar already uses. `data-dz-selectable` picks up the shared
              // hover/focus layer, keyed off the same aria-pressed above.
              data-dz-selectable
              style={{
                cursor: "pointer",
                border: `1px solid ${selected ? "var(--crm-selection-border)" : "var(--crm-line)"}`,
                ...(selected
                  ? {
                      background: "var(--crm-selection-bg)",
                      color: "var(--crm-selection-text)",
                      fontWeight: 600,
                    }
                  : {}),
              }}
            >
              {t(f.labelKey)}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">{t("customers.customer.common.errorTitle")}</p>
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            {t("customers.customer.common.retry")}
          </button>
        </div>
      ) : loading ? (
        <div>
          <div className="crm-skel" />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : customers.length === 0 ? (
        <div className="crm-panel">
          <p className="crm-panel__title">
            {isSearching
              ? t("customers.customer.list.empty.searchTitle")
              : status === "inactive"
                ? t("customers.customer.list.empty.inactiveTitle")
                : status === "all"
                  ? t("customers.customer.list.empty.allTitle")
                  : t("customers.customer.list.empty.activeTitle")}
          </p>
          <p className="crm-panel__body">
            {isSearching
              ? t("customers.customer.list.empty.searchBody")
              : status === "inactive"
                ? t("customers.customer.list.empty.inactiveBody")
                : t("customers.customer.list.empty.defaultBody")}
          </p>
          {!isSearching && status !== "inactive" ? (
            <button
              type="button"
              className="crm-btn crm-btn--primary"
              onClick={() => setCreateOpen(true)}
            >
              {t("customers.customer.list.newButton")}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="cust-cards">
          {customers.map((c) => (
            <CustomerRow key={c.id} customer={c} selected={String(c.id) === selectedId} />
          ))}
        </div>
      )}

      {createOpen ? (
        <CreateCustomerModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            router.push(`/customers/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateCustomerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CustomerListRow) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError(t("customers.customer.form.nameRequired"));
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const created = await createCustomer({
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        city: city.trim() || null,
      });
      onCreated(created);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : t("customers.customer.create.error"));
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={t("customers.customer.create.title")}>
        <h2 className="crm-modal__title">{t("customers.customer.create.title")}</h2>

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="crm-new-name">
            {t("customers.customer.form.name")}
          </label>
          <input
            id="crm-new-name"
            className="crm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="crm-new-phone">
            {t("customers.customer.form.phone")}
          </label>
          <input
            id="crm-new-phone"
            className="crm-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="crm-new-email">
            {t("customers.customer.form.email")}
          </label>
          <input
            id="crm-new-email"
            className="crm-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="crm-new-city">
            {t("customers.customer.form.city")}
          </label>
          <input
            id="crm-new-city"
            className="crm-input"
            value={city}
            onChange={(e) => setCity(e.target.value)}
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
            {saving ? t("customers.customer.form.saving") : t("customers.customer.form.save")}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("customers.customer.form.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
