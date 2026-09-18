/**
 * Home view-model — the pure half of the home screen.
 *
 * Everything here is a derivation from data the product already returns. There
 * is no default, no placeholder and no "typical" value: a figure with no source
 * is not rendered at all, and a verdict we could not load is reported as a
 * failure to load rather than guessed. `home-model.test.ts` locks that.
 *
 * Sources, all read-only and all already live on main:
 *   GET /api/obligations/briefing          -> the verdict + obligations due
 *   GET /api/business-status               -> the open exceptions, by domain
 *   GET /api/payments/collection-workspace -> collection counts
 *   GET /api/documents/inbox?summaryOnly=1 -> documents awaiting review
 */

import type { BusinessStatusItem, Severity } from "@/lib/business-status/types";
import type {
  BriefingApi,
  MorningState,
  ObligationApi,
} from "@/lib/obligations/secretary-client";
import type { StatusDomain, ToolGroup } from "@/lib/navigation/home-routes";

/* -------------------------------------------------------- load states -- */

/** How a source Home depends on is doing. One of exactly three things. */
export type LoadState<T> =
  | { state: "loading" }
  | { state: "ready"; value: T }
  | { state: "failed" };

/**
 * What a counter can truthfully say — and the reason this is a union rather
 * than `number | null`.
 *
 * Those two used to collapse: a still-in-flight request and a failed one both
 * became `null`, and `null` rendered as "לא נטען". So during the window between
 * the skeleton clearing and the secondary sources answering, four counters
 * announced a failure that had not happened. A real-data run against a cold
 * serverless function is what made that window long enough to see.
 *
 * LOADING ≠ FAILED ≠ SUCCESS(0). A legitimate zero is an answer and must render
 * as `0`; only an actual failure may say it did not load.
 */
export type CounterValue =
  | { state: "loading" }
  | { state: "ready"; value: number }
  | { state: "failed" };

/**
 * Maps a source's load state onto what its counter may claim. `pick` is a thunk
 * so the figure is only read when there genuinely is one.
 */
export function counterFrom<T>(
  loaded: LoadState<T>,
  pick: (value: T) => number
): CounterValue {
  if (loaded.state === "failed") return { state: "failed" };
  if (loaded.state === "ready") return { state: "ready", value: pick(loaded.value) };
  return { state: "loading" };
}

/* ----------------------------------------------------------- greeting -- */

/**
 * Time-of-day greeting, computed from the viewer's own clock. Kept client-side
 * deliberately: a server hour is the wrong timezone for the owner.
 */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "בוקר טוב";
  if (hour >= 12 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}

/* ------------------------------------------------------------ verdict -- */

export type VerdictTone = "calm" | "busy" | "critical" | "settling";

export type VerdictView = {
  tone: VerdictTone;
  /** The state chip, e.g. "דחוף". */
  badge: string;
  /** One sentence — the conclusion, carrying the owner's own numbers. */
  sentence: string;
  /** The single action for this state. */
  ctaLabel: string;
};

const TONE_BY_STATE: Record<MorningState, VerdictTone> = {
  CALM: "calm",
  BUSY: "busy",
  CRITICAL: "critical",
  STILL_SETTLING_IN: "settling",
};

/**
 * The secretary's line. Conclusion first, then the evidence for it, in the
 * owner's own figures. `STILL_SETTLING_IN` deliberately never becomes "you are
 * covered" — the briefing engine returns it precisely so a business with no
 * history is not told it is in control.
 */
export function buildVerdict(briefing: BriefingApi): VerdictView {
  const tone = TONE_BY_STATE[briefing.state];
  const { breakToday, attention, watching } = briefing.counts;

  if (tone === "critical") {
    return {
      tone,
      badge: "דחוף",
      sentence:
        breakToday === 1
          ? "יש התחייבות אחת שנשברת היום."
          : `יש ${breakToday} התחייבויות שנשברות היום.`,
      ctaLabel: "לטפל עכשיו",
    };
  }

  if (tone === "busy") {
    return {
      tone,
      badge: "עמוס",
      sentence:
        attention === 1
          ? "דבר אחד מבקש אותך היום, ואף אחד לא נשבר."
          : `${attention} דברים מבקשים אותך היום, ואף אחד לא נשבר.`,
      ctaLabel: "בוא נתחיל",
    };
  }

  if (tone === "settling") {
    return {
      tone,
      badge: "עדיין מתמקמים",
      // Never the word "covered", in any grammatical form: a skimmed line is
      // the line the owner acts on, and this state exists precisely because we
      // cannot yet make that claim.
      sentence:
        watching === 0
          ? "אני עוד לומדת את העסק. עדיין מוקדם לי להגיד לך שהכול בשליטה."
          : watching === 1
            ? "אני עוד לומדת את העסק. התחייבות אחת בהשגחה שלי."
            : `אני עוד לומדת את העסק. ${watching} התחייבויות בהשגחה שלי.`,
      ctaLabel: "מה בהשגחה",
    };
  }

  return {
    tone,
    badge: "רגוע",
    sentence:
      watching === 0
        ? "אתה מכוסה. אין היום משהו שנשבר."
        : watching === 1
          ? "אתה מכוסה. התחייבות אחת בהשגחה שלי, והיא לא נשברת היום."
          : `אתה מכוסה. ${watching} התחייבויות בהשגחה שלי, אף אחת לא נשברת היום.`,
    ctaLabel: "מה בהשגחה",
  };
}

