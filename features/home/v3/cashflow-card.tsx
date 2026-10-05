"use client";

import { useId, useState, type CSSProperties } from "react";

import { IconInfo } from "@/components/navigation/nav-icons";

import {
  barPx,
  barScale,
  chartAxis,
  formatNumber,
  formatShekel,
  netOf,
  type CashflowPeriod,
  type CashflowSeries,
  type Load,
} from "./home-v3-model";

/**
 * "הכנסות והוצאות" — the dark teal card, drawn per the approved references:
 * mobile (stacked net + split), tablet (net beside the split) and desktop
 * (wide chart with a value axis, grid and legend; the figures live in the KPI
 * strip above it). One component, one data shape, three faces.
 *
 * Truthful degradation:
 *   - The hourly view draws income bars only — no source holds the hour an
 *     expense was paid (TODO(future): hourly cash-out). Its expense total is
 *     the day's real cash out.
 *   - "חודש" stays visible but disabled — nothing yet returns month-long
 *     income per day without dozens of reads (TODO(future)). "שבוע" is drawn
 *     only once every one of its seven days has been read.
 *   - The info button says what the numbers cover; the copy above it stays
 *     the approved copy.
 */

export type CashflowVariant = "mobile" | "tablet" | "desktop";

const GRADIENT = "linear-gradient(160deg, #1D5552 0%, #246966 55%, #2D7A77 100%)";
const INCOME = "#9BE4E3";
const EXPENSE = "#F2B97A";
const INCOME_DIM = "rgba(155,228,227,0.42)";
const EXPENSE_DIM = "rgba(242,185,122,0.42)";

const GEOMETRY = {
  mobile: { height: 150, zero: 100, inc: 98, exp: 48, barW: "10px", barMax: 10, radius: 5, cardRadius: 24, pad: "20px", gap: 16 },
  tablet: { height: 160, zero: 108, inc: 106, exp: 50, barW: "60%", barMax: 16, radius: 5, cardRadius: 26, pad: "22px", gap: 18 },
  desktop: { height: 250, zero: 168, inc: 166, exp: 80, barW: "58%", barMax: 24, radius: 6, cardRadius: 26, pad: "22px 24px", gap: 16 },
} as const;

const SHADOW = {
  mobile: "0 12px 28px -14px rgba(29,85,82,0.55)",
  tablet: "0 14px 30px -16px rgba(29,85,82,0.55)",
  desktop: "0 16px 36px -18px rgba(29,85,82,0.55)",
} as const;

const X_TICKS_DAY = {
  mobile: ["06:00", "10:00", "14:00", "18:00", "21:00"],
  tablet: ["06:00", "10:00", "14:00", "18:00", "21:00"],
  desktop: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
} as const;

