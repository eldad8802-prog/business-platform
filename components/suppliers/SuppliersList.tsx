"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getSuppliers,
  createSupplier,
  type SupplierListRow,
  type SupplierStatusFilter,
} from "@/lib/api/suppliers";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";

/**
 * Suppliers master list (Spec v1 §23 — workspace pilot, owner-approved).
 *
 * Extracted verbatim from the old /suppliers page so it can live in the STABLE
 * suppliers layout, exactly like CustomersList: fetched once, never remounted
 * when the selected supplier changes; only the detail region swaps per route.
 * `selectedId` (from the route) highlights the open row in two-pane mode.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] ?? "") + (parts[1][0] ?? "");
}

function rowMeta(s: SupplierListRow): string | null {
  const phone = s.phone ? formatPhoneForDisplay(s.phone) : null;
  return [phone, s.email].filter((v) => v && String(v).trim()).join(" · ") || null;
}

const FILTERS: Array<{ key: SupplierStatusFilter; label: string }> = [
  { key: "active", label: "פעילים" },
  { key: "inactive", label: "לא פעילים" },
  { key: "all", label: "הכול" },
];

export function SuppliersList({ selectedId }: { selectedId: string | null }) {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<SupplierListRow[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SupplierStatusFilter>("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const searchedOnce = useRef(false);

  const load = useCallback(
    async (q: string, st: SupplierStatusFilter) => {
      const token = getClientAuthToken();
      if (!token) {
        setLoading(false);
        redirectToLogin();
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const data = await getSuppliers({ query: q, status: st });
        setSuppliers(Array.isArray(data) ? data : []);
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        setError(
          err instanceof Error ? err.message : "לא הצלחנו לטעון את רשימת הספקים"
        );
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // Initial load.
  useEffect(() => {
    void load("", "active");
  }, [load]);

  // Debounced server-side search + filter reload (skips the initial mount).
  useEffect(() => {
    if (!searchedOnce.current) {
      searchedOnce.current = true;
      return;
    }
    const timer = window.setTimeout(() => void load(query, status), 300);
    return () => window.clearTimeout(timer);
  }, [query, status, load]);

  const isSearching = query.trim().length > 0;

  return (
    <div className="crm-page">
      <div className="crm-hd">
        <div>
          <h1 className="crm-hd__title">ספקים</h1>
          {!loading && !error ? (
            <div className="crm-hd__sub">
              {suppliers.length} {suppliers.length === 1 ? "ספק" : "ספקים"}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="crm-btn crm-btn--primary"
          onClick={() => setCreateOpen(true)}
        >
          + ספק חדש
        </button>
      </div>

      <input
        className="crm-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="חיפוש לפי שם"
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
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={() => void load(query, status)}
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
      ) : suppliers.length === 0 ? (
        <div className="crm-panel">
          <p className="crm-panel__title">
            {isSearching
              ? "לא נמצאו ספקים"
              : status === "inactive"
                ? "אין ספקים לא פעילים"
                : "עדיין אין ספקים"}
          </p>
          <p className="crm-panel__body">
            {isSearching
              ? "נסו חיפוש קצר יותר או בשם אחר."
              : status === "inactive"
                ? "ספקים שתשביתו יופיעו כאן."
                : "הוסיפו את הספק הראשון כדי לנהל את פרטי הקשר וזמני האספקה במקום אחד."}
          </p>
          {!isSearching && status !== "inactive" ? (
            <button
              type="button"
              className="crm-btn crm-btn--primary"
              onClick={() => setCreateOpen(true)}
            >
              + ספק חדש
            </button>
          ) : null}
        </div>
      ) : (
        <div className="crm-rows">
          {suppliers.map((s) => {
            const meta = rowMeta(s);
            const selected = String(s.id) === selectedId;
            return (
              <a
                key={s.id}
                className={`crm-row${selected ? " crm-row--selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                href={`/suppliers/${s.id}`}
              >
                <span className="crm-row__avatar" aria-hidden>
                  {initials(s.name)}
                </span>
                <span className="crm-row__body">
                  <span className="crm-row__name">
                    {s.name}
                    {!s.isActive ? (
                      <span
                        className="crm-badge"
                        style={{ marginInlineStart: 8, verticalAlign: "middle" }}
                      >
                        לא פעיל
                      </span>
                    ) : null}
                  </span>
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
        <CreateSupplierModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            router.push(`/suppliers/${created.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateSupplierModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: { id: number }) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("יש להזין שם ספק");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const created = await createSupplier({
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
      });
      onCreated(created);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו ליצור ספק");
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label="ספק חדש">
        <h2 className="crm-modal__title">ספק חדש</h2>

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-new-name">
            שם *
          </label>
          <input
            id="sup-new-name"
            className="crm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-new-phone">
            טלפון
          </label>
          <input
            id="sup-new-phone"
            className="crm-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-new-email">
            אימייל
          </label>
          <input
            id="sup-new-email"
            className="crm-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
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
