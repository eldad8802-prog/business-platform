"use client";
import { PageContainer } from "@/components/ui/page-container";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEntryState } from "@/hooks/useEntryState";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n/I18nProvider";
import { DEFAULT_LOCALE, intlTag, type Locale } from "@/lib/i18n/config";
import { formatNumber } from "@/lib/i18n/format";
import type { Translator } from "@/lib/i18n/translate";
import { categoryLabel } from "@/lib/documents/category-label";
import { TOKEN } from "@/lib/design/documents-theme";
import { chipActionStyle } from "@/lib/design/documents-theme";
import DocumentsBackButton from "@/components/documents/DocumentsBackButton";

type SearchResultDocument = {
  status?: string | null;
  mimeType?: string | null;
  source?: string | null;
  createdAt?: string | null;
};

type SearchResult = {
  id: number;
  documentId: number;
  vendorName: string;
  category: string;
  amount: number;
  date: string;
  direction: string;
  document?: SearchResultDocument | null;
};

type FilterKey = "all" | "month" | "fuel" | "income" | "expense";

function formatAmount(value: number, direction: string, locale: Locale = DEFAULT_LOCALE): string {
  const sign = direction === "income" ? "+" : direction === "expense" ? "-" : "";
  if (locale !== "he") {
    return `${sign}${new Intl.NumberFormat(intlTag(locale), {
      style: "currency",
      currency: "ILS",
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 2,
    }).format(value)}`;
  }
  return `${sign}₪${value.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

function formatDate(raw: string | null | undefined, locale: Locale = DEFAULT_LOCALE): string {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
}

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthLabel(locale: Locale = DEFAULT_LOCALE): string {
  return new Date().toLocaleDateString(intlTag(locale), {
    month: "long",
    year: "numeric",
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function categoryText(t: Translator, raw: string): string {
  return categoryLabel(t, raw) || t("documents.common.general");
}

export default function DocumentsSearchPage() {
  const router = useRouter();
  const { t, locale, fmt } = useI18n();
  const [mounted, setMounted] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [query, setQuery] = useEntryState("query", "");
  const [filter, setFilter] = useEntryState<FilterKey>("filter", "all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => {
      setMounted(true);
      const token = window.localStorage.getItem("token");
      if (!token) {
        router.replace("/login");
        return;
      }
      setAuthHeader(`Bearer ${token}`);
    });
  }, [router]);

  const fetchResults = useCallback(async () => {
    if (!authHeader) return;
    const url = new URL("/api/search", window.location.origin);
    if (query.trim()) url.searchParams.set("q", query.trim());
    if (filter === "month") url.searchParams.set("month", currentMonthValue());
    if (filter === "fuel") url.searchParams.set("category", "fuel");
    if (filter === "income" || filter === "expense") {
      url.searchParams.set("direction", filter);
    }
    url.searchParams.set("limit", "30");

    try {
      setLoading(true);
      setError("");
      const response = await fetch(url.pathname + url.search, {
        headers: { Authorization: authHeader },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Search failed");
      const items = Array.isArray(data.results) ? (data.results as SearchResult[]) : [];
      setResults(items.filter((item) => item.document?.status === "approved"));
    } catch (err) {
      setError(errorMessage(err, t("documents.search.error")));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [authHeader, filter, query, t]);

  useEffect(() => {
    if (!mounted || !authHeader) return;
    const id = window.setTimeout(() => void fetchResults(), 180);
    return () => window.clearTimeout(id);
  }, [authHeader, fetchResults, mounted]);

  const filters = useMemo(
    () =>
      [
        { key: "all" as const, label: t("documents.search.all") },
        { key: "month" as const, label: currentMonthLabel(locale) },
        { key: "fuel" as const, label: t("documents.categories.fuel") },
        { key: "income" as const, label: t("documents.common.income") },
        { key: "expense" as const, label: t("documents.common.expense") },
      ] as const,
    [t, locale]
  );

  if (!mounted || !authHeader) {
    return (
      <div style={pageStyle}>
        <PageContainer intent="data" className="dz-search-page" style={{ paddingBlock: "14px 40px" }}>          <Header />
          <div style={emptyStyle}>{t("documents.search.loading")}</div>
        </PageContainer>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <PageContainer intent="data" className="dz-search-page" style={{ paddingBlock: "14px 40px" }}>        <Header />

        <label style={searchStyle}>
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("documents.search.placeholder")}
            aria-label={t("documents.search.aria")}
            style={searchInputStyle}
          />
        </label>

        <div style={filtersStyle}>
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              style={filter === item.key ? chipActiveStyle : chipStyle}
              aria-pressed={filter === item.key}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div style={countStyle}>
          {loading
            ? t("documents.search.loadingResults")
            : t("documents.search.resultsCount", { count: formatNumber(results.length, fmt) })}
        </div>

        {error ? <div style={errorStyle}>{error}</div> : null}

        <div className="dz-search-desk">
        <div>
        {!loading && !error && results.length === 0 ? (
          <section style={emptyStyle}>{t("documents.search.empty")}</section>
        ) : null}

        <section className="dz-search-cards" style={resultsStyle}>
          {results.map((item) => (
            <SearchRow
              key={item.id}
              item={item}
              onOpen={
                Number.isFinite(item.documentId)
                  ? () => router.push(`/documents/review/${item.documentId}`)
                  : undefined
              }
            />
          ))}
        </section>

        <section className="dz-search-table" aria-label={t("documents.search.tableAria")}>
          <table>
            <thead>
              <tr>
                <th>{t("documents.review.fields.vendor")}</th>
                <th>{t("documents.review.fields.date")}</th>
                <th>{t("documents.review.fields.category")}</th>
                <th>{t("documents.review.fields.amount")}</th>
                <th>{t("documents.search.status")}</th>
              </tr>
            </thead>
            <tbody>
              {results.map((item) => {
                const category = categoryText(t, item.category);
                return (
                  <tr
                    key={item.id}
                    className={item.id === selectedId ? "is-selected" : undefined}
                    onClick={() => setSelectedId(item.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>{item.vendorName || t("documents.search.noVendor")}</td>
                    <td>{formatDate(item.date, locale)}</td>
                    <td>{category}</td>
                    <td>{formatAmount(item.amount, item.direction, locale)}</td>
                    <td>{t("documents.search.verified")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        </div>
        <aside className="dz-search-inspector" aria-label={t("documents.search.inspectorAria")}>
          <SearchInspector
            item={results.find((item) => item.id === selectedId) ?? null}
            onOpen={
              results.some((item) => item.id === selectedId && Number.isFinite(item.documentId))
                ? () => {
                    const item = results.find((row) => row.id === selectedId);
                    if (item) router.push(`/documents/review/${item.documentId}`);
                  }
                : undefined
            }
          />
        </aside>
        </div>
      </PageContainer>    </div>
  );
}

function SearchInspector({
  item,
  onOpen,
}: {
  item: SearchResult | null;
  onOpen?: () => void;
}) {
  const { t, locale } = useI18n();
  if (!item) {
    return <p>{t("documents.search.inspectorHint")}</p>;
  }
  const category = categoryText(t, item.category);
  return (
    <>
      <h2>{item.vendorName || t("documents.search.noVendor")}</h2>
      <dl>
        <dt>{t("documents.review.fields.date")}</dt>
        <dd>{formatDate(item.date, locale) || "—"}</dd>
        <dt>{t("documents.review.fields.category")}</dt>
        <dd>{category}</dd>
        <dt>{t("documents.review.fields.amount")}</dt>
        <dd>{formatAmount(item.amount, item.direction, locale)}</dd>
        <dt>{t("documents.review.fields.direction")}</dt>
        <dd>
          {item.direction === "income"
            ? t("documents.common.income")
            : item.direction === "expense"
              ? t("documents.common.expense")
              : item.direction || "—"}
        </dd>
        <dt>{t("documents.search.status")}</dt>
        <dd>{t("documents.search.verified")}</dd>
      </dl>
      {onOpen ? (
        <button type="button" onClick={onOpen}>
          {t("documents.search.openDocument")}
        </button>
      ) : null}
    </>
  );
}

function Header() {
  const { t } = useI18n();
  return (
    <header style={headStyle}>
      <DocumentsBackButton />
      <h1 style={titleStyle}>{t("documents.search.title")}</h1>
      <div aria-hidden style={{ width: 52 }} />
    </header>
  );
}

function SearchRow({ item, onOpen }: { item: SearchResult; onOpen?: () => void }) {
  const { t, locale } = useI18n();
  const category = categoryText(t, item.category);
  const isIncome = item.direction === "income";

  const content = (
    <>
      <div style={thumbStyle} aria-hidden>
        {item.document?.mimeType?.includes("image") ? <ImageIcon /> : <FileTextIcon />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={vendorStyle}>{item.vendorName || t("documents.search.noVendor")}</div>
        <div style={metaStyle}>
          {formatDate(item.date, locale)}
          {category ? ` · ${category}` : ""}
        </div>
      </div>
      <div style={trailStyle}>
        <div
          style={{
            ...amountStyle,
            color: isIncome ? TOKEN.semantic.success.ink : TOKEN.semantic.urgent.ink,
          }}
        >
          {formatAmount(item.amount, item.direction, locale)}
        </div>
        <span style={approvedPillStyle}>{t("documents.search.verified")}</span>
      </div>
    </>
  );

  // Without a valid documentId there is nowhere to open, so render a
  // non-interactive row rather than link to /documents/review/undefined.
  if (!onOpen) {
    return <div style={rowStaticStyle}>{content}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      style={rowStyle}
      aria-label={t("documents.search.openDocumentAria", { vendor: item.vendorName || t("documents.search.noVendor") })}
    >
      {content}
    </button>
  );
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke={TOKEN.ink.muted} strokeWidth="1.9" fill="none" />
      <path d="m20 20-3.5-3.5" stroke={TOKEN.ink.muted} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function FileTextIcon() {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="none" />
      <path d="M14 3v5h5M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="5" width="16" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="m7 16 3.5-3.5 2.5 2.5 2-2 2 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" />
    </svg>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
} as const;


const headStyle = {
  display: "grid",
  gridTemplateColumns: "auto 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 14,
} as const;

const titleStyle = {
  margin: 0,
  textAlign: "center",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.display,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.25,
} as const;

const searchStyle = {
  minHeight: 52,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 14px",
} as const;

const searchInputStyle = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
} as const;

const filtersStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 12,
} as const;

const chipStyle = {
  ...chipActionStyle(false),
  minHeight: 36,
  padding: "0 12px",
  fontSize: TOKEN.font.body,
} as const;

const chipActiveStyle = {
  ...chipActionStyle(true),
  minHeight: 36,
  padding: "0 12px",
  fontSize: TOKEN.font.body,
} as const;

const countStyle = {
  paddingTop: 12,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
} as const;

const resultsStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  paddingTop: 10,
} as const;

const rowStyle = {
  minHeight: 82,
  width: "100%",
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 12,
  display: "flex",
  alignItems: "center",
  gap: 12,
  font: "inherit",
  color: "inherit",
  textAlign: "start",
  cursor: "pointer",
} as const;

// Same visual row, but non-interactive (used when a result has no documentId).
const rowStaticStyle = { ...rowStyle, cursor: "default" } as const;

const thumbStyle = {
  width: 48,
  height: 58,
  borderRadius: TOKEN.radius.input,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  background: TOKEN.surface.inset,
  color: TOKEN.ink.secondary,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: TOKEN.font.caption,
  fontWeight: TOKEN.weight.bold,
  flexShrink: 0,
} as const;

const vendorStyle = {
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const metaStyle = {
  marginTop: 4,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
} as const;

const trailStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 6,
  flexShrink: 0,
} as const;

const amountStyle = {
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const approvedPillStyle = {
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.semantic.success.bgSoft,
  border: `1px solid ${TOKEN.semantic.success.border}`,
  color: TOKEN.semantic.success.ink,
  padding: "3px 9px",
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
} as const;

const emptyStyle = {
  marginTop: 14,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: TOKEN.space.lg,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  textAlign: "center",
} as const;

const errorStyle = {
  ...emptyStyle,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
} as const;
