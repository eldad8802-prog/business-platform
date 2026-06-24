"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CATEGORIES } from "@/lib/constants/categories";
import { fetchDocumentsHubSummary } from "@/lib/documents/fetch-inbox";
import { TOKEN } from "@/lib/design/tokens";
import { chipActionStyle, glassActionStyle, primaryActionStyle } from "@/lib/design/action-styles";

type PeriodType = "month" | "quarter" | "year";

function currentMonthValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthLabel(value: string): string {
  const [year, month] = value.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return value;
  return new Date(year, month - 1, 1).toLocaleDateString("he-IL", {
    month: "long",
    year: "numeric",
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function parsePeriodMonth(period: string): { year: number; month: number } | null {
  const [year, month] = period.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  return { year, month };
}

type MonthCloseState = {
  status: "OPEN" | "CLOSED";
  closedAt: string | null;
  critical: number;
  warning: number;
  canClose: boolean;
};

export default function AccountantPackPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [type, setType] = useState<PeriodType>("month");
  const [period, setPeriod] = useState(currentMonthValue());
  const [categories, setCategories] = useState<string[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [monthClose, setMonthClose] = useState<MonthCloseState | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeMsg, setCloseMsg] = useState("");

  useEffect(() => {
    if (!token || type !== "month") return;
    const parsed = parsePeriodMonth(period);
    if (!parsed) return;

    let cancelled = false;
    void fetch(
      `/api/accounting/month-close?year=${parsed.year}&month=${parsed.month}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setCloseMsg("");
        if (!data) {
          setMonthClose(null);
          return;
        }
        setMonthClose({
          status: data.monthClose?.status ?? "OPEN",
          closedAt: data.monthClose?.closedAt ?? null,
          critical: data.exceptions?.totals?.critical ?? 0,
          warning: data.exceptions?.totals?.warning ?? 0,
          canClose: Boolean(data.canClose),
        });
      })
      .catch(() => {
        if (!cancelled) setMonthClose(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token, type, period]);

  async function handleCloseMonth() {
    if (!token || type !== "month") return;
    const parsed = parsePeriodMonth(period);
    if (!parsed) return;
    try {
      setCloseBusy(true);
      setCloseMsg("");
      const res = await fetch("/api/accounting/month-close", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ year: parsed.year, month: parsed.month }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setCloseMsg(data?.error ?? "שגיאה בסגירת החודש");
        if (data?.exceptions?.totals) {
          setMonthClose((prev) =>
            prev
              ? {
                  ...prev,
                  critical: data.exceptions.totals.critical ?? prev.critical,
                  warning: data.exceptions.totals.warning ?? prev.warning,
                  canClose: false,
                }
              : prev
          );
        }
        return;
      }
      setMonthClose({
        status: data.monthClose?.status ?? "CLOSED",
        closedAt: data.monthClose?.closedAt ?? null,
        critical: data.exceptions?.totals?.critical ?? 0,
        warning: data.exceptions?.totals?.warning ?? 0,
        canClose: false,
      });
    } catch (err) {
      setCloseMsg(errorMessage(err, "שגיאה בסגירת החודש"));
    } finally {
      setCloseBusy(false);
    }
  }

  useEffect(() => {
    void Promise.resolve().then(() => {
      const nextToken = window.localStorage.getItem("token");
      if (!nextToken) {
        router.replace("/login");
        return;
      }
      setToken(nextToken);
      void fetchDocumentsHubSummary(nextToken)
        .then((snapshot) =>
          setPendingCount(snapshot.financialPulse.inboxDocumentCounts.pendingReview ?? 0)
        )
        .catch(() => setPendingCount(0));
    });
  }, [router]);

  const visibleCategories = useMemo(
    () =>
      ["fuel", "services", "salary", "marketing"]
        .map((value) => CATEGORIES.find((category) => category.value === value))
        .filter((category): category is (typeof CATEGORIES)[number] => Boolean(category)),
    []
  );
  const periodLabel = type === "month" ? currentMonthLabel(period) : period;

  function toggleCategory(value: string) {
    setCategories((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    );
  }

  async function handleDownload() {
    if (!token) return;
    try {
      setLoading(true);
      setError("");
      const response = await fetch("/api/reports/export-zip", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type,
          month: type === "month" ? period : "",
          year: type === "year" ? period : "",
          quarter: type === "quarter" ? period : "",
          categories,
        }),
      });
      if (!response.ok) throw new Error("שגיאה ביצירת חבילה");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "accountant-pack.zip";
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(err, "שגיאה"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir="rtl" style={pageStyle}>
      <main style={mainStyle}>
        <header style={headStyle}>
          <button
            type="button"
            onClick={() => router.push("/documents")}
            style={backButtonStyle}
            aria-label="חזרה"
          >
            <BackChevronIcon />
            חזרה
          </button>
          <h1 style={titleStyle}>חבילת רו״ח</h1>
          <div aria-hidden style={{ width: 52 }} />
        </header>

        <section>
          <div style={labelStyle}>תקופה</div>
          <div style={segStyle}>
            {[
              { key: "month" as const, label: "חודש" },
              { key: "quarter" as const, label: "רבעון" },
              { key: "year" as const, label: "שנה" },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setType(item.key)}
                style={type === item.key ? segButtonActiveStyle : segButtonStyle}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label style={periodFieldStyle}>
            <CalendarIcon />
            <input
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              type={type === "month" ? "month" : "text"}
              placeholder={type === "quarter" ? "2026-Q2" : "2026"}
              aria-label="תקופה"
              style={periodInputStyle}
            />
          </label>
          <div style={periodPreviewStyle}>{periodLabel}</div>
        </section>

        <section style={{ marginTop: 18 }}>
          <div style={labelStyle}>קטגוריות</div>
          <div style={filtersStyle}>
            <button
              type="button"
              onClick={() => setCategories([])}
              style={categories.length === 0 ? chipActiveStyle : chipStyle}
            >
              הכל
            </button>
            {visibleCategories.map((category) => (
              <button
                key={category.value}
                type="button"
                onClick={() => toggleCategory(category.value)}
                style={
                  categories.includes(category.value) ? chipActiveStyle : chipStyle
                }
              >
                {category.label}
              </button>
            ))}
          </div>
        </section>

        {pendingCount > 0 ? (
          <div style={blockerStyle}>
            <WarningIcon />
            <span>
              {pendingCount.toLocaleString("he-IL")} מסמכים עדיין לא אומתו - אמת אותם כדי לכלול אותם
            </span>
          </div>
        ) : null}

        {type === "month" && monthClose ? (
          <section style={{ marginTop: 18 }}>
            <div style={labelStyle}>סטטוס חודש</div>
            {monthClose.status === "CLOSED" ? (
              <div style={closedBoxStyle}>
                <span>
                  החודש נסגר
                  {monthClose.closedAt
                    ? ` בתאריך ${new Date(monthClose.closedAt).toLocaleString("he-IL")}`
                    : ""}
                </span>
              </div>
            ) : (
              <>
                <div style={openBoxStyle}>
                  <span>
                    החודש פתוח · {monthClose.critical} חריגים קריטיים ·{" "}
                    {monthClose.warning} אזהרות
                  </span>
                </div>
                {monthClose.critical > 0 ? (
                  <div style={errorStyle}>
                    <WarningIcon />
                    <span>יש לתקן את כל החריגים הקריטיים לפני סגירת החודש</span>
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={closeBusy || monthClose.critical > 0}
                  onClick={() => void handleCloseMonth()}
                  style={{
                    ...closeMonthButtonStyle,
                    opacity: closeBusy || monthClose.critical > 0 ? 0.5 : 1,
                    cursor:
                      closeBusy || monthClose.critical > 0
                        ? "not-allowed"
                        : "pointer",
                  }}
                >
                  {closeBusy ? "סוגר חודש..." : "סגור חודש"}
                </button>
                {closeMsg ? <div style={errorStyle}>{closeMsg}</div> : null}
              </>
            )}
          </section>
        ) : null}

        {error ? <div style={errorStyle}>{error}</div> : null}
      </main>

      <div style={bottomBarStyle}>
        <button
          type="button"
          disabled={loading}
          onClick={() => void handleDownload()}
          style={{
            ...downloadButtonStyle,
            opacity: loading ? 0.7 : 1,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "מכין חבילה..." : "הורד חבילה (ZIP)"}
        </button>
      </div>
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2.5" stroke={TOKEN.ink.muted} strokeWidth="1.8" fill="none" />
      <path d="M3 9h18M8 3v4M16 3v4" stroke={TOKEN.ink.muted} strokeWidth="1.8" strokeLinecap="round" />
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

function WarningIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const pageStyle = {
  minHeight: "100vh",
  background: TOKEN.surface.page,
  color: TOKEN.ink.primary,
  paddingBottom: 110,
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
  marginBottom: 20,
} as const;

const backButtonStyle = {
  ...glassActionStyle({ height: 40 }),
  width: 40,
  height: 40,
  fontSize: 0,
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

const labelStyle = {
  color: TOKEN.ink.secondary,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.bold,
  marginBottom: 10,
} as const;

const segStyle = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 6,
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 6,
} as const;

const segButtonStyle = {
  ...chipActionStyle(false),
  minHeight: 42,
  fontSize: TOKEN.font.body,
} as const;

const segButtonActiveStyle = {
  ...chipActionStyle(true),
  minHeight: 42,
  fontSize: TOKEN.font.body,
} as const;

const periodFieldStyle = {
  minHeight: 52,
  marginTop: 12,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  gap: 10,
} as const;

const periodInputStyle = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  color: TOKEN.ink.primary,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const periodPreviewStyle = {
  marginTop: 8,
  color: TOKEN.ink.muted,
  fontSize: TOKEN.font.meta,
  fontWeight: TOKEN.weight.semibold,
} as const;

const filtersStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
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

const blockerStyle = {
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.semantic.attention.bgSoft,
  color: TOKEN.semantic.attention.ink,
  minHeight: 52,
  marginTop: 18,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  lineHeight: 1.5,
} as const;

const errorStyle = {
  ...blockerStyle,
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
} as const;

const openBoxStyle = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  minHeight: 52,
  padding: "0 14px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
  color: TOKEN.ink.primary,
} as const;

const closedBoxStyle = {
  ...openBoxStyle,
  border: `1px solid ${TOKEN.semantic.attention.border}`,
  background: TOKEN.semantic.attention.bgSoft,
  color: TOKEN.semantic.attention.ink,
} as const;

const closeMonthButtonStyle = {
  ...glassActionStyle({ height: 48 }),
  width: "100%",
  marginTop: 12,
  fontSize: TOKEN.font.body,
  fontWeight: TOKEN.weight.bold,
} as const;

const bottomBarStyle = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  background: TOKEN.surface.card,
  borderTop: `1px solid ${TOKEN.border.DEFAULT}`,
  padding: "12px 14px 22px",
  boxShadow: TOKEN.shadow.floating,
} as const;

const downloadButtonStyle = {
  ...primaryActionStyle({ height: 52 }),
  width: "min(492px, 100%)",
  minHeight: 52,
  margin: "0 auto",
  display: "block",
  fontSize: TOKEN.font.body,
} as const;
