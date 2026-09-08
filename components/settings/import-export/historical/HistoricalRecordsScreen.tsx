"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SettingsSection } from "@/components/settings/SettingsSection";
import {
  EXTERNAL_ORIGIN_BADGE,
  EXTERNAL_ORIGIN_EXPLANATION,
  documentTypeLabel,
  failureText,
} from "@/lib/data-transfer/historical/historical-owner-language";

/**
 * הגדרות → ייבוא וייצוא → היסטוריה ממערכת קודמת → המסמכים שנקלטו.
 *
 * # Read-only is a property of what exists, not of what is hidden
 *
 * There is no edit control on this screen because there is no endpoint behind
 * one. The historical table has no UPDATE policy and no UPDATE grant, the read
 * service performs no write, and the two routes it calls are GET. A disabled
 * "edit" button would imply the capability exists and is merely switched off;
 * nothing here implies that.
 *
 * Equally absent, and for the same reason: send, reissue, cancel, credit
 * through Dubiz, allocate a payment, submit to the tax authority, renumber, or
 * produce a Dubiz PDF. None of those mean anything for a document another
 * system issued, and offering one would be the first step of exactly the merge
 * the historical model exists to prevent.
 *
 * # The badge is load-bearing
 *
 * Every record carries "יובא ממערכת אחרת". An owner scrolling a list of
 * invoices must not be able to conclude that Dubiz issued one of them — the
 * counterpart wording for a Dubiz document is "הופק בדוביז", and the two are
 * deliberately different sentences rather than one sentence with a flag.
 *
 * # Paging
 *
 * Server-backed and deterministic: the service orders by issue date and then by
 * primary key, so page 2 cannot repeat or drop a row. This screen sends a page
 * number and renders what comes back; it never accumulates pages client-side,
 * which is how a filtered list ends up showing rows that no longer match.
 */

type RecordItem = {
  id: number;
  documentTypeCode: string;
  originalDocumentNumber: string | null;
  originalIssueDate: string | null;
  totalAmount: string | null;
  currency: string | null;
  customerNameSnapshot: string | null;
  sourceSystemCode: string;
  sourceSystemNameRaw: string | null;
  reversesLinked: boolean;
  reversesOriginalNumberRaw: string | null;
};

type Page = {
  items: RecordItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  sourceSystems: string[];
  emptyHistory: boolean;
};

type Filters = {
  type: string;
  source: string;
  number: string;
  from: string;
  to: string;
};

const NO_FILTERS: Filters = { type: "", source: "", number: "", from: "", to: "" };

/** What one fetch produced. Returned rather than written, see `fetchPage`. */
type Outcome =
  | { kind: "page"; value: Page }
  | { kind: "error"; message: string };

type Props = {
  /** The four types, as code + label, derived server-side from the vocabulary. */
  documentTypes: readonly { code: string; label: string }[];
  importHref: string;
  /** Base path a record id is appended to. A STRING, not a function: a server
   * component cannot hand a client component a callback. */
  recordsBase: string;
};

function authHeader(): Record<string, string> | null {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("token") : null;
  return token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : null;
}

/** `2024-03-17` as `17/03/2024`. The stored value is a calendar day. */
function formatDay(day: string | null): string | null {
  if (!day) return null;
  const [y, m, d] = day.split("-");
  return y && m && d ? `${d}/${m}/${y}` : day;
}

