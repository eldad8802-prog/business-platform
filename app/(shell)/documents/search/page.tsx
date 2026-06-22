"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import { TOKEN } from "@/lib/design/tokens";

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

function formatAmount(value: number, direction: string): string {
  const sign = direction === "income" ? "+" : direction === "expense" ? "-" : "";
  return `${sign}₪${value.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

function formatDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("he-IL", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
}

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthLabel(): string {
  return new Date().toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function DocumentsSearchPage() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [results, setResults] = useState<SearchResult[]>([]);
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
      setError(errorMessage(err, "שגיאה בחיפוש"));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [authHeader, filter, query]);

  useEffect(() => {
    if (!mounted || !authHeader) return;
    const id = window.setTimeout(() => void fetchResults(), 180);
    return () => window.clearTimeout(id);
  }, [authHeader, fetchResults, mounted]);

  const filters = useMemo(
    () =>
      [
        { key: "all" as const, label: "הכל" },
        { key: "month" as const, label: currentMonthLabel() },
        { key: "fuel" as const, label: "דלק" },
        { key: "income" as const, label: "הכנסה" },
        { key: "expense" as const, label: "הוצאה" },
      ] as const,
    []
  );

  if (!mounted || !authHeader) {
    return (
      <div dir="rtl" style={pageStyle}>
        <main style={mainStyle}>
          <Header onBack={() => router.push("/documents")} />
          <div style={emptyStyle}>טוען...</div>
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl" style={pageStyle}>
      <main style={mainStyle}>
        <Header onBack={() => router.push("/documents")} />

        <label style={searchStyle}>
          <SearchIcon />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="חיפוש לפי ספק או טקסט חופשי"
            aria-label="חיפוש מסמכים"
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
            ? "טוען תוצאות..."
            : `${results.length.toLocaleString("he-IL")} תוצאות · רשומות מאושרות בלבד`}
        </div>

        {error ? <div style={errorStyle}>{error}</div> : null}

        {!loading && !error && results.length === 0 ? (
          <section style={emptyStyle}>לא נמצאו מסמכים מאושרים לתצוגה.</section>
        ) : null}

        <section style={resultsStyle}>
          {results.map((item) => (
            <SearchRow key={item.id} item={item} />
          ))}
        </section>
      </main>
    </div>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <header style={headStyle}>
      <button type="button" onClick={onBack} style={backButtonStyle} aria-label="חזרה">
        <BackChevronIcon />
        חזרה
      </button>
      <h1 style={titleStyle}>חיפוש מסמכים</h1>
      <div aria-hidden style={{ width: 52 }} />
    </header>
  );
}

function SearchRow({ item }: { item: SearchResult }) {
  const category = CATEGORY_MAP[item.category] || item.category || "כללי";
  const isIncome = item.direction === "income";

  return (
    <article style={rowStyle}>
      <div style={thumbStyle} aria-hidden>
        {item.document?.mimeType?.includes("image") ? <ImageIcon /> : <FileTextIcon />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={vendorStyle}>{item.vendorName || "ללא ספק"}</div>
        <div style={metaStyle}>
          {formatDate(item.date)}
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
          {formatAmount(item.amount, item.direction)}
        </div>
        <span style={approvedPillStyle}>אומת</span>
      </div>
    </article>
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

function BackChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
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

const mainStyle = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "14px 14px 40px",
  boxSizing: "border-box",
} as const;

const headStyle = {
  display: "grid",
  gridTemplateColumns: "52px 1fr 52px",
  alignItems: "center",
  gap: 10,
  marginBottom: 14,
} as const;

const backButtonStyle = {
  width: 40,
  height: 40,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.button,
  background: TOKEN.surface.card,
  color: TOKEN.brand.mid,
  fontSize: 0,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
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
  minHeight: 36,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.pill,
  background: TOKEN.surface.card,
  color: TOKEN.ink.secondary,
  padding: "0 12px",
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  cursor: "pointer",
} as const;

const chipActiveStyle = {
  ...chipStyle,
  border: `1px solid ${TOKEN.brand.softBorder}`,
  background: TOKEN.brand.gradient,
  color: TOKEN.ink.inverse,
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
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 12,
  display: "flex",
  alignItems: "center",
  gap: 12,
} as const;

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