/* ---------------------------------------------------------- due dates -- */

export type DueBadge = "late" | "today" | "tomorrow";

export const DUE_BADGE_LABEL: Record<DueBadge, string> = {
  late: "באיחור",
  today: "היום",
  tomorrow: "מחר",
};

/** Midnight of `d`, in the viewer's own timezone. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * `null` for anything past tomorrow: the section shows what has a date the
 * owner can act on now, and a badge reading "in 9 days" would be a countdown,
 * not a deadline.
 */
export function dueBadgeFor(dueAtIso: string, now: Date): DueBadge | null {
  const due = new Date(dueAtIso);
  if (Number.isNaN(due.getTime())) return null;

  const today = startOfLocalDay(now);
  const dueDay = startOfLocalDay(due);
  const dayMs = 24 * 60 * 60 * 1000;

  if (dueDay < today) return "late";
  if (dueDay === today) return "today";
  if (dueDay === today + dayMs) return "tomorrow";
  return null;
}

export type TodayRow = {
  obligationId: number;
  title: string;
  amount: string;
  currency: string;
  dueAtIso: string;
  badge: DueBadge;
};

/** A trustworthy display name — the Secretary's own rule, applied identically. */
function displayObligeeName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : "התחייבות ללא שם";
}

function toTodayRow(obligation: ObligationApi, badge: DueBadge): TodayRow {
  return {
    obligationId: obligation.id,
    title: displayObligeeName(obligation.obligeeName),
    amount: obligation.amount,
    currency: obligation.currency,
    dueAtIso: obligation.dueAt,
    badge,
  };
}

/**
 * "היום שלך" — the obligations whose date has arrived (or passed), soonest
 * first.
 *
 * Obligations only. Documents carry no due date anywhere in the product: a
 * `Document` has a creation date, and the awaiting-payment list deliberately
 * exposes `issuedAt` and never a deadline. A document row here would have to
 * invent the date it is sorted and badged by.
 */
export function buildTodayRows(briefing: BriefingApi, now: Date): TodayRow[] {
  const rows: TodayRow[] = [];
  for (const item of briefing.attention) {
    const badge = dueBadgeFor(item.obligation.dueAt, now);
    if (!badge) continue;
    rows.push(toTodayRow(item.obligation, badge));
  }
  return rows.sort(
    (a, b) => new Date(a.dueAtIso).getTime() - new Date(b.dueAtIso).getTime()
  );
}

/** The "תשלומים למועד" counter — obligations already at or past their date. */
export function countObligationsDue(briefing: BriefingApi, now: Date): number {
  return briefing.attention.filter((item) => {
    const badge = dueBadgeFor(item.obligation.dueAt, now);
    return badge === "late" || badge === "today";
  }).length;
}

/* ------------------------------------------------------ group status -- */

export type GroupStatusTone = "clear" | "review" | "urgent";

export type GroupStatus = {
  tone: GroupStatusTone;
  label: string;
};

const URGENT: Severity[] = ["CRITICAL", "HIGH"];

/**
 * A group's status label.
 *
 * Deliberately a LABEL and not a count. `getBusinessStatusSnapshot` caps every
 * domain (documents 15, inbox 12+12, billing 8+8, inventory 15, supplier 8,
 * leads 8, then a global 50), so a number taken from it can only ever be too
 * low — and a tile that under-reports says "handled" about work that is not.
 * A label stays true under every cap: if the list was capped there is at least
 * one item, which is exactly what "דורש טיפול" claims.
 */
export function groupStatus(
  items: BusinessStatusItem[],
  domains: StatusDomain[]
): GroupStatus {
  const domainSet = new Set<string>(domains);
  const mine = items.filter((item) => domainSet.has(item.domain));

  if (mine.length === 0) return { tone: "clear", label: "הכול מטופל" };
  if (mine.some((item) => URGENT.includes(item.severity))) {
    return { tone: "urgent", label: "דורש טיפול עכשיו" };
  }
  return { tone: "review", label: "יש מה לבדוק" };
}

export function groupStatusFor(
  items: BusinessStatusItem[],
  group: ToolGroup
): GroupStatus {
  return groupStatus(items, group.domains);
}

/* --------------------------------------------------------- formatting -- */

/** Whole shekels, grouped. Amounts arrive as exact decimal strings. */
export function formatAmount(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  const symbol = currency === "ILS" ? "₪" : "";
  return `${symbol}${Math.round(n).toLocaleString("he-IL")}`;
}

/** "12 בספטמבר" — a date, never a countdown. */
export function formatDueDate(dueAtIso: string): string {
  const d = new Date(dueAtIso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "long" });
}
