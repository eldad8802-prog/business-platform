"use client";

import BackButton from "@/components/ui/back-button";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useRouter } from "next/navigation";
import {
  getSuppliersPage,
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
import { CrmRowMeta } from "@/components/crm/CrmRowMeta";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";

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

/**
 * The row's meta VALUES, in reading order — deliberately NOT joined into one
 * string: `CrmRowMeta` owns the separators, the wrapping and the per-value bidi
 * isolation, so a long email cannot run out of the card or reorder itself.
 */
function rowMetaParts(s: SupplierListRow): Array<string | null> {
  return [s.phone ? formatPhoneForDisplay(s.phone) : null, s.email];
}

const FILTERS: Array<{ key: SupplierStatusFilter; label: MessageKey }> = [
  { key: "active", label: "customers.suppliers.list.filterActive" },
  { key: "inactive", label: "customers.suppliers.list.filterInactive" },
  { key: "all", label: "customers.suppliers.list.filterAll" },
];

export function SuppliersList({ selectedId }: { selectedId: string | null }) {
  const { t } = useI18n();
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<SupplierListRow[]>([]);
  // The whole list's size (from the server), not the length of the loaded page.
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [query, setQuery] = useEntryState("query", "");
  const [status, setStatus] = useEntryState<SupplierStatusFilter>("status", "active");
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
        setMoreError(null);
        const page = await getSuppliersPage({ query: q, status: st });
        setSuppliers(page.suppliers);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        setError(
          err instanceof Error ? err.message : t("customers.suppliers.list.errorLoad")
        );
      } finally {
        setLoading(false);
      }
    },
    [t]
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

  // The next page, appended. A failure here keeps every row already shown and
  // offers a retry; it never replaces the list with an error.
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    try {
      setLoadingMore(true);
      setMoreError(null);
      const page = await getSuppliersPage({ query, status, offset: suppliers.length });
      setSuppliers((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return prev.concat(page.suppliers.filter((s) => !seen.has(s.id)));
      });
      setTotal(page.total);
      setHasMore(page.hasMore);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setMoreError(t("customers.suppliers.list.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, query, status, suppliers.length, t]);

  const isSearching = query.trim().length > 0;

  return (
    <div className="crm-page">
      {/* Phone / tablet: back to the screen the list was opened from (Tools,
          the order center…), shown only when that origin is verified. Hidden
          in the ≥1280 two-pane workspace by .crm-scope .crm-hd__back. */}
      <div className="crm-hd__back">
        <BackButton hideWithoutOrigin />
      </div>
      <div className="crm-hd">
        <div>
          <h1 className="crm-hd__title">{t("customers.suppliers.list.title")}</h1>
          {!loading && !error ? (
            <div className="crm-hd__sub">
              {total === 1
                ? t("customers.suppliers.list.countOne", { count: total })
                : t("customers.suppliers.list.countMany", { count: total })}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="crm-btn crm-btn--primary"
          onClick={() => setCreateOpen(true)}
        >
          {t("customers.suppliers.list.newSupplier")}
        </button>
      </div>

      <input
        className="crm-search"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("customers.suppliers.list.searchPlaceholder")}
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
              {t(f.label)}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">{t("customers.suppliers.common.errorTitle")}</p>
          <p className="crm-panel__body">{error}</p>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={() => void load(query, status)}
          >
            {t("customers.suppliers.common.retry")}
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
              ? t("customers.suppliers.list.emptySearchTitle")
              : status === "inactive"
                ? t("customers.suppliers.list.emptyInactiveTitle")
                : t("customers.suppliers.list.emptyNoneTitle")}
          </p>
          <p className="crm-panel__body">
            {isSearching
              ? t("customers.suppliers.list.emptySearchBody")
              : status === "inactive"
                ? t("customers.suppliers.list.emptyInactiveBody")
                : t("customers.suppliers.list.emptyNoneBody")}
          </p>
          {!isSearching && status !== "inactive" ? (
            <button
              type="button"
              className="crm-btn crm-btn--primary"
              onClick={() => setCreateOpen(true)}
            >
              {t("customers.suppliers.list.newSupplier")}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="crm-rows">
          {suppliers.map((s) => {
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
                    <bdi>{s.name}</bdi>
                  </span>
                  {/* Sibling of the name: the name is clamped to two lines, and
                      a badge inside it would be clipped on long names. */}
                  {!s.isActive ? (
                    <span className="crm-row__badges">
                      <span className="crm-badge">{t("customers.suppliers.common.inactiveBadge")}</span>
                    </span>
                  ) : null}
                  <CrmRowMeta parts={rowMetaParts(s)} />
                </span>
                <span className="crm-row__chevron" aria-hidden>
                  {t("customers.suppliers.common.chevron")}
                </span>
              </a>
            );
          })}
          {hasMore || moreError ? (
            <div className="crm-list-more" aria-live="polite">
              <p className="crm-list-more__note">
                {t("customers.suppliers.list.showing", { shown: suppliers.length, total })}
              </p>
              {moreError ? <p className="crm-list-more__error" role="alert">{moreError}</p> : null}
              <button
                type="button"
                className="crm-btn crm-btn--ghost crm-btn--full"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore
                  ? t("customers.suppliers.history.loading")
                  : moreError
                    ? t("customers.suppliers.common.retry")
                    : t("customers.suppliers.list.loadMore")}
              </button>
            </div>
          ) : null}
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
  const { t } = useI18n();
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
    const invalid = validateSupplierForm(form, t);
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
      setError(err instanceof Error ? err.message : t("customers.suppliers.create.errorCreate"));
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={t("customers.suppliers.create.title")}>
        <h2 className="crm-modal__title">{t("customers.suppliers.create.title")}</h2>
        <p className="crm-panel__body" style={{ marginTop: -4 }}>
          {t("customers.suppliers.create.intro")}
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
            {saving ? t("customers.suppliers.common.saving") : t("customers.suppliers.common.save")}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("customers.suppliers.common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
