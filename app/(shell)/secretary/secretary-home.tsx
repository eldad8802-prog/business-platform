"use client";

/**
 * "המזכירה שלי" — the main screen as management stations (owner-approved mockup, 24.10.2026).
 *
 * Top to bottom: title and date · the two create actions · the day-cost card · three management stations
 * (התחייבויות, משימות, לוח שנה) · the week strip. Nothing else: the summary cards, "מה מחכה לך היום" and the
 * long lists left this screen; every inner screen and flow stays where it was.
 *
 *   - "הוסף משימה" (Dubiz primary green) opens the task centre's own create form (/tasks?new=1) and shows only
 *     once daily_tasks is known to be ON.
 *   - "הוסף התחייבות" (light sand) opens the P3 flow at its first step (?screen=bank), the one create path.
 *   - The day cost is the server's calendar-day figure (baseline.calendarDay.daily). "לפירוט" opens the existing
 *     breakdown drawer. No per-day history exists, so no chart is drawn: the card shows the two server figures
 *     the day cost is made of (the monthly fixed cost and the days in the month).
 *   - The week strip marks tasks and commitment dates from the existing reads (secretary-hub-model); a day opens
 *     the full month at that day (?screen=calendar&day=…).
 * Leads are not the Secretary's: the hub reads manual tasks only.
 */

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { formatIls } from "@/components/business-cost/BusinessCostCard";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { BriefingApi } from "@/lib/obligations/secretary-client";
import { SecretaryWeek } from "./secretary-calendar";
import { SecretaryCostDrawer } from "./secretary-cost-drawer";
import { useHubData } from "./secretary-hub-data";
import { calendarEvents } from "./secretary-hub-model";
import { ownerErrorText } from "./secretary-home-model";
import { secretaryVars } from "./secretary-ui";
import s from "./secretary-home.module.css";

export const HREF = {
  bank: "/secretary?screen=bank",
  newTask: "/tasks?new=1",
  tasks: "/tasks",
  payables: "/payables",
  calendar: "/secretary?screen=calendar",
  profile: "/profile",
};

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

function dayLabel(now: Date): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long" }).format(now);
}

export function SecretaryHome({ briefing, now = new Date() }: { briefing: BriefingApi; now?: Date }) {
  const data = useHubData(briefing.generatedAt);
  const [costOpen, setCostOpen] = useState(false);
  const tasksOn = Array.isArray(data.tasks) || data.tasks === "unavailable";
  const summary = typeof data.summary === "object" ? data.summary : null;
  const obligations = typeof data.obligations === "object" ? data.obligations.list : [];
  const events = calendarEvents({ obligations, tasks: Array.isArray(data.tasks) ? data.tasks : [], summary });

  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-labelledby="secretary-title">
      <Header now={now} />
      <Actions tasksOn={tasksOn} />
      <CostCard summary={data.summary} onDetails={() => setCostOpen(true)} />
      <Stations tasksOn={data.tasks !== "off"} />
      <SecretaryWeek events={events} loading={data.obligations === "loading"} failed={data.obligations === "unavailable"} />
      <SecretaryCostDrawer open={costOpen} onClose={() => setCostOpen(false)} summary={summary} />
    </main>
  );
}

function Header({ now }: { now: Date }) {
  return (
    <header className={s.head}>
      <div className={s.headText}>
        <p className={s.date}>{dayLabel(now)}</p>
        <h1 id="secretary-title" className={s.title}>המזכירה שלי</h1>
        <p className={s.subtitle}>ניהול המשימות וההתחייבויות של העסק</p>
      </div>
      <Link href={HREF.profile} className={s.avatar} aria-label="הפרופיל שלי">
        <PersonIcon />
      </Link>
    </header>
  );
}

function Actions({ tasksOn }: { tasksOn: boolean }) {
  return (
    <nav className={cx(s.actions, !tasksOn && s.actionsOne)} aria-label="פעולות ראשיות">
      {/* The one way to create a commitment: the P3 flow, from its first step. */}
      <Link href={HREF.bank} className={cx(s.action, s.actionSand)}>
        <PlusIcon />
        <span>הוסף התחייבות</span>
      </Link>
      {/* The task centre's own create form; only where daily_tasks is ON. */}
      {tasksOn ? (
        <Link href={HREF.newTask} className={cx(s.action, s.actionGreen)}>
          <PlusIcon />
          <span>הוסף משימה</span>
        </Link>
      ) : null}
    </nav>
  );
}

