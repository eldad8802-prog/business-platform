"use client";

/**
 * "המזכירה שלי" — the main screen as management stations (owner-approved mockup, 24.10.2026).
 *
 * Top to bottom: title and date · the two create actions · the day-cost card · three management stations
 * (התחייבויות, משימות, לוח שנה) · "תורים היום" (only with appointments ON — Appointments milestone B) · the week strip. Nothing else: the summary cards, "מה מחכה לך היום" and the
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
import { noteHand } from "./secretary-fonts";
import { calendarEvents, todayAppointments, type HubAppointment } from "./secretary-hub-model";
import { clockOf, KIND_LABEL } from "@/features/calendar/calendar-model";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";
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
  const appointments = Array.isArray(data.appointments) ? data.appointments : [];
  const events = calendarEvents({ obligations, tasks: Array.isArray(data.tasks) ? data.tasks : [], summary, appointments });

  return (
    <main className={cx(s.page, noteHand.variable)} style={secretaryVars()} dir="rtl" aria-labelledby="secretary-title">
      <Header now={now} />
      <Actions tasksOn={tasksOn} />
      <CostCard summary={data.summary} onDetails={() => setCostOpen(true)} />
      <Stations tasksOn={data.tasks !== "off"} />
      {data.appointments !== "off" ? <TodayAppointments state={data.appointments} now={now} /> : null}
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

  // Mockup layout (RTL): the clipped paper slip on the right, the figure in the middle, the icon and "לפירוט" on
  // the left.
  return (
    <section className={cx(s.cost, !ready && s.costNoSlip)} aria-labelledby="sec-cost-title" aria-busy={summary === "loading" || undefined}>
      {/* What the day cost is made of — two server figures on a clipped paper slip, never a made-up history. */}
      {ready ? (
        <div className={s.slipWrap}>
          <dl className={s.slip}>
            <div>
              <dt>הוצאות קבועות לחודש</dt>
              <dd><bdi>{ils(ready.baseline.monthly)}</bdi></dd>
            </div>
            <div>
              <dt>{monthName ? `ימי ${monthName}` : "ימי החודש"}</dt>
              <dd>{ready.baseline.calendarDay.daysInMonth.toLocaleString("he-IL")}</dd>
            </div>
          </dl>
          <span className={s.slipClip} aria-hidden="true"><PaperClip /></span>
        </div>
      ) : null}
      <div className={s.costText}>
        <h2 id="sec-cost-title" className={s.costTitle}>
          עלות יומית של העסק
          <InfoIcon />
        </h2>
        {summary === "loading" ? (
          <span className={s.skel} style={{ blockSize: 40, inlineSize: 120 }} />
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
              : "עלות תפעול מחושבת, לא תשלום בפועל."}
        </p>
      </div>
      <span className={s.costIcon} aria-hidden="true"><WalletIcon /></span>
      {ready ? (
        <button type="button" className={s.pill} onClick={onDetails} aria-haspopup="dialog">
          לפירוט
          <ChevronIcon />
        </button>
      ) : null}
    </section>
  );
}

type NoteKind = "sand" | "green" | "blue";
const NOTE_CLASS: Record<NoteKind, string> = { sand: s.noteSand, green: s.noteGreen, blue: s.noteBlue };
const NOTE_FASTENER: Record<NoteKind, ReactNode> = {
  sand: <span className={s.clip} aria-hidden="true"><PaperClip /></span>,
  green: <span className={s.pin} aria-hidden="true"><PushPin /></span>,
  blue: <span className={s.tape} aria-hidden="true" />,
};

/**
 * "תחנות ניהול" as the Secretary's reminder notes on her desk (owner-approved mockup): paper, a slight tilt, a
 * clip / pin / tape, a handwritten title. Each whole note is one link to an existing screen.
 */
