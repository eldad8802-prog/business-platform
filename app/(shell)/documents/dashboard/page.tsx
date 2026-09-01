"use client";

import { PageContainer } from "@/components/ui/page-container";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import DocumentsBackButton from "@/components/documents/DocumentsBackButton";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  alertError,
  card,
  cardSubText,
  cardTitle,
  iconWrap,
  metricTile,
  pageMain,
  primaryBtn,
  secondaryBtn,
} from "../ui";
import { CATEGORY_MAP } from "@/lib/constants/categories";
import { TOKEN } from "@/lib/design/documents-theme";
import DocumentsDashboardSkeleton from "@/components/documents/skeletons/DocumentsDashboardSkeleton";
import DubizDateField from "@/components/documents/DubizDateField";

type Report = {
  totalIncome: number;
  totalExpense: number;
  profit: number;
  categories: Record<string, number>;
  count: number;
};

const cardHeaderRow = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 12,
};

const metricLabel = {
  fontSize: TOKEN.font.meta,
  color: TOKEN.ink.muted,
  fontWeight: TOKEN.weight.semibold,
};

const metricValue = {
  fontSize: TOKEN.font.hero,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
  lineHeight: 1.2,
};

const balancePositive = {
  ...metricValue,
  color: TOKEN.semantic.success.ink,
};

const balanceNegative = {
  ...metricValue,
  color: TOKEN.semantic.urgent.ink,
};

const periodChipRow = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: 8,
  marginTop: 12,
};

const periodChip = (active: boolean) => ({
  padding: "8px 14px",
  borderRadius: TOKEN.radius.pill,
  border: active ? `1px solid ${TOKEN.brand.mid}` : `1px solid ${TOKEN.border.DEFAULT}`,
  background: active ? TOKEN.brand.gradient : TOKEN.surface.card,
  color: active ? TOKEN.ink.inverse : TOKEN.ink.primary,
  fontWeight: TOKEN.weight.bold,
  fontSize: TOKEN.font.meta,
  cursor: "pointer",
});

const breakdownRow = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  alignItems: "center",
  gap: 10,
  padding: "10px 0",
  borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
};

