"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { Translator } from "@/lib/i18n/translate";
import { categoryLabel as categoryDisplayLabel } from "@/lib/documents/category-label";

/**
 * /search — financial-record search.
 *
 * The only search API (`GET /api/search`) matches vendor name and category on
 * financial records. Customers, inventory, obligations, and settings are not
 * in that index, so this screen does not pretend they are.
 */

type SearchDocument = { status?: string | null };
type SearchResult = {
  id: number;
  documentId?: number | null;
  vendorName?: string | null;
  category?: string | null;
  amount?: number | string | null;
  date?: string | null;
  direction?: string | null;
  document?: SearchDocument | null;
};

type DirectionFilter = "all" | "income" | "expense";

function categoryLabel(t: Translator, value: string | null | undefined): string {
  if (!value) return t("documents.globalSearch.noCategory");
  return categoryDisplayLabel(t, value);
}

function directionLabel(t: Translator, value: string | null | undefined): string {
  if (value === "income") return t("documents.common.income");
  if (value === "expense") return t("documents.common.expense");
  return "";
}

function statusLabel(t: Translator, value: string | null | undefined): string {
  if (value === "approved") return t("documents.globalSearch.statusApproved");
  if (value === "needs_review") return t("documents.globalSearch.statusNeedsReview");
  return "";
}

