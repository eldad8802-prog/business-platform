"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

const FILTERS: Array<{ key: CustomerLifecycleFilter; label: string }> = [
  { key: "active", label: "פעילים" },
  { key: "inactive", label: "לא פעילים" },
  { key: "all", label: "הכול" },
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
  const [customers, setCustomers] = useState<CustomerListRow[]>([]);
  const [query, setQuery] = useState("");
  // Lifecycle filter (C2). The CRM surface defaults to "active"; the API/client
  // default stays "all" for Billing / legacy callers, so this only narrows the CRM.
  const [status, setStatus] = useState<CustomerLifecycleFilter>("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
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
          error: err instanceof Error ? err.message : "לא הצלחנו לטעון את רשימת הלקוחות",
        };
      }
    },
    [],
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
          <h1 className="crm-hd__title">לקוחות</h1>
          {!loading && !error ? (
            <div className="crm-hd__sub">
              {customers.length} {customers.length === 1 ? "לקוח" : "לקוחות"}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="crm-btn crm-btn--primary"
          onClick={() => setCreateOpen(true)}
        >
          + לקוח חדש
        </button>
      </div>

      <input
        className="crm-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="חיפוש לפי שם או טלפון"
        inputMode="search"
      />

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
              style={{
                cursor: "pointer",
                border: `1px solid ${selected ? "transparent" : "var(--crm-line)"}`,
                ...(selected
                  ? {
                      background: "var(--crm-accent)",
                      color: "var(--crm-on-accent)",
                    }
                  : {}),
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">משהו השתבש</p>
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            נסו שוב
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
              ? "לא נמצאו לקוחות"
              : status === "inactive"
                ? "אין לקוחות לא פעילים"
                : status === "all"
                  ? "עדיין אין לקוחות"
                  : "עדיין אין לקוחות פעילים"}
          </p>
          <p className="crm-panel__body">
            {isSearching
              ? "נסו חיפוש קצר יותר או בשם אחר."
              : status === "inactive"
                ? "לקוחות שתשביתו יופיעו כאן."
                : "הוסיפו את הלקוח הראשון כדי לנהל את הפרטים, המסמכים והפעילות במקום אחד."}
          </p>
          {!isSearching && status !== "inactive" ? (
            <button
              type="button"
              className="crm-btn crm-btn--primary"
              onClick={() => setCreateOpen(true)}
            >
              + לקוח חדש
            </button>
          ) : null}
        </div>
      ) : (
        <div className="crm-rows">
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
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("יש להזין שם לקוח");
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
      setError(err instanceof Error ? err.message : "לא הצלחנו ליצור לקוח");
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label="לקוח חדש">
        <h2 className="crm-modal__title">לקוח חדש</h2>

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="crm-new-name">
            שם *
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
            טלפון
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
            אימייל
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
            עיר
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
            {saving ? "שומר…" : "שמירה"}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