function CostCard({ summary, onDetails }: { summary: ReturnType<typeof useHubData>["summary"]; onDetails: () => void }) {
  const { locale } = useI18n();
  const ils = (d: string) => formatIls(d, locale);
  const ready = typeof summary === "object" && summary.baseline.completeness.state !== "EMPTY" ? summary : null;
  const monthName =
    ready && /^\d{4}-\d{2}$/.test(ready.baseline.calendarDay.month)
      ? new Intl.DateTimeFormat("he-IL", { month: "long", timeZone: "UTC" }).format(new Date(`${ready.baseline.calendarDay.month}-15T12:00:00Z`))
      : null;

  return (
    <section className={s.cost} aria-labelledby="sec-cost-title" aria-busy={summary === "loading" || undefined}>
      <div className={s.costMain}>
        <span className={s.costIcon} aria-hidden="true"><WalletIcon /></span>
        <div className={s.costText}>
          <h2 id="sec-cost-title" className={s.costTitle}>
            עלות יומית של העסק
            <InfoIcon />
          </h2>
          {summary === "loading" ? (
            <span className={s.skel} style={{ blockSize: 40, inlineSize: 140 }} />
          ) : ready ? (
            <p className={s.costValue}><bdi>{ils(ready.baseline.calendarDay.daily)}</bdi></p>
          ) : (
            <p className={s.costNone}>—</p>
          )}
          <p className={s.costNote}>
            {summary === "unavailable"
              ? "לא הצלחתי לטעון את העלות היומית. אפשר לנסות שוב בעוד רגע."
              : summary !== "loading" && !ready
                ? "עוד אין הוצאות קבועות רשומות, ולכן אין עלות יומית."
                : "עלות תפעול מחושבת, לא תשלום בפועל"}
          </p>
          {ready ? (
            <button type="button" className={s.pill} onClick={onDetails} aria-haspopup="dialog">
              לפירוט
              <ChevronIcon />
            </button>
          ) : null}
        </div>
      </div>
      {/* What the day cost is made of — two server figures, never a made-up history. */}
      {ready ? (
        <dl className={s.costFacts}>
          <div>
            <dt>הוצאות קבועות לחודש</dt>
            <dd><bdi>{ils(ready.baseline.monthly)}</bdi></dd>
          </div>
          <div>
            <dt>{monthName ? `ימים ב${monthName}` : "ימים בחודש"}</dt>
            <dd>{ready.baseline.calendarDay.daysInMonth.toLocaleString("he-IL")}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function Stations({ tasksOn }: { tasksOn: boolean }) {
  const items: Array<{ key: string; href: string; title: string; sub: string; icon: ReactNode; sand?: boolean }> = [
    { key: "payables", href: HREF.payables, title: "התחייבויות", sub: "ניהול כל ההתחייבויות של העסק", icon: <WalletIcon />, sand: true },
    ...(tasksOn ? [{ key: "tasks", href: HREF.tasks, title: "משימות", sub: "ניהול כל המשימות של העסק", icon: <ListIcon /> }] : []),
    { key: "calendar", href: HREF.calendar, title: "לוח שנה", sub: "צפייה וניהול כל המשימות וההתחייבויות", icon: <CalendarIcon /> },
  ];
  return (
    <section className={s.stationsWrap} aria-labelledby="sec-stations-title">
      <h2 id="sec-stations-title" className={s.secTitle}>תחנות ניהול</h2>
      <ul className={cx(s.stations, items.length === 2 && s.stationsTwo)}>
        {items.map((it) => (
          <li key={it.key}>
            <Link href={it.href} className={s.station}>
              <span className={cx(s.stationIcon, it.sand && s.stationIconSand)} aria-hidden="true">{it.icon}</span>
              <span className={s.stationTitle}>{it.title}</span>
              <span className={s.stationSub}>{it.sub}</span>
              <span className={s.stationChev} aria-hidden="true"><ChevronIcon /></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Loading: the same structure, so the screen does not jump when data lands. */
export function SecretaryHomeLoading() {
  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-busy="true" aria-label="טוען את המזכירה">
      <Header now={new Date()} />
      <div className={s.actions}>
        <span className={s.skel} style={{ blockSize: 88 }} />
        <span className={s.skel} style={{ blockSize: 88 }} />
      </div>
      <span className={s.skel} style={{ blockSize: 170, borderRadius: 20 }} />
      <span className={s.skel} style={{ blockSize: 150, borderRadius: 20 }} />
    </main>
  );
}

/** Load failure of the main screen: said in Hebrew, with a retry that reports its own failure. */
export function SecretaryHomeLoadError({ message, onRetry }: { message: string | null; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [again, setAgain] = useState<string | null>(null);
  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-labelledby="secretary-title">
      <Header now={new Date()} />
      <section className={s.loadError} role="alert">
        <h2>לא הצלחתי לטעון את המזכירה.</h2>
        <p>{again ?? ownerErrorText(new Error(message ?? ""), "החיבור לשרת נכשל. אפשר לנסות שוב בעוד רגע.")}</p>
        <button
          type="button"
          className={cx(s.retry)}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setAgain(null);
            try {
              await onRetry();
            } catch (e) {
              setAgain(ownerErrorText(e, "גם הניסיון החוזר נכשל. אפשר לנסות שוב בעוד רגע."));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "רגע…" : "לנסות שוב"}
        </button>
      </section>
    </main>
  );
}

// ── Icons (stroke, 24px grid, currentColor) ─────────────────────────────

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.4 19c0-3.7 3-6.2 6.6-6.2s6.6 2.5 6.6 6.2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="6" width="17" height="13" rx="2.5" />
      <path d="M3.5 9.5h17M16 14h1.5" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="5" cy="7" r="0.9" fill="currentColor" />
      <circle cx="5" cy="12" r="0.9" fill="currentColor" />
      <circle cx="5" cy="17" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

/** Points to the row target: left in RTL. */
export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