const breakdownLabel = {
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.semibold,
  color: TOKEN.ink.primary,
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const breakdownValue = {
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
  whiteSpace: "nowrap" as const,
};

const breakdownPercent = {
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
  color: TOKEN.ink.muted,
  whiteSpace: "nowrap" as const,
};

const formatAmount = (n: number): string => {
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: "ILS",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${n} ₪`;
  }
};

const monthLabel = (ym: string): string => {
  if (!ym) return "כל התקופות";
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  try {
    const dt = new Date(y, m - 1, 1);
    return new Intl.DateTimeFormat("he-IL", {
      month: "long",
      year: "numeric",
    }).format(dt);
  } catch {
    return ym;
  }
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function Dashboard() {
  const router = useRouter();

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    void Promise.resolve().then(() => setMounted(true));
  }, []);

  const authHeader = useMemo<string | null>(() => {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem("token");
    if (!token) return null;
    return `Bearer ${token}`;
  }, []);

  const [data, setData] = useState<Report | null>(null);
  const [month, setMonth] = useState("");
  const [appliedMonth, setAppliedMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = async (selectedMonth?: string) => {
    try {
      setLoading(true);
      setError("");

      if (!authHeader) {
        router.replace("/login");
        return;
      }

      const url = selectedMonth
        ? `/api/reports/summary?month=${selectedMonth}`
        : `/api/reports/summary`;

      const res = await fetch(url, {
        headers: { Authorization: authHeader },
        cache: "no-store",
      });

      if (res.status === 401) {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("token");
          window.localStorage.removeItem("user");
        }
        router.replace("/login");
        return;
      }

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result?.error || "שגיאה בטעינת הדוח");
      }

      setData(result as Report);
      setAppliedMonth(selectedMonth || "");
    } catch (e: unknown) {
      setError(errorMessage(e, "שגיאה בטעינת הדוח"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!mounted) return;
    void Promise.resolve().then(() => fetchData());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const periodLabel = appliedMonth
    ? `התקופה: ${monthLabel(appliedMonth)}`
    : "התקופה: כל התקופות";

  const balanceStyle =
    data && data.profit < 0 ? balanceNegative : balancePositive;

  // Income vs Expense chart data
  const chartData = data
    ? [
    { name: "הכנסות", value: data.totalIncome, fill: TOKEN.semantic.success.ink },
    { name: "הוצאות", value: data.totalExpense, fill: TOKEN.semantic.urgent.ink },
      ]
    : [];

  // Category breakdown rows, sorted descending by amount
  const categoryRows = data
    ? Object.entries(data.categories)
        .filter(([, val]) => Number.isFinite(val) && val !== 0)
        .sort((a, b) => b[1] - a[1])
    : [];

  const categoriesTotal = categoryRows.reduce((sum, [, v]) => sum + v, 0);

  const isAllPeriods = !appliedMonth;
  const hasNoRecords = !!data && data.count === 0;

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: TOKEN.surface.page }}>
      <PageContainer intent="data" style={{ paddingBlock: "14px 40px" }}>
        <div style={{ marginBottom: 12 }}>
          <DocumentsBackButton onClick={() => router.push("/documents")} />
        </div>
        <section style={{ textAlign: "center", padding: "4px 0 2px" }}>
          <h1
            style={{
              margin: 0,
              color: TOKEN.ink.primary,
              fontSize: TOKEN.font.hero,
              fontWeight: TOKEN.weight.bold,
            }}
          >
            דוחות פיננסיים
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              color: TOKEN.ink.muted,
              fontSize: TOKEN.font.body,
              lineHeight: 1.6,
              fontWeight: TOKEN.weight.semibold,
            }}
          >
            תמונת מצב לפי המסמכים שכבר אושרו.
          </p>
        </section>

        {/* Period selector */}
        <div style={card}>
          <div style={cardHeaderRow}>
            <div style={iconWrap} aria-hidden>
              📅
            </div>
            <div style={cardTitle}>תקופה</div>
          </div>

          <DubizDateField
            type="month"
            ariaLabel="בחירת חודש לדוח"
            value={month}
            onChange={(value) => setMonth(value)}
          />

          <div style={periodChipRow}>
            <button
              type="button"
              style={periodChip(!!appliedMonth && month === appliedMonth)}
              onClick={() => void fetchData(month || undefined)}
            >
              הצג דוח לחודש
            </button>
            <button
              type="button"
              style={periodChip(!appliedMonth)}
              onClick={() => {
                setMonth("");
                void fetchData();
              }}
            >
              כל התקופות
            </button>
          </div>

          <div style={{ ...cardSubText, marginTop: 10 }}>{periodLabel}</div>
        </div>

        {/* Loading / error states (kept inline so the period card stays visible) */}
        {loading ? <DocumentsDashboardSkeleton /> : null}
        {error ? <div style={alertError}>{error}</div> : null}

        {/* Summary metrics */}
        {!loading && !error && data ? (
          <div style={card}>
            <div style={cardHeaderRow}>
              <div style={iconWrap} aria-hidden>
                📊
              </div>
              <div style={cardTitle}>סיכום</div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 10,
              }}
            >
              <div style={metricTile}>
                <div style={metricLabel}>
                  <span aria-hidden>💵 </span>
                  הכנסות
                </div>
                <div style={metricValue}>{formatAmount(data.totalIncome)}</div>
              </div>

              <div style={metricTile}>
                <div style={metricLabel}>
                  <span aria-hidden>💸 </span>
                  הוצאות
                </div>
                <div style={metricValue}>{formatAmount(data.totalExpense)}</div>
              </div>

              <div style={metricTile}>
                <div style={metricLabel}>
                  <span aria-hidden>⚖️ </span>
                  יתרה
                </div>
                <div style={balanceStyle}>{formatAmount(data.profit)}</div>
              </div>

              <div style={metricTile}>
                <div style={metricLabel}>
                  <span aria-hidden>🧾 </span>
                  עסקאות
                </div>
                <div style={metricValue}>{data.count}</div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Empty state — explicit, after the summary so users see the period
            they queried before the empty message. */}
        {!loading && !error && hasNoRecords ? (
          <div style={card}>
            <div style={cardHeaderRow}>
              <div style={iconWrap} aria-hidden>
                ℹ️
              </div>
              <div style={cardTitle}>אין עסקאות מאושרות</div>
            </div>
            <p style={cardSubText}>
              {isAllPeriods
                ? "עדיין אין רשומות פיננסיות מאושרות. אחרי אישור מסמך כעסקה (הכנסה/הוצאה) הוא יופיע כאן ובחיפוש."
                : `לא נמצאו עסקאות מאושרות עבור ${monthLabel(
                    appliedMonth
                  )}. אפשר להציג טווח אחר או לעבור ל"כל התקופות".`}
            </p>
            <Link href="/documents/upload" style={{ textDecoration: "none" }}>
              <button type="button" style={primaryBtn} data-dz-action="primary">
                העלאת מסמך חדש
              </button>
            </Link>
          </div>
        ) : null}

        {/* Income vs Expense chart */}
        {!loading && !error && data && !hasNoRecords ? (
          <div style={card}>
            <div style={cardHeaderRow}>
              <div style={iconWrap} aria-hidden>
                📈
              </div>
              <div style={cardTitle}>הכנסות מול הוצאות</div>
            </div>

            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: 10, bottom: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={TOKEN.border.DEFAULT} />
                  <XAxis
                    dataKey="name"
                    tick={{ fill: TOKEN.ink.secondary, fontSize: 13, fontWeight: 600 }}
                  />
                  <YAxis
                    tick={{ fill: TOKEN.ink.muted, fontSize: 12 }}
                    tickFormatter={(v) => formatAmount(Number(v))}
                    width={80}
                  />
                  <Tooltip
                    formatter={(v) => formatAmount(Number(v))}
                    cursor={{ fill: TOKEN.surface.inset }}
                  />
                  <Bar dataKey="value" radius={[10, 10, 0, 0]}>
                    {chartData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : null}

        {/* Categories breakdown — intentionally lower in the page hierarchy.
            Categories are no longer the headline of Reports; they live here
            as supporting context, while Search owns guided category browsing. */}
        {!loading && !error && data && !hasNoRecords && categoryRows.length > 0 ? (
          <div style={card}>
            <div style={cardHeaderRow}>
              <div style={iconWrap} aria-hidden>
                🏷️
              </div>
              <div style={cardTitle}>פירוט לפי קטגוריות</div>
            </div>

            <p style={cardSubText}>
              סכום פעילות בכל קטגוריה, ואחוז מתוך כלל הפעילות בתקופה.
            </p>

            <div style={{ marginTop: 10 }}>
              {categoryRows.map(([cat, val]) => {
                const pct =
                  categoriesTotal > 0
                    ? Math.round((val / categoriesTotal) * 100)
                    : 0;
                return (
                  <div key={cat} style={breakdownRow}>
                    <div style={breakdownLabel}>{CATEGORY_MAP[cat] || cat}</div>
                    <div style={breakdownValue}>{formatAmount(val)}</div>
                    <div style={breakdownPercent}>{pct}%</div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* Accountant CTA — surface the existing wizard prominently from the
            reports center, instead of relying on hidden navigation. */}
        <div style={card}>
          <div style={cardHeaderRow}>
            <div style={iconWrap} aria-hidden>
              📦
            </div>
            <div style={cardTitle}>חבילה לרואה חשבון</div>
          </div>

          <p style={cardSubText}>
            ייצוא ZIP עם CSV וקבצי המסמכים לפי תקופה וקטגוריות.
          </p>

          <Link
            href="/documents/accountant-pack"
            style={{ textDecoration: "none" }}
          >
            <button type="button" style={primaryBtn} data-dz-action="primary">
              צור חבילה לרואה חשבון
            </button>
          </Link>

          <Link href="/documents/search" style={{ textDecoration: "none" }}>
            <button type="button" style={secondaryBtn}>
              עבור לחיפוש מסמכים
            </button>
          </Link>
        </div>
      </PageContainer>
    </div>
  );
}
