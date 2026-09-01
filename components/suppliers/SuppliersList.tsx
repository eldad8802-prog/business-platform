"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getSuppliers,
  createSupplier,
  type PossibleSupplierMatch,
  type SupplierListRow,
  type SupplierStatusFilter,
} from "@/lib/api/suppliers";
import { SupplierForm } from "@/components/suppliers/SupplierForm";
import { SupplierDuplicateNotice } from "@/components/suppliers/SupplierDuplicateNotice";
import {
  EMPTY_SUPPLIER_FORM,
  supplierFormToPayload,
  validateSupplierForm,
  type SupplierFormState,
} from "@/components/suppliers/supplier-form-model";
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


/**
 * Create-supplier modal.
 *
 * Two changes from the original three-field version:
 *  1. It renders the full sectioned `SupplierForm`, so a supplier can carry the
 *     business identity / contact / terms an owner needs — while still being
 *     creatable with nothing but a name, since every section is collapsed.
 *  2. It no longer throws the server's `possibleMatches` away. Creation is still
 *     never blocked; the advisory is shown after the fact and the owner chooses.
 */
function CreateSupplierModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: { id: number }) => void;
}) {
  const [form, setForm] = useState<SupplierFormState>(EMPTY_SUPPLIER_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<{
    matches: PossibleSupplierMatch[];
    created: { id: number; name: string };
  } | null>(null);

  const set = useCallback<
    <K extends keyof SupplierFormState>(k: K, v: SupplierFormState[K]) => void
  >((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  async function handleSubmit() {
    const invalid = validateSupplierForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const { supplier, possibleMatches } = await createSupplier(
        supplierFormToPayload(form)
      );

      if (possibleMatches.length > 0) {
        setSaving(false);
        setDuplicates({
          matches: possibleMatches,
          created: { id: supplier.id, name: supplier.name },
        });
        return;
      }

      onCreated(supplier);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו ליצור ספק");
      setSaving(false);
    }
  }

  if (duplicates) {
    return (
      <SupplierDuplicateNotice
        matches={duplicates.matches}
        createdName={duplicates.created.name}
        onOpenExisting={(id) => onCreated({ id })}
        onKeepNew={() => onCreated(duplicates.created)}
      />
    );
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
        <p className="crm-panel__body" style={{ marginTop: -4 }}>
          שם בלבד מספיק כדי להתחיל. אפשר להשלים את שאר הפרטים בכל שלב.
        </p>

        <SupplierForm form={form} set={set} idPrefix="sup-new" />

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
