"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  card,
  input,
  primaryBtn,
  emptyState,
  pageMain,
  alertError,
  cardTitle,
  cardSubText,
  iconWrap,
} from "../ui";
import { CATEGORIES, CATEGORY_MAP } from "@/lib/constants/categories";

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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type DirectionFilter = "all" | "income" | "expense";

const cardHeaderRow = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: 12,
  marginBottom: 12,
};

const pageShell = {
  minHeight: "100vh",
  background: "#f3f7ff",
};

const pageContent = {
  ...pageMain,
  maxWidth: 760,
};

const searchCard = {
  ...card,
  border: "1px solid #dfe7f3",
  borderRadius: 18,
  boxShadow: "0 10px 28px rgba(15, 23, 42, 0.06)",
};

const pageHeader = {
  background: "#ffffff",
  border: "1px solid #dfe7f3",
  borderRadius: 18,
  padding: "14px 16px",
  display: "flex" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
  gap: 12,
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.05)",
};

const headerIcon = {
  width: 34,
  height: 34,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#002b6b",
  display: "flex" as const,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  fontWeight: 950,
  flexShrink: 0,
};

const chipRow = {
  display: "flex" as const,
  flexWrap: "wrap" as const,
  gap: 8,
};

const chipBase = {
  padding: "9px 12px",
  borderRadius: 10,
  border: "1px solid #dfe7f3",
  background: "#ffffff",
  color: "#475569",
  fontSize: 13,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
};

const chipActive = {
  ...chipBase,
  background: "#002b6b",
  color: "#ffffff",
  // Override the full `border` shorthand instead of just `borderColor`.
  // Mixing `border` (shorthand from chipBase) with `borderColor` (longhand)
  // makes React 19 emit "Updating a style property during rerender ...
  // when a conflicting property is set" on every chip toggle, surfacing as
  // console errors when a user clicks the direction or category filters.
  border: "1px solid #002b6b",
  boxShadow: "0 6px 14px rgba(0, 43, 107, 0.16)",
};

// ── Layout polish tokens ───────────────────────────────────────────────────
// These are local to this screen. They do not modify any existing token in
// `app/(shell)/documents/ui.ts` and they do not change behavior — they only tighten
// the visual hierarchy of the filters area.

const searchRow = {
  display: "flex" as const,
  gap: 8,
  alignItems: "stretch" as const,
};

const searchInputInline = {
  ...input,
  marginTop: 0,
  flex: 1,
  minWidth: 0,
  border: "1px solid #dfe7f3",
  borderRadius: 10,
  background: "#ffffff",
};

const searchPrimaryBtnInline = (loading: boolean) => ({
  ...primaryBtn,
  marginTop: 0,
  width: "auto" as const,
  paddingInline: 22,
  minWidth: 96,
  minHeight: 48,
  borderRadius: 9,
  background: "#002b6b",
  whiteSpace: "nowrap" as const,
  opacity: loading ? 0.7 : 1,
  cursor: loading ? "not-allowed" : "pointer",
});

// Lightweight, text-style action used for the small "clear" actions beside
// each filter and for the global "נקה הכל" link. Kept intentionally low-key
// so it never competes with the primary "חפש" CTA.
const inlineLinkBtn = {
  background: "transparent",
  border: "none",
  color: "#002b6b",
  fontWeight: 900,
  fontSize: 13,
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline" as const,
  whiteSpace: "nowrap" as const,
};

const filterGroup = {
  marginTop: 14,
};

const filterLabel = {
  fontSize: 12,
  fontWeight: 900,
  color: "#64748b",
  textTransform: "none" as const,
  marginBottom: 8,
  display: "block" as const,
};

const monthInlineRow = {
  display: "flex" as const,
  alignItems: "center" as const,
  gap: 12,
  flexWrap: "wrap" as const,
};

const monthInputInline = {
  ...input,
  marginTop: 0,
  flex: 1,
  minWidth: 180,
  border: "1px solid #dfe7f3",
  borderRadius: 10,
};

const summaryBox = {
  display: "flex" as const,
  flexDirection: "column" as const,
  gap: 8,
  padding: 12,
  borderRadius: 14,
  background: "#ffffff",
  border: "1px solid #dfe7f3",
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)",
};

const summaryHeaderRow = {
  display: "flex" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
  gap: 12,
};

const summaryLabel = {
  fontSize: 13,
  fontWeight: 900,
  color: "#0f172a",
};