function formatMoney(amount: string | null, currency: string | null): string | null {
  if (amount === null) return null;
  const number = Number(amount);
  const text = Number.isFinite(number)
    ? number.toLocaleString("he-IL", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : amount;
  return currency === "ILS" ? `${text} ₪` : currency ? `${text} ${currency}` : text;
}

export function HistoricalRecordsScreen({
  documentTypes,
  importHref,
  recordsBase,
}: Props) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // What the CURRENT result was fetched with, so the controls can be edited
  // without the list changing underneath the owner mid-typing.
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumped by every deliberate request.
   *
   * Without it, pressing "סננו" without having changed anything sets no state
   * React considers new — `applied` is handed the same object it already holds —
   * so the effect never re-runs and the screen sits on its loading skeleton
   * forever. A counter makes "the owner asked again" a fact of its own.
   */
  const [attempt, setAttempt] = useState(0);

  /**
   * Fetch one page and RETURN what happened.
   *
   * It sets no state at all. State moves in `applyOutcome`, which runs from the
   * promise callback — an effect body that updates state synchronously causes a
   * cascading render, and the fetch is an external system being read rather than
   * state being synchronized.
   *
   * "Not signed in" is not pre-checked either. The server answers 401 and that
   * answer is handled with every other one, which keeps the authority in one
   * place instead of guessing at it twice.
   */
  const fetchPage = useCallback(
    async (requested: number, active: Filters): Promise<Outcome> => {
      try {
        const params = new URLSearchParams();
        params.set("page", String(requested));
        if (active.type) params.set("type", active.type);
        if (active.source) params.set("source", active.source);
        if (active.number) params.set("number", active.number);
        if (active.from) params.set("from", active.from);
        if (active.to) params.set("to", active.to);

        const response = await fetch(
          `/api/data-transfer/historical/records?${params.toString()}`,
          { headers: authHeader() ?? {} }
        );
        const body = await response.json().catch(() => null);

        if (response.status === 401) {
          return { kind: "error", message: "צריך להתחבר מחדש כדי להמשיך." };
        }
        if (!response.ok || !body?.ok) {
          return {
            kind: "error",
            message: failureText(body?.code, body?.message ?? body?.error),
          };
        }
        return { kind: "page", value: body as Page };
      } catch {
        return { kind: "error", message: "שגיאת רשת — בדקו את החיבור ונסו שוב." };
      }
    },
    []
  );

  function applyOutcome(outcome: Outcome) {
    setLoading(false);
    if (outcome.kind === "error") {
      setError(outcome.message);
      return;
    }
    setError(null);
    setData(outcome.value);
  }

  useEffect(() => {
    // Cancellation is not decoration: a slow first page must not land on top of
    // the second page the owner has already asked for.
    let cancelled = false;
    void fetchPage(page, applied).then((outcome) => {
      if (!cancelled) applyOutcome(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPage, page, applied, attempt]);

  function request() {
    setLoading(true);
    setAttempt((n) => n + 1);
  }

  function apply() {
    setApplied(filters);
    setPage(1);
    request();
  }

  function clear() {
    setFilters(NO_FILTERS);
    setApplied(NO_FILTERS);
    setPage(1);
    request();
  }

  function goToPage(next: number) {
    setPage(next);
    request();
  }

  const retry = request;

  const filtered =
    applied.type !== "" ||
    applied.source !== "" ||
    applied.number !== "" ||
    applied.from !== "" ||
    applied.to !== "";

  return (
    <>
      <SettingsSection>
        <p className="text-sm font-bold text-[var(--dz-text-primary)]">
          {EXTERNAL_ORIGIN_BADGE}
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          {EXTERNAL_ORIGIN_EXPLANATION}
        </p>
        <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
          המסמכים כאן נשמרים לצפייה בלבד ואי אפשר לערוך אותם.
        </p>
      </SettingsSection>

      {/* Filters */}
      <div className="mt-4">
        <SettingsSection title="סינון">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="block text-xs font-semibold text-[var(--dz-text-primary)]">
                סוג מסמך
              </span>
              <select
                value={filters.type}
                onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 text-sm text-[var(--dz-text-primary)]"
              >
                <option value="">הכול</option>
                {documentTypes.map((type) => (
                  <option key={type.code} value={type.code}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-[var(--dz-text-primary)]">
                מערכת מקור
              </span>
              <select
                value={filters.source}
                onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 text-sm text-[var(--dz-text-primary)]"
              >
                <option value="">הכול</option>
                {(data?.sourceSystems ?? []).map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </label>

            <label className="block sm:col-span-2">
              <span className="block text-xs font-semibold text-[var(--dz-text-primary)]">
                מספר מסמך מקורי
              </span>
              <input
                type="search"
                inputMode="search"
                value={filters.number}
                maxLength={64}
                onChange={(e) => setFilters((f) => ({ ...f, number: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") apply();
                }}
                placeholder="חלק מהמספר מספיק"
                className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 text-sm text-[var(--dz-text-primary)]"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-[var(--dz-text-primary)]">
                מתאריך
              </span>
              <input
                type="date"
                value={filters.from}
                onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 text-sm text-[var(--dz-text-primary)]"
              />
            </label>

            <label className="block">
              <span className="block text-xs font-semibold text-[var(--dz-text-primary)]">
                עד תאריך
              </span>
              <input
                type="date"
                value={filters.to}
                onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
                className="mt-1 min-h-[44px] w-full rounded-xl border border-[var(--dz-border-subtle)] bg-[var(--dz-background)] px-3 text-sm text-[var(--dz-text-primary)]"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={loading}
              className="min-h-[44px] flex-1 rounded-2xl bg-[var(--dz-accent)] px-4 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            >
              סננו
            </button>
            {filtered ? (
              <button
                type="button"
                onClick={clear}
                disabled={loading}
                className="min-h-[44px] rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-sm font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:opacity-60"
              >
                נקו סינון
              </button>
            ) : null}
          </div>
        </SettingsSection>
      </div>

      {/* The list */}
      <div className="mt-4">
        <SettingsSection
          title="המסמכים ההיסטוריים"
          description={
            data && !loading
              ? `${data.total.toLocaleString("he-IL")} מסמכים${filtered ? " מתאימים לסינון" : ""}`
              : undefined
          }
        >
          {loading ? (
            <ul className="flex flex-col gap-2" aria-label="טוען מסמכים">
              {[0, 1, 2].map((i) => (
                <li
                  key={i}
                  className="h-20 animate-pulse rounded-2xl bg-[var(--dz-background)]"
                />
              ))}
            </ul>
          ) : error ? (
            <div className="rounded-2xl bg-[var(--dz-background)] px-4 py-3">
              <p className="text-xs font-semibold leading-5 text-[var(--dz-danger,#b3261e)]">
                {error}
              </p>
              <button
                type="button"
                onClick={retry}
                className="mt-2 min-h-[44px] rounded-full border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
              >
                נסו שוב
              </button>
            </div>
          ) : data && data.emptyHistory ? (
            <div className="rounded-2xl bg-[var(--dz-background)] px-4 py-5 text-center">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">
                עדיין לא נקלטו מסמכים היסטוריים.
              </p>
              <p className="mt-2 text-xs leading-5 text-[var(--dz-text-muted)]">
                כאן יופיעו המסמכים שהפקתם במערכת הקודמת שלכם, אחרי שתעלו אותם.
              </p>
              <Link
                href={importHref}
                className="mt-3 inline-flex min-h-[44px] items-center rounded-2xl bg-[var(--dz-accent)] px-4 text-sm font-bold text-white transition"
              >
                להעלאת מסמכים מהמערכת הקודמת
              </Link>
            </div>
          ) : data && data.items.length === 0 ? (
            <div className="rounded-2xl bg-[var(--dz-background)] px-4 py-5 text-center">
              <p className="text-sm font-bold text-[var(--dz-text-primary)]">
                אין מסמכים שמתאימים לסינון.
              </p>
              <button
                type="button"
                onClick={clear}
                className="mt-3 min-h-[44px] rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-sm font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)]"
              >
                נקו סינון
              </button>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--dz-border-subtle)]">
              {(data?.items ?? []).map((item) => {
                const money = formatMoney(item.totalAmount, item.currency);
                const day = formatDay(item.originalIssueDate);
                return (
                  <li key={item.id}>
                    <Link
                      href={`${recordsBase}/${item.id}`}
                      className="flex min-h-[44px] w-full items-start gap-3 rounded-2xl border border-transparent px-2 py-3 text-right transition hover:border-[var(--dz-border-subtle)] hover:bg-[var(--dz-surface-muted)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-[var(--dz-text-primary)]">
                            {documentTypeLabel(item.documentTypeCode)}
                          </span>
                          <span className="rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
                            {EXTERNAL_ORIGIN_BADGE}
                          </span>
                        </span>
                        <span className="mt-1 block break-words text-xs text-[var(--dz-text-muted)]">
                          {[item.originalDocumentNumber, day, money]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        {item.customerNameSnapshot ? (
                          <span className="mt-0.5 block break-words text-xs text-[var(--dz-text-muted)]">
                            {item.customerNameSnapshot}
                          </span>
                        ) : null}
                        <span className="mt-0.5 block break-words text-[11px] text-[var(--dz-text-muted)]">
                          {item.sourceSystemNameRaw || item.sourceSystemCode}
                        </span>
                      </span>
                      <span
                        className="shrink-0 self-center text-lg text-[var(--dz-text-muted)]"
                        aria-hidden
                      >
                        ←
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          {data && !loading && !error && data.totalPages > 1 ? (
            <nav
              aria-label="עמודים"
              className="mt-4 flex items-center justify-between gap-2"
            >
              <button
                type="button"
                onClick={() => goToPage(Math.max(1, data.page - 1))}
                disabled={data.page <= 1}
                className="min-h-[44px] rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                הקודם
              </button>
              <span className="text-xs text-[var(--dz-text-muted)]">
                עמוד {data.page.toLocaleString("he-IL")} מתוך{" "}
                {data.totalPages.toLocaleString("he-IL")}
              </span>
              <button
                type="button"
                onClick={() => goToPage(data.page + 1)}
                disabled={!data.hasMore}
                className="min-h-[44px] rounded-2xl border border-[var(--dz-border-subtle)] px-4 text-xs font-semibold text-[var(--dz-text-primary)] transition hover:bg-[var(--dz-surface-muted)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                הבא
              </button>
            </nav>
          ) : null}
        </SettingsSection>
      </div>
    </>
  );
}