export function CashflowCard({
  variant,
  day,
  week,
  period,
  onPeriodChange,
  style,
}: {
  variant: CashflowVariant;
  day: Load<CashflowSeries>;
  week: Load<CashflowSeries> | null;
  period: CashflowPeriod;
  onPeriodChange: (next: CashflowPeriod) => void;
  style?: CSSProperties;
}) {
  const g = GEOMETRY[variant];
  const [infoOpen, setInfoOpen] = useState(false);
  const infoId = useId();

  const series: Load<CashflowSeries> = period === "week" && week ? week : day;
  const value = series.state === "ready" ? series.value : null;
  // The picked bar belongs to the series it was picked on; a different series
  // (day ↔ week) starts again from its own default bar.
  const seriesKey = value ? `${value.period}:${value.bars.length}` : series.state;
  const [pick, setPick] = useState<{ key: string; index: number } | null>(null);
  const selected = pick && pick.key === seriesKey ? pick.index : (value?.defaultIndex ?? 0);
  const setSelected = (index: number) => setPick({ key: seriesKey, index });

  const net = value ? netOf(value) : null;
  const unitWord = period === "week" ? "השבוע" : "היום";
  const bar = value?.bars[Math.min(selected, (value?.bars.length ?? 1) - 1)] ?? null;
  const readoutLead = period === "week" ? "ביום" : "בשעה";

  const header = (
    <div style={{ display: "flex", flexWrap: variant === "desktop" ? "wrap" : undefined, gap: variant === "desktop" ? 12 : undefined, alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {variant === "desktop" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>הכנסות והוצאות</h2>
            <div style={{ fontSize: 13, color: "#CFE3E2" }}>
              {value?.expenseByBar || period === "day" ? "לחיצה על עמודה מציגה את פירוט השעה" : null}
            </div>
          </div>
        ) : variant === "tablet" ? (
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 500 }}>הכנסות והוצאות</h2>
        ) : (
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 500 }}>הכנסות והוצאות</h2>
        )}
        <button
          type="button"
          aria-label="על מה מבוססים המספרים"
          aria-expanded={infoOpen}
          aria-controls={infoId}
          onClick={() => setInfoOpen((o) => !o)}
          style={{
            width: 44,
            height: 44,
            margin: "-10px -6px",
            padding: 0,
            border: 0,
            background: "transparent",
            color: "#CFE3E2",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            alignSelf: variant === "desktop" ? "flex-start" : undefined,
          }}
        >
          <IconInfo size={16} strokeWidth={2} />
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {variant === "desktop" ? (
          <div style={{ display: "flex", gap: 14, fontSize: 13, color: "#DDECEB" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: INCOME }} />
              הכנסות
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: EXPENSE }} />
              הוצאות
            </span>
          </div>
        ) : null}
        <PeriodSwitch variant={variant} period={period} weekFailed={week?.state === "failed"} onChange={onPeriodChange} />
      </div>
    </div>
  );

  const info = infoOpen ? (
    <p id={infoId} style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "#DDECEB", background: "rgba(255,255,255,0.10)", borderRadius: 14, padding: "10px 12px" }}>
      המספרים מבוססים על הכספים ש-Dubiz יודע עליהם: הכנסות הן תשלומים שנגבו ואומתו דרך Dubiz, והוצאות הן תשלומי
      התחייבויות שנרשמו ב-Dubiz. מזומן, צ׳קים והעברות שלא עברו דרך Dubiz לא נכללים. נטו הוא הכנסות פחות הוצאות.
      {period === "day" ? " בתצוגה לפי שעה מוצגות עמודות הכנסה בלבד, כי שעת התשלום של הוצאה לא נשמרת." : null}
    </p>
  ) : null;

  const netBlock = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 13, color: "#CFE3E2" }}>נטו {unitWord}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 500, color: "#CFE3E2" }}>₪</span>
        <span style={{ fontSize: variant === "tablet" ? 46 : 44, fontWeight: 600, letterSpacing: -1, lineHeight: 1 }}>
          {series.state === "loading" ? <Shimmer w={120} h={40} /> : net === null ? "—" : formatNumber(net)}
        </span>
      </div>
    </div>
  );

  const split = (
    <div
      style={
        variant === "tablet"
          ? { display: "flex", gap: 10 }
          : { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }
      }
    >
      <SplitTile variant={variant} dot={INCOME} label="הכנסות" value={series.state === "loading" ? null : value ? formatShekel(value.income) : "—"} />
      <SplitTile
        variant={variant}
        dot={EXPENSE}
        label="הוצאות"
        value={series.state === "loading" ? null : value && value.expense !== null ? formatShekel(value.expense) : "—"}
      />
    </div>
  );

  const readout =
    value && bar ? (
      variant === "desktop" ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }} aria-live="polite">
          <span style={{ borderRadius: 999, background: "rgba(255,255,255,0.14)", padding: "6px 14px", fontSize: 14 }}>
            {readoutLead} <span style={{ fontWeight: 600 }}>{bar.label}</span>
          </span>
          <span style={{ borderRadius: 999, background: "rgba(155,228,227,0.18)", color: "#BFF0EF", padding: "6px 14px", fontSize: 14, fontWeight: 500 }}>
            הכנסות {formatShekel(bar.income)}
          </span>
          {bar.expense !== null ? (
            <span style={{ borderRadius: 999, background: "rgba(242,185,122,0.18)", color: "#F8D3A8", padding: "6px 14px", fontSize: 14, fontWeight: 500 }}>
              הוצאות {formatShekel(bar.expense)}
            </span>
          ) : null}
        </div>
      ) : (
        <div
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 13,
            color: "#DDECEB",
            borderTop: "1px solid rgba(255,255,255,0.12)",
            paddingTop: variant === "tablet" ? 12 : 4,
          }}
        >
          <span style={{ paddingTop: variant === "mobile" ? 10 : 0 }}>
            {readoutLead} <span style={{ color: "#FFFFFF", fontWeight: 600 }}>{bar.label}</span>
          </span>
          <span style={{ display: "flex", gap: 12, paddingTop: variant === "mobile" ? 10 : 0 }}>
            <span style={{ color: INCOME, fontWeight: 500 }}>+{formatShekel(bar.income)}</span>
            {bar.expense !== null ? <span style={{ color: EXPENSE, fontWeight: 500 }}>−{formatShekel(bar.expense)}</span> : null}
          </span>
        </div>
      )
    ) : null;

  const chart =
    series.state === "ready" ? (
      variant === "desktop" ? (
        <DesktopChart series={series.value} selected={selected} onSelect={setSelected} />
      ) : (
        <CompactChart variant={variant} series={series.value} selected={selected} onSelect={setSelected} />
      )
    ) : (
      <div
        style={{
          height: g.height,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          color: "#CFE3E2",
          textAlign: "center",
        }}
      >
        {series.state === "loading" ? (
          <Shimmer w="100%" h={g.height - 20} />
        ) : period === "week" ? (
          "לא הצלחנו לטעון את נתוני השבוע. אפשר לחזור לתצוגת היום."
        ) : (
          "לא הצלחנו לטעון את ההכנסות כרגע."
        )}
      </div>
    );

  return (
    <section
      aria-label="הכנסות והוצאות"
      style={{
        borderRadius: g.cardRadius,
        padding: g.pad,
        background: GRADIENT,
        color: "#FFFFFF",
        display: "flex",
        flexDirection: "column",
        gap: g.gap,
        boxShadow: SHADOW[variant],
        minWidth: 0,
        ...style,
      }}
    >
      {header}
      {info}
      {variant === "mobile" ? (
        <>
          {netBlock}
          {split}
        </>
      ) : variant === "tablet" ? (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap" }}>
          {netBlock}
          {split}
        </div>
      ) : null}
      {readout}
      {chart}
      {series.state === "ready" && variant !== "desktop" ? <XAxis ticks={xTicks(series.value, variant)} size={11} marginTop={-6} /> : null}
    </section>
  );
}