const summaryChip = {
  ...chipBase,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "default" as const,
  background: "#f8fbff",
};

const badgeBase = {
  display: "inline-block",
  padding: "2px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 800,
  lineHeight: 1.6,
  border: "1px solid #e5e7eb",
};

const badgeIncome = {
  ...badgeBase,
  background: "#ecfdf5",
  color: "#065f46",
  borderColor: "#bbf7d0",
};

const badgeExpense = {
  ...badgeBase,
  background: "#fef2f2",
  color: "#991b1b",
  borderColor: "#fecaca",
};

const badgeNeutral = {
  ...badgeBase,
  background: "#f3f4f6",
  color: "#374151",
};

const badgeApproved = {
  ...badgeBase,
  background: "#eff6ff",
  color: "#1e40af",
  borderColor: "#bfdbfe",
};

const badgePending = {
  ...badgeBase,
  background: "#fefce8",
  color: "#854d0e",
  borderColor: "#fde68a",
};

function formatDate(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("he-IL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return "";
  return `₪${n.toLocaleString("he-IL", { maximumFractionDigits: 2 })}`;
}

function statusLabel(status: string | null | undefined): {
  text: string;
  style: typeof badgeBase;
} | null {
  if (!status) return null;
  if (status === "approved") return { text: "מאושר", style: badgeApproved };
  if (status === "needs_review")
    return { text: "ממתין לבדיקה", style: badgePending };
  return { text: status, style: badgeNeutral };
}

function directionLabel(direction: string | null | undefined): {
  text: string;
  style: typeof badgeBase;
} | null {
  if (direction === "income") return { text: "הכנסה", style: badgeIncome };
  if (direction === "expense") return { text: "הוצאה", style: badgeExpense };
  return null;
}

function SearchPageHeader({ subtitle }: { subtitle: string }) {
  return (
    <section style={pageHeader}>
      <div>
        <div style={{ color: "#0f172a", fontSize: 20, fontWeight: 950 }}>
          חיפוש מסמכים
        </div>
        <div
          style={{
            color: "#64748b",
            fontSize: 12,
            fontWeight: 800,
            marginTop: 3,
            lineHeight: 1.45,
          }}
        >
          {subtitle}
        </div>
      </div>
      <div style={headerIcon} aria-hidden>
        ⌕
      </div>
    </section>
  );
}

export default function SearchPage() {
  const router = useRouter();

  // Hydration gate avoids SSR/CSR auth mismatch (token only exists on client).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => setMounted(true));
  }, []);

  const authHeader = useMemo<string | null>(() => {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem("token");
    return token ? `Bearer ${token}` : null;
  }, []);

  // Filter state
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [month, setMonth] = useState("");

  // Results state
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);

  const fetchResults = useCallback(
    async (params: {
      q?: string;
      category?: string | null;
      direction?: DirectionFilter;
      month?: string;
    }) => {
      if (!authHeader) {
        setError("לא מחובר. אנא התחבר מחדש.");
        return;
      }

      const url = new URL("/api/search", window.location.origin);
      if (params.q && params.q.trim()) url.searchParams.set("q", params.q.trim());
      if (params.category) url.searchParams.set("category", params.category);
      if (params.direction && params.direction !== "all") {
        url.searchParams.set("direction", params.direction);
      }
      if (params.month) url.searchParams.set("month", params.month);
      url.searchParams.set("limit", "30");

      try {
        setLoading(true);
        setError("");

        const res = await fetch(url.pathname + url.search, {
          headers: { Authorization: authHeader },
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || "Search failed");
        }
        setResults(Array.isArray(data.results) ? data.results : []);
      } catch (e: unknown) {
        setError(errorMessage(e, "שגיאה בחיפוש"));
      } finally {
        setLoading(false);
        setLoadedOnce(true);
      }
    },
    [authHeader]
  );

  // Initial fetch + auto-refetch on chip-style filters (not on free-text typing).
  useEffect(() => {
    if (!mounted) return;
    if (!authHeader) return;
    void Promise.resolve().then(() =>
      fetchResults({
        q: submittedQuery,
        category: selectedCategory,
        direction,
        month,
      })
    );
  }, [
    mounted,
    authHeader,
    submittedQuery,
    selectedCategory,
    direction,
    month,
    fetchResults,
  ]);

  function handleSubmitQuery() {
    setSubmittedQuery(query);
  }

  function clearAll() {
    setQuery("");
    setSubmittedQuery("");
    setSelectedCategory(null);
    setDirection("all");
    setMonth("");
  }

  const hasActiveFilters =
    Boolean(submittedQuery) ||
    Boolean(selectedCategory) ||
    direction !== "all" ||
    Boolean(month);

  const heading = hasActiveFilters ? "תוצאות סינון" : "מסמכים אחרונים";
  const subHeading = hasActiveFilters
    ? "אפשר לשנות סינון או לנקות הכל."
    : "מוצגים המסמכים האחרונים שאושרו. אפשר לחפש או לדפדף לפי קטגוריה / חודש / סוג.";

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!mounted) {
    return (
      <div dir="rtl" style={pageShell}>
        <main style={pageContent}>
          <SearchPageHeader subtitle="טוען מסמכים אחרונים..." />
          <div style={emptyState}>טוען...</div>
        </main>
      </div>
    );
  }

  if (!authHeader) {
    return (
      <div dir="rtl" style={pageShell}>
        <main style={pageContent}>
          <SearchPageHeader subtitle="צריך להתחבר למערכת קודם." />
          <div style={emptyState}>
            לא מחובר. אנא התחבר מחדש כדי לראות מסמכים.
          </div>
        </main>
      </div>
    );
  }

  return (
    <div dir="rtl" style={pageShell}>
      <main style={pageContent}>
        <SearchPageHeader subtitle="דפדף לפי קטגוריה, חודש או סוג - או חפש לפי ספק." />

        {/* Primary action — free search.
            Input + "חפש" sit on the same row so the user reads them as a
            single composite control, not as two unrelated buttons. The
            "נקה חיפוש" affordance is a small inline link, never a full
            secondary button competing with the primary CTA. */}
        <section style={searchCard}>
          <div style={cardHeaderRow}>
            <div style={{ ...iconWrap, background: "#eff6ff", color: "#002b6b" }} aria-hidden>
              🔍
            </div>
            <div style={cardTitle}>חיפוש</div>
          </div>

          <div style={searchRow}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitQuery();
              }}
              placeholder="לדוגמה: פז / דלק"
              style={searchInputInline}
              aria-label="חיפוש טקסט"
            />
            <button
              type="button"
              style={searchPrimaryBtnInline(loading)}
              onClick={handleSubmitQuery}
              disabled={loading}
            >
              {loading ? "מחפש..." : "חפש"}
            </button>
          </div>

          {submittedQuery ? (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                style={inlineLinkBtn}
                onClick={() => {
                  setQuery("");
                  setSubmittedQuery("");
                }}
              >
                נקה חיפוש טקסט
              </button>
            </div>
          ) : null}
        </section>

        {/* Guided browsing — single card.
            Direction / month / category were three separate cards each with
            their own header and icon; collapsing them into one card with
            small inline labels removes a lot of visual repetition and makes
            the relationship "all of these are filters" clearer. */}
        <section style={searchCard}>
          <div style={cardHeaderRow}>
            <div style={{ ...iconWrap, background: "#eff6ff", color: "#002b6b" }} aria-hidden>
              🧭
            </div>
            <div style={cardTitle}>דפדוף מודרך</div>
          </div>

          <div style={filterGroup}>
            <span style={filterLabel}>סוג</span>
            <div style={chipRow}>
              <button
                type="button"
                style={direction === "all" ? chipActive : chipBase}
                onClick={() => setDirection("all")}
                aria-pressed={direction === "all"}
              >
                הכל
              </button>
              <button
                type="button"
                style={direction === "income" ? chipActive : chipBase}
                onClick={() => setDirection("income")}
                aria-pressed={direction === "income"}
              >
                הכנסות
              </button>
              <button
                type="button"
                style={direction === "expense" ? chipActive : chipBase}
                onClick={() => setDirection("expense")}
                aria-pressed={direction === "expense"}
              >
                הוצאות
              </button>
            </div>
          </div>

          <div style={filterGroup}>
            <span style={filterLabel}>חודש</span>
            <div style={monthInlineRow}>
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                style={monthInputInline}
                aria-label="סינון לפי חודש"
              />
              {month ? (
                <button
                  type="button"
                  style={inlineLinkBtn}
                  onClick={() => setMonth("")}
                >
                  נקה חודש
                </button>
              ) : null}
            </div>
          </div>

          <div style={filterGroup}>
            <span style={filterLabel}>קטגוריה</span>
            <div style={chipRow}>
              <button
                type="button"
                style={selectedCategory === null ? chipActive : chipBase}
                onClick={() => setSelectedCategory(null)}
                aria-pressed={selectedCategory === null}
              >
                הכל
              </button>
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  style={
                    selectedCategory === c.value ? chipActive : chipBase
                  }
                  onClick={() =>
                    setSelectedCategory(
                      selectedCategory === c.value ? null : c.value
                    )
                  }
                  aria-pressed={selectedCategory === c.value}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Active filters summary + clear.
            Slimmer than before: gray surface with a header row that puts
            the "סינון פעיל" label on the right and a small "נקה הכל" text
            link on the left, so the global clear action never feels louder
            than the primary search CTA above. The summary chips are
            non-interactive, so we use a `cursor: default` variant. */}
        {hasActiveFilters ? (
          <div style={summaryBox}>
            <div style={summaryHeaderRow}>
              <span style={summaryLabel}>סינון פעיל</span>
              <button
                type="button"
                style={inlineLinkBtn}
                onClick={clearAll}
              >
                נקה הכל
              </button>
            </div>
            <div style={chipRow}>
              {submittedQuery ? (
                <span style={summaryChip}>חיפוש: “{submittedQuery}”</span>
              ) : null}
              {direction !== "all" ? (
                <span style={summaryChip}>
                  {direction === "income" ? "הכנסות" : "הוצאות"}
                </span>
              ) : null}
              {month ? (
                <span style={summaryChip}>חודש: {month}</span>
              ) : null}
              {selectedCategory ? (
                <span style={summaryChip}>
                  קטגוריה: {CATEGORY_MAP[selectedCategory] || selectedCategory}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Results header */}
        <section style={searchCard}>
          <div style={cardHeaderRow}>
            <div style={{ ...iconWrap, background: "#eff6ff", color: "#002b6b" }} aria-hidden>
              📂
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={cardTitle}>{heading}</div>
              <div style={cardSubText}>{subHeading}</div>
            </div>
          </div>
          {loading ? (
            <div style={cardSubText}>טוען...</div>
          ) : (
            <div style={cardSubText}>
              {results.length === 0
                ? "אין תוצאות להצגה."
                : `מציג ${results.length} מסמכים${
                    results.length === 30 ? " (עד 30)" : ""
                  }`}
            </div>
          )}
        </section>

        {error ? <div style={alertError}>{error}</div> : null}

        {/* Empty states */}
        {!loading && !error && loadedOnce && results.length === 0 ? (
          <div style={emptyState}>
            {hasActiveFilters
              ? "לא נמצאו מסמכים שמתאימים לסינון."
              : "אין עדיין מסמכים מאושרים. אחרי שתעלה ותאשר מסמך הוא יופיע כאן."}
          </div>
        ) : null}

        {/* Results list */}
        {results.map((r) => {
          const dir = directionLabel(r.direction);
          const st = statusLabel(r.document?.status);
          const dateText = formatDate(r.date);
          const categoryLabel = CATEGORY_MAP[r.category] || r.category || "כללי";

          return (
            <button
              key={r.id}
              onClick={() => router.push(`/documents/review/${r.documentId}`)}
              style={{
                ...searchCard,
                width: "100%",
                textAlign: "right",
                cursor: "pointer",
                padding: 16,
                font: "inherit",
                color: "inherit",
              }}
              aria-label={`פתח מסמך של ${r.vendorName}`}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  width: "100%",
                }}
              >
                <div style={{ ...iconWrap, background: "#eff6ff", color: "#002b6b" }} aria-hidden>
                  📄
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={cardTitle}>{r.vendorName || "(ללא ספק)"}</div>
                  <div style={cardSubText}>
                    {categoryLabel}
                    {dateText ? ` · ${dateText}` : ""}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      flexWrap: "wrap",
                      marginTop: 8,
                    }}
                  >
                    {dir ? <span style={dir.style}>{dir.text}</span> : null}
                    {st ? <span style={st.style}>{st.text}</span> : null}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      marginTop: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 950,
                        color: "#0f172a",
                        fontSize: 18,
                      }}
                    >
                      {formatAmount(r.amount)}
                    </div>
                    <span
                      style={{
                        ...badgeBase,
                        background: "#002b6b",
                        color: "#ffffff",
                        borderColor: "#002b6b",
                      }}
                    >
                      פתח →
                    </span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </main>
    </div>
  );
}