/** Hebrew: identical to the previous `₪` + he-IL formatter. */
function formatAmount(value: number | string | null | undefined, locale: Locale): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  if (locale !== "he") {
    return new Intl.NumberFormat(intlTag(locale), {
      style: "currency",
      currency: "ILS",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 2,
    }).format(n);
  }
  return `₪${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

function formatDate(raw: string | null | undefined, locale: Locale): string {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(intlTag(locale));
}

export default function SearchPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useEntryState("query", "");
  const [direction, setDirection] = useEntryState<DirectionFilter>("direction", "all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const id = window.setTimeout(() => {
      // `/search?q=` — the Home search field hands its query over on arrival.
      const initial = new URLSearchParams(window.location.search).get("q")?.trim();
      if (initial) setQuery(initial);
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const token = window.localStorage.getItem("token");
    const handle = window.setTimeout(() => {
      if (!token) {
        setStatus("error");
        return;
      }
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      params.set("limit", "40");
      fetch(`/api/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data: { results?: SearchResult[] }) => {
          setResults(Array.isArray(data.results) ? data.results : []);
          setActive(0);
          setStatus("ready");
        })
        .catch(() => setStatus("error"));
    }, 180);
    return () => window.clearTimeout(handle);
  }, [query]);

  const shown = useMemo(
    () => (direction === "all" ? results : results.filter((row) => row.direction === direction)),
    [results, direction],
  );
  const current = shown[active] ?? null;
  const groups = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    for (const row of shown) {
      const key = categoryLabel(t, row.category);
      const list = map.get(key) ?? [];
      list.push(row);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [shown, t]);

  function openResult(row: SearchResult | null) {
    if (!row || !Number.isFinite(row.documentId)) return;
    router.push(`/documents/review/${row.documentId}`);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (shown.length === 0) {
      if (event.key === "Escape") {
        setQuery("");
        inputRef.current?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(shown.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openResult(current);
    } else if (event.key === "Escape") {
      setQuery("");
      setActive(0);
      inputRef.current?.focus();
    }
  }

  return (
    <main className="gsearch" data-page-intent="data" onKeyDown={onKeyDown}>
      <style>{SEARCH_CSS}</style>
      <header className="gsearch-head">
        <h1>{t("documents.globalSearch.title")}</h1>
        <p>{t("documents.globalSearch.intro")}</p>
      </header>
      <div className="gsearch-desk">
        <div className="gsearch-main">
          <label className="gsearch-field">
            <span className="sr">{t("documents.globalSearch.title")}</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("documents.globalSearch.placeholder")}
              aria-label={t("documents.globalSearch.aria")}
            />
          </label>
          <div className="gsearch-filters" role="group" aria-label={t("documents.globalSearch.directionAria")}>
            {(
              [
                ["all", t("documents.globalSearch.all")],
                ["income", t("documents.common.income")],
                ["expense", t("documents.common.expense")],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={direction === key}
                onClick={() => {
                  setDirection(key);
                  setActive(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {status === "loading" ? <p className="gsearch-note">{t("documents.globalSearch.searching")}</p> : null}
          {status === "error" ? <p className="gsearch-note">{t("documents.globalSearch.loadError")}</p> : null}
          {status === "ready" && shown.length === 0 ? (
            <p className="gsearch-note">
              {query.trim() ? t("documents.globalSearch.noMatch") : t("documents.globalSearch.noRecords")}
            </p>
          ) : null}
          {status === "ready" && shown.length > 0 ? (
            <div className="gsearch-groups">
              {groups.map(([label, rows]) => (
                <section key={label}>
                  <h2>{label}</h2>
                  <ul>
                    {rows.map((row) => {
                      const index = shown.indexOf(row);
                      return (
                        <li key={row.id}>
                          <button
                            type="button"
                            className={index === active ? "is-selected" : undefined}
                            onClick={() => setActive(index)}
                          >
                            <span>{row.vendorName || t("documents.globalSearch.noVendor")}</span>
                            <span>{formatAmount(row.amount, locale)}</span>
                            <span>{directionLabel(t, row.direction)}</span>
                            <span>{formatDate(row.date, locale)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : null}
        </div>
        <aside className="gsearch-side">
          {current ? (
            <>
              <h2>{current.vendorName || t("documents.globalSearch.noVendor")}</h2>
              <p>{categoryLabel(t, current.category)}</p>
              <p>
                {[formatAmount(current.amount, locale), directionLabel(t, current.direction), formatDate(current.date, locale)]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {statusLabel(t, current.document?.status) ? <p>{statusLabel(t, current.document?.status)}</p> : null}
              {Number.isFinite(current.documentId) ? (
                <button type="button" className="gsearch-open" onClick={() => openResult(current)}>
                  {t("documents.globalSearch.openDocument")}
                </button>
              ) : (
                <p>{t("documents.globalSearch.noDocument")}</p>
              )}
            </>
          ) : (
            <>
              <h2>{t("documents.globalSearch.record")}</h2>
              <p>{t("documents.globalSearch.hint")}</p>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}

const SEARCH_CSS = `
.gsearch{min-height:100%;background:#f8f6f1;padding:16px 16px 96px;box-sizing:border-box}
.gsearch-head h1{margin:0;font-size:24px;font-weight:800;color:#1f2a26}
.gsearch-head p{margin:6px 0 0;color:#5c675f;font-size:14px;line-height:1.5;max-width:42rem}
.gsearch-desk{display:grid;gap:14px;margin-top:16px}
.gsearch-side{display:none}
.gsearch-field input{width:100%;box-sizing:border-box;min-height:48px;border-radius:14px;border:1px solid rgba(52,60,50,.12);
  background:#fffdf8;padding:0 14px;font:inherit;font-size:16px;color:#1f2a26}
.gsearch-field input:focus{outline:3px solid #1f6f6b;outline-offset:2px}
.gsearch-filters{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.gsearch-filters button{min-height:36px;border-radius:999px;border:1px solid rgba(52,60,50,.12);background:transparent;
  font:inherit;font-size:13px;font-weight:700;padding:6px 14px;cursor:pointer;color:#3d4944}
.gsearch-filters button[aria-pressed="true"]{background:#fffdf8;border-color:#1f6f6b;color:#1f2a26}
.gsearch-note{color:#5c675f;font-size:14px;line-height:1.5}
.gsearch-groups{display:grid;gap:14px}
.gsearch-groups h2{margin:0 0 6px;font-size:13px;font-weight:800;color:#5c675f}
.gsearch-groups ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.gsearch-groups button{width:100%;text-align:start;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;
  min-height:48px;padding:10px 12px;border-radius:14px;border:1px solid rgba(52,60,50,.08);background:#fffdf8;
  font:inherit;color:#1f2a26;cursor:pointer}
.gsearch-groups button.is-selected{background:#e7efe9;border-color:#1f6f6b}
.gsearch-groups button span:nth-child(1){font-weight:800;overflow-wrap:anywhere}
.gsearch-groups button span:nth-child(2){font-variant-numeric:tabular-nums;font-weight:800}
.gsearch-groups button span:nth-child(3),.gsearch-groups button span:nth-child(4){font-size:12px;color:#5c675f}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (min-width:1200px){
  .gsearch{padding:24px 32px 48px}
  .gsearch-desk{grid-template-columns:minmax(0,1fr) minmax(280px,360px);align-items:start;gap:20px}
  .gsearch-side{display:grid;gap:8px;position:sticky;top:16px;align-content:start;background:#fffdf8;
    border:1px solid rgba(52,60,50,.08);border-radius:16px;padding:16px}
  .gsearch-side h2{margin:0;font-size:18px}
  .gsearch-side p{margin:0;color:#5c675f;font-size:14px;line-height:1.5;overflow-wrap:anywhere}
  .gsearch-open{margin-top:8px;min-height:40px;border:0;border-radius:12px;background:#1f6f6b;color:#fffdf8;
    font:inherit;font-weight:800;padding:8px 14px;cursor:pointer}
  .gsearch-groups button{grid-template-columns:minmax(0,1.4fr) auto auto auto}
}
@media (min-width:1600px){
  .gsearch-desk{grid-template-columns:minmax(0,1fr) minmax(320px,400px)}
}
`;
