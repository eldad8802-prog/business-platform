"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getCustomers,
  createCustomer,
  type CustomerListRow,
} from "@/lib/api/customers";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

function rowMeta(c: CustomerListRow): string | null {
  const phone = c.phone ? formatPhoneForDisplay(c.phone) : null;
  return [phone, c.email, c.city].filter((v) => v && String(v).trim()).join(" · ") || null;
}

export default function CustomersListPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<CustomerListRow[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const searchedOnce = useRef(false);

  const load = useCallback(async (q: string) => {
    const token = getClientAuthToken();
    if (!token) {
      setLoading(false);
      redirectToLogin();
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await getCustomers(q);
      setCustomers(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את רשימת הלקוחות");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void load("");
  }, [load]);

  // Debounced server-side search on query change (skips the initial mount).
  useEffect(() => {
    if (!searchedOnce.current) {
      searchedOnce.current = true;
      return;
    }
    const timer = window.setTimeout(() => void load(query), 300);
    return () => window.clearTimeout(timer);
  }, [query, load]);

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

      {error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">משהו השתבש</p>
          <p className="crm-panel__body">{error}</p>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={() => void load(query)}
          >
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
            {isSearching ? "לא נמצאו לקוחות" : "עדיין אין לקוחות"}
          </p>
          <p className="crm-panel__body">
            {isSearching
              ? "נסו חיפוש קצר יותר או בשם אחר."
              : "הוסיפו את הלקוח הראשון כדי לנהל את הפרטים, המסמכים והפעילות במקום אחד."}
          </p>
          {!isSearching ? (
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
          {customers.map((c) => {
            const meta = rowMeta(c);
            return (
              <a key={c.id} className="crm-row" href={`/customers/${c.id}`}>
                <span className="crm-row__avatar" aria-hidden>
                  {initials(c.name)}
                </span>
                <span className="crm-row__body">
                  <span className="crm-row__name">{c.name}</span>
                  {meta ? <span className="crm-row__meta">{meta}</span> : null}
                </span>
                <span className="crm-row__chevron" aria-hidden>
                  ‹
                </span>
              </a>
            );
          })}
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
