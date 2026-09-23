/**
 * The collection area, as the screen needs it.
 *
 * The server answers in Israeli calendar windows; this turns that answer into a
 * series to draw, a sentence to read, and the honest load state around both.
 *
 * TRUTH RULES that live here rather than in the component, so they can be
 * tested without a browser:
 *   - a period in progress exposes only the points that have happened, so the
 *     chart physically cannot draw a future;
 *   - a comparison the data does not support is absent, not zero;
 *   - a failed read is `failed`, never an empty chart at ₪0.
 */

export type HomePeriodKey = "today" | "yesterday" | "week";

export type CollectionView =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "ready";
      period: HomePeriodKey;
      granularity: "hour" | "day";
      /** Cumulative ₪ at each point of the current window. */
      points: number[];
      /** How many leading points are real. Never more than the period has lived. */
      elapsedPoints: number;
      total: number;
      count: number;
      /** The whole previous window — the dashed line. */
      previousPoints: number[];
      /** The previous window measured only as far as this one has reached. */
      previousAtSamePoint: number;
      changePct: number | null;
      /** "15:25" while the period is in progress. */
      cutoffLabel: string | null;
      month: { amount: number; changePct: number | null } | null;
      /** The day labels the week view puts under its columns. */
      dayLabels: string[];
    };

export type CollectionWire = {
  timezone: string;
  period: HomePeriodKey;
  granularity: "hour" | "day";
  current: { points: string[]; elapsedPoints: number; total: string; count: number };
  previous: { points: string[]; elapsedPoints: number; total: string; count: number };
  previousAtSamePoint: string;
  changePct: number | null;
  cutoffLabel: string | null;
  window: { from: string; to: string };
  previousWindow: { from: string; to: string };
  month: { key: string; amount: string; count: number; previousAmount: string; changePct: number | null } | null;
};

const WEEKDAY = new Intl.DateTimeFormat("he-IL", { weekday: "narrow", timeZone: "Asia/Jerusalem" });

export function collectionViewFrom(wire: CollectionWire): CollectionView {
  const dayLabels =
    wire.granularity === "day"
      ? Array.from({ length: 7 }, (_, i) => {
          const [y, m, d] = wire.window.from.split("-").map(Number);
          // Noon keeps the label on its own day whatever the offset does.
          return WEEKDAY.format(new Date(Date.UTC(y, m - 1, d + i, 12)));
        })
      : [];

  return {
    state: "ready",
    period: wire.period,
    granularity: wire.granularity,
    points: wire.current.points.map(Number),
    elapsedPoints: wire.current.elapsedPoints,
    total: Number(wire.current.total),
    count: wire.current.count,
    previousPoints: wire.previous.points.map(Number),
    previousAtSamePoint: Number(wire.previousAtSamePoint),
    changePct: wire.changePct,
    cutoffLabel: wire.cutoffLabel,
    month: wire.month
      ? { amount: Number(wire.month.amount), changePct: wire.month.changePct }
      : null,
    dayLabels,
  };
}

export const PERIOD_TABS: { key: HomePeriodKey; label: string }[] = [
  { key: "today", label: "היום" },
  { key: "yesterday", label: "אתמול" },
  { key: "week", label: "שבוע" },
];

/** What the comparison line says, naming the window it is against. */
export function comparisonSentence(view: Extract<CollectionView, { state: "ready" }>): string | null {
  if (view.changePct === null) return null;
  if (view.period === "today") return `מול אתמול עד ${view.cutoffLabel}`;
  if (view.period === "yesterday") return "מול היום שלפניו";
  return "מול שבעת הימים שלפני כן";
}

/** The legend under the chart: what the two lines are. */
export function legendLabels(period: HomePeriodKey): { current: string; previous: string } {
  if (period === "today") return { current: "היום", previous: "אתמול" };
  if (period === "yesterday") return { current: "אתמול", previous: "שלשום" };
  return { current: "השבוע", previous: "השבוע שעבר" };
}
