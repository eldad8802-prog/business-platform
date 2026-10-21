"use client";

/**
 * An export for any period on demand — a month, a quarter or a year (D7: history stays available).
 * Built in memory by POST /api/reports/export-zip from the same sources and rules as the monthly package.
 * The request names the period exactly; the server refuses anything it cannot read (it no longer widens
 * an unreadable quarter to "every record").
 */

import { useMemo, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import { CATEGORIES } from "@/lib/constants/categories";
import { categoryLabel } from "@/lib/documents/category-label";
import { addPeriods, previousPeriodKey } from "@/lib/accountant/period";
import { TOKEN, chipActionStyle, glassActionStyle } from "@/lib/design/documents-theme";

type PeriodType = "month" | "quarter" | "year";

function defaultFor(type: PeriodType, now = new Date()): string {
  const prev = previousPeriodKey(now);
  if (type === "month") return prev;
  const [y, m] = prev.split("-").map(Number);
  if (type === "quarter") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  // The last completed calendar year (Israel): the current month's year minus one.
  return String(Number(addPeriods(prev, 1).slice(0, 4)) - 1);
}

export function AdHocExport({ token, pendingAllTime }: { token: string; pendingAllTime: number }) {
  const { t } = useI18n();
  const [type, setType] = useState<PeriodType>("month");
  const [period, setPeriod] = useState(defaultFor("month"));
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const visibleCategories = useMemo(
    () =>
      ["fuel", "services", "salary", "marketing"]
        .map((value) => CATEGORIES.find((c) => c.value === value))
        .filter((c): c is (typeof CATEGORIES)[number] => Boolean(c)),
    []
  );

  function pickType(next: PeriodType) {
    setType(next);
    setPeriod(defaultFor(next));
    setError("");
  }

  async function download() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/reports/export-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type,
          month: type === "month" ? period : "",
          year: type === "year" ? period : "",
          quarter: type === "quarter" ? period : "",
          categories,
        }),
      });
      if (res.status === 400) throw new Error("התקופה אינה תקינה — בחרו חודש, רבעון (2026-Q3) או שנה (2025).");
      if (!res.ok) throw new Error("לא הצלחנו להכין את החבילה. נסו שוב.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `accountant-pack-${period}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "שגיאה");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={card} aria-labelledby="adhoc-title">
      <h3 id="adhoc-title" style={h3}>הורדה לתקופה אחרת</h3>
      <div style={seg}>
        {([
          { key: "month", label: t("documents.pack.month") },
          { key: "quarter", label: t("documents.pack.quarter") },
          { key: "year", label: t("documents.pack.year") },
        ] as const).map((item) => (
          <button key={item.key} type="button" onClick={() => pickType(item.key)} style={{ ...chipActionStyle(type === item.key), minHeight: 40 }} aria-pressed={type === item.key}>
            {item.label}
          </button>
        ))}
      </div>
      <label style={{ display: "block", marginTop: 10 }}>
        <span style={label}>{t("documents.pack.period")}</span>
        <input
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          type={type === "month" ? "month" : "text"}
          placeholder={type === "quarter" ? "2026-Q3" : type === "year" ? "2025" : undefined}
          aria-label={t("documents.pack.period")}
          className={type === "month" ? "dz-native-date" : undefined}
          dir="ltr"
          style={input}
        />
      </label>
      <div style={{ marginTop: 10 }}>
        <span style={label}>קטגוריות (מסמכים סרוקים)</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setCategories([])} style={{ ...chipActionStyle(categories.length === 0), minHeight: 34 }}>{t("documents.pack.all")}</button>
          {visibleCategories.map((c) => (
            <button key={c.value} type="button" style={{ ...chipActionStyle(categories.includes(c.value)), minHeight: 34 }}
              onClick={() => setCategories((cur) => (cur.includes(c.value) ? cur.filter((x) => x !== c.value) : [...cur, c.value]))}>
              {categoryLabel(t, c.value)}
            </button>
          ))}
        </div>
      </div>
      <p style={muted}>
        כוללת מסמכים סרוקים שאושרו ומסמכים שהופקו בדוביז. מסמכים שעדיין לא נבדקו מופיעים ברשימה נפרדת בלבד.
        {pendingAllTime > 0 ? ` כרגע ${pendingAllTime.toLocaleString("he-IL")} מסמכים ממתינים לבדיקה (בכל החודשים).` : ""}
      </p>
      {error ? <div style={errorBox} role="alert">{error}</div> : null}
      <button type="button" onClick={() => void download()} disabled={loading} style={{ ...glassActionStyle({ height: 46 }), marginTop: 8 }}>
        {loading ? "מכין…" : "הורד (ZIP)"}
      </button>
    </section>
  );
}

const card = {
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.card,
  background: TOKEN.surface.card,
  boxShadow: TOKEN.shadow.elevated,
  padding: 16,
  marginBottom: 14,
} as const;
const h3 = { margin: "0 0 10px", fontSize: TOKEN.font.body, fontWeight: TOKEN.weight.bold } as const;
const seg = { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 } as const;
const label = { color: TOKEN.ink.secondary, fontSize: TOKEN.font.meta, fontWeight: TOKEN.weight.bold, marginBottom: 6, display: "block" } as const;
const input = {
  width: "100%",
  minHeight: 46,
  border: `1px solid ${TOKEN.border.DEFAULT}`,
  borderRadius: TOKEN.radius.input,
  padding: "0 12px",
  fontSize: TOKEN.font.body,
  background: TOKEN.surface.card,
  color: TOKEN.ink.primary,
  boxSizing: "border-box" as const,
} as const;
const muted = { margin: "10px 0", color: TOKEN.ink.muted, fontSize: TOKEN.font.meta, lineHeight: 1.6 } as const;
const errorBox = {
  border: `1px solid ${TOKEN.semantic.urgent.border}`,
  background: TOKEN.semantic.urgent.bgSoft,
  color: TOKEN.semantic.urgent.ink,
  borderRadius: TOKEN.radius.card,
  padding: "10px 14px",
  fontWeight: TOKEN.weight.bold,
} as const;