function Stations({ tasksOn }: { tasksOn: boolean }) {
  const items: Array<{ key: string; href: string; title: string; sub: string; icon: ReactNode; kind: NoteKind }> = [
    { key: "payables", href: HREF.payables, title: "התחייבויות", sub: "מעקב ותשלומים", icon: <WalletIcon />, kind: "sand" },
    ...(tasksOn ? [{ key: "tasks", href: HREF.tasks, title: "משימות", sub: "ניהול וביצוע משימות", icon: <ListIcon />, kind: "green" as const }] : []),
    { key: "calendar", href: HREF.calendar, title: "לוח שנה", sub: "מועדים ותכנון", icon: <CalendarIcon />, kind: "blue" },
  ];
  return (
    <section className={s.stationsWrap} aria-labelledby="sec-stations-title">
      <h2 id="sec-stations-title" className={s.secTitle}>תחנות ניהול</h2>
      <ul className={cx(s.notes, items.length === 2 && s.notesTwo)}>
        {items.map((it) => (
          <li key={it.key} className={s.noteSlot}>
            <Link href={it.href} className={cx(s.note, NOTE_CLASS[it.kind])} aria-label={`${it.title} — ${it.sub}`}>
              {NOTE_FASTENER[it.kind]}
              <span className={s.noteIcon} aria-hidden="true">{it.icon}</span>
              <span className={s.noteTitle} aria-hidden="true">{it.title}</span>
              <span className={s.noteSub} aria-hidden="true">{it.sub}</span>
              <span className={s.noteArrow} aria-hidden="true"><ArrowIcon /></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Today's appointments — time and title; each row opens the appointment in the calendar (Appointments milestone B). */
function TodayAppointments({ state, now }: { state: HubAppointment[] | "loading" | "unavailable"; now: Date }) {
  const today = jerusalemDayKey(now);
  const list = Array.isArray(state) ? todayAppointments(state, today) : [];
  return (
    <section className={s.appts} aria-labelledby="sec-appts-title" aria-busy={state === "loading" || undefined}>
      <div className={s.apptHead}>
        <h2 id="sec-appts-title" className={s.apptTitle}>
          <CalendarIcon />
          תורים היום
          {list.length ? <span className={s.apptCount}>{list.length.toLocaleString("he-IL")}</span> : null}
        </h2>
        <Link href={`/calendar?view=day&day=${today}`} className={s.apptLink}>
          ליומן
          <ChevronIcon />
        </Link>
      </div>
      {state === "loading" ? (
        <span className={s.skel} style={{ blockSize: 40 }} />
      ) : state === "unavailable" ? (
        <p className={s.apptNone}>לא הצלחתי לטעון את התורים. אפשר לנסות שוב בעוד רגע.</p>
      ) : list.length ? (
        <ul className={s.apptList}>
          {list.slice(0, 6).map((a) => (
            <li key={a.id}>
              <Link href={`/calendar?view=day&day=${today}&appointment=${a.id}`} className={s.apptRow}>
                <span className={s.apptTime}>{a.endsAt && a.startsAt ? clockOf(new Date(a.startsAt)) : "—"}</span>
                <span className={s.apptName}>{a.title?.trim() || KIND_LABEL[a.kind]}</span>
                {a.status === "PROPOSED" ? <span className={s.apptWait}>ממתין לאישור</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.apptNone}>אין תורים היום.</p>
      )}
      {list.length > 6 ? <Link href={`/calendar?view=day&day=${today}`} className={s.apptLink}>ועוד {(list.length - 6).toLocaleString("he-IL")} ביומן</Link> : null}
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

/** "←" — the note's way in (RTL forward). */
function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}

/** A steel paperclip (local SVG, decorative). */
function PaperClip() {
  return (
    <svg viewBox="0 0 22 50" width="22" height="50" fill="none" aria-hidden="true">
      <path d="M7 33V11a5 5 0 0 1 10 0v26a8 8 0 0 1-16 0V15" stroke="#7d848a" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M7 33V11a5 5 0 0 1 10 0v26a8 8 0 0 1-16 0V15" stroke="#d9dde0" strokeWidth="1" strokeLinecap="round" transform="translate(-.6 -.6)" />
    </svg>
  );
}

/** A green push pin (local SVG, decorative). */
function PushPin() {
  return (
    <svg viewBox="0 0 34 40" width="34" height="40" aria-hidden="true">
      <path d="M17 24l-6 13" stroke="#8a9096" strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="18.5" cy="26" rx="7" ry="2.6" fill="#1e7a4a" />
      <path d="M13 10h11l-2 12h-7z" fill="#2a9a5e" />
      <ellipse cx="18.5" cy="9" rx="8" ry="5.5" fill="#33a866" />
      <ellipse cx="16" cy="7.5" rx="3" ry="1.6" fill="#8fdcae" opacity=".8" />
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