function xTicks(series: CashflowSeries, variant: CashflowVariant): string[] {
  if (series.period === "week") return series.bars.map((b) => b.label);
  return [...X_TICKS_DAY[variant]];
}

function XAxis({ ticks, size, marginTop }: { ticks: string[]; size: number; marginTop: number }) {
  return (
    <div dir="ltr" aria-hidden style={{ display: "flex", justifyContent: "space-between", fontSize: size, color: "#CFE3E2", marginTop }}>
      {ticks.map((t) => (
        <span key={t}>{t}</span>
      ))}
    </div>
  );
}

function SplitTile({ variant, dot, label, value }: { variant: CashflowVariant; dot: string; label: string; value: string | null }) {
  return (
    <div
      style={{
        borderRadius: 16,
        padding: variant === "tablet" ? "12px 16px" : "12px 14px",
        background: "rgba(255,255,255,0.10)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#DDECEB" }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: dot }} />
        {label}
      </div>
      <div style={{ fontSize: variant === "tablet" ? 19 : 20, fontWeight: 600 }}>
        {value === null ? <Shimmer w={80} h={20} /> : value}
      </div>
    </div>
  );
}

function PeriodSwitch({
  variant,
  period,
  weekFailed,
  onChange,
}: {
  variant: CashflowVariant;
  period: CashflowPeriod;
  weekFailed: boolean;
  onChange: (p: CashflowPeriod) => void;
}) {
  const pad = variant === "mobile" ? "6px 14px" : "7px 16px";
  const options: Array<{ key: CashflowPeriod; label: string; disabled: boolean; reason?: string }> = [
    { key: "day", label: "יום", disabled: false },
    { key: "week", label: "שבוע", disabled: weekFailed, reason: "נתוני השבוע לא נטענו" },
    // TODO(future): month needs a per-day income series for the whole month.
    { key: "month", label: "חודש", disabled: true, reason: "עדיין אין פירוט חודשי" },
  ];
  return (
    <div role="group" aria-label="תקופה" style={{ display: "flex", gap: 2, padding: 3, borderRadius: 999, background: "rgba(255,255,255,0.12)" }}>
      {options.map((o) => {
        const active = period === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            title={o.disabled ? o.reason : undefined}
            onClick={() => onChange(o.key)}
            style={{
              border: 0,
              borderRadius: 999,
              padding: pad,
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              background: active ? "#FFFFFF" : "transparent",
              color: active ? "#1D5552" : "#DDECEB",
              cursor: o.disabled ? "default" : "pointer",
              opacity: o.disabled ? 0.45 : 1,
              fontFamily: "inherit",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function barAria(series: CashflowSeries, i: number): string {
  const b = series.bars[i];
  const parts = [b.label, `הכנסות ${formatShekel(b.income)}`];
  if (b.expense !== null) parts.push(`הוצאות ${formatShekel(b.expense)}`);
  return parts.join(", ");
}

function CompactChart({
  variant,
  series,
  selected,
  onSelect,
}: {
  variant: "mobile" | "tablet";
  series: CashflowSeries;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const g = GEOMETRY[variant];
  const scale = barScale(series.bars, g.inc, g.exp);
  return (
    <div dir="ltr" style={{ position: "relative", height: g.height }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: g.zero, height: 1, background: "rgba(255,255,255,0.28)" }} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "stretch",
          gap: variant === "tablet" ? 4 : undefined,
        }}
      >
        {series.bars.map((b, i) => {
          const on = i === selected;
          return (
            <button
              key={b.key}
              type="button"
              aria-label={barAria(series, i)}
              aria-pressed={on}
              onClick={() => onSelect(i)}
              style={{
                width: variant === "mobile" && series.period === "day" ? 16 : undefined,
                flex: variant === "mobile" && series.period === "day" ? undefined : 1,
                minWidth: 0,
                padding: 0,
                border: 0,
                background: "none",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              <span style={{ height: g.inc, width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }}>
                <span
                  style={{
                    display: "block",
                    width: g.barW,
                    maxWidth: g.barMax,
                    height: barPx(b.income, scale),
                    borderRadius: `${g.radius}px ${g.radius}px 2px 2px`,
                    background: on ? INCOME : INCOME_DIM,
                  }}
                />
              </span>
              <span style={{ height: 4 }} />
              <span style={{ height: g.exp, width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "center" }}>
                <span
                  style={{
                    display: "block",
                    width: g.barW,
                    maxWidth: g.barMax,
                    height: barPx(b.expense, scale),
                    borderRadius: `2px 2px ${g.radius}px ${g.radius}px`,
                    background: on ? EXPENSE : EXPENSE_DIM,
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const DESKTOP_INCOME_PX = 162;
const DESKTOP_EXPENSE_PX = 78;

function DesktopChart({
  series,
  selected,
  onSelect,
}: {
  series: CashflowSeries;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const g = GEOMETRY.desktop;
  const axis = chartAxis(series.bars, DESKTOP_INCOME_PX, DESKTOP_EXPENSE_PX);
  const lineY = (v: number) => g.zero - v * axis.scale;
  return (
    <div dir="ltr" style={{ display: "flex", gap: 10 }}>
      <div aria-hidden style={{ width: 34, position: "relative", fontSize: 11, color: "#CFE3E2" }}>
        {axis.ticks.map((t) => (
          <span key={t.value} style={{ position: "absolute", left: 0, top: lineY(t.value) - 6 }}>
            {t.label}
          </span>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ position: "relative", height: g.height }}>
          {axis.ticks
            .filter((t) => t.value !== 0)
            .map((t) => (
              <div
                key={t.value}
                aria-hidden
                style={{ position: "absolute", left: 0, right: 0, top: lineY(t.value), borderTop: "1px dashed rgba(255,255,255,0.14)" }}
              />
            ))}
          <div aria-hidden style={{ position: "absolute", left: 0, right: 0, top: g.zero, height: 1, background: "rgba(255,255,255,0.32)" }} />
          <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "space-between", gap: 8 }}>
            {series.bars.map((b, i) => {
              const on = i === selected;
              return (
                <button
                  key={b.key}
                  type="button"
                  aria-label={barAria(series, i)}
                  aria-pressed={on}
                  onClick={() => onSelect(i)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: 0,
                    border: 0,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    borderRadius: 10,
                    background: on ? "rgba(255,255,255,0.08)" : "transparent",
                  }}
                >
                  <span style={{ height: g.inc, width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center" }}>
                    <span
                      style={{
                        display: "block",
                        width: g.barW,
                        maxWidth: g.barMax,
                        height: barPx(b.income, axis.scale),
                        borderRadius: "6px 6px 2px 2px",
                        background: on ? INCOME : INCOME_DIM,
                      }}
                    />
                  </span>
                  <span style={{ height: 4 }} />
                  <span style={{ height: g.exp, width: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-start", alignItems: "center" }}>
                    <span
                      style={{
                        display: "block",
                        width: g.barW,
                        maxWidth: g.barMax,
                        height: Math.min(barPx(b.expense, axis.scale), g.exp),
                        borderRadius: "2px 2px 6px 6px",
                        background: on ? EXPENSE : EXPENSE_DIM,
                      }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <XAxis ticks={xTicks(series, "desktop")} size={12} marginTop={0} />
      </div>
    </div>
  );
}

function Shimmer({ w, h }: { w: number | string; h: number }) {
  return (
    <span
      aria-hidden
      className="animate-pulse"
      style={{ display: "inline-block", width: w, height: h, borderRadius: 10, background: "rgba(255,255,255,0.14)", verticalAlign: "middle" }}
    />
  );
}
