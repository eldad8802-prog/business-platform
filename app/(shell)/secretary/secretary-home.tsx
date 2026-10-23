"use client";

/**
 * "המזכירה שלי" — the main screen: the management hub (version B, owner-approved 23.10.2026, on the B screen
 * of 22.10.2026).
 *
 * Two main actions — "הוסף התחייבות" opens the P3 flow at its first step (?screen=bank, the one create path);
 * "הוסף משימה" opens the task centre's own create form (/tasks?new=1) and shows only where daily_tasks is ON.
 * Four summary cards, then the work: "מה מחכה לך היום" (payments due now and today's tasks), "המשימות שלי",
 * "התחייבויות קרובות", history links, and the calendar in the side column. The day-cost card opens a drawer
 * with the existing cost card and its breakdown. Leads are not the Secretary's: they live on the home screen,
 * and the hub reads manual tasks only (secretary-hub-model).
 *
 * Flow is unchanged:
 *   - "סמן שטופל" calls the page's existing onCompleteFlow — the same "שילמת?"
 *     question, at the same step, for ledger items with money left; a direct
 *     close for legacy items. handled ≠ paid is untouched.
 *   - The "⋯" items open the existing screens (?screen=detail / remind /
 *     update); "כבר לא רלוונטי" opens the existing ReleaseControl under the row, which
 *     calls the existing onReleaseFlow.
 *   - A task's "בוצע" is the task centre's own complete action with the row's version.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { BriefingApi } from "@/lib/obligations/secretary-client";
import { taskAction } from "@/lib/tasks/tasks-client";
import { formatMoney } from "@/lib/ui/money";
import { SecretaryCalendar } from "./secretary-calendar";
import { SecretaryCostDrawer } from "./secretary-cost-drawer";
import { HUB_OBLIGATION_LIMIT, useHubData } from "./secretary-hub-data";
import { calendarEvents, hubCards, todayTasks, type HubCard, type HubTask } from "./secretary-hub-model";
import { ReleaseControl, secretaryVars } from "./secretary-ui";
import {
  STATUS_LABEL,
  dueDays,
  ownerErrorText,
  relativeDays,
  type HomeGroupKey,
  type HomeRow,
  type SecretaryHomeView,
} from "./secretary-home-model";
import s from "./secretary-home.module.css";
import h from "./secretary-hub.module.css";

const HREF = {
  today: "/secretary?today=1",
  all: "/secretary?screen=all",
  bank: "/secretary?screen=bank",
  newTask: "/tasks?new=1",
  tasks: "/tasks",
  payables: "/payables",
  watching: "/secretary?screen=watching",
  capture: "/secretary?screen=capture",
  detail: (id: number) => "/secretary?screen=detail&id=" + id,
  remind: (id: number) => "/secretary?screen=remind&id=" + id,
  update: (id: number) => "/secretary?screen=update&id=" + id,
};

export type SecretaryHomeActions = {
  /** The existing "טופל" flow (page.tsx onCompleteFlow). */
  onHandled: (obligationId: number) => Promise<void>;
  /** The existing release (page.tsx onReleaseFlow). */
  onRelease: (obligationId: number) => Promise<void>;
};

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

function dayLabel(now: Date): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long", day: "numeric", month: "long" }).format(now);
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

export function SecretaryHome({ view, briefing, actions, now = new Date() }: { view: SecretaryHomeView; briefing: BriefingApi; actions: SecretaryHomeActions; now?: Date }) {
  const data = useHubData(briefing.generatedAt);
  const [costOpen, setCostOpen] = useState(false);
  const tasksOn = data.tasks !== "off" && data.tasks !== "loading";
  const cards = hubCards({ briefing, tasks: data.tasks, summary: data.summary, formatMoney });
  const taskList = Array.isArray(data.tasks) ? data.tasks : [];
  const dueNow = view.needs.filter((g) => g.key === "OVERDUE" || g.key === "DUE_TODAY");
  const dueSoon = view.needs.filter((g) => g.key === "DUE_SOON");
  const tasksToday = todayTasks(taskList);
  const obligations = typeof data.obligations === "object" ? data.obligations : null;
  const summary = typeof data.summary === "object" ? data.summary : null;
  const events = calendarEvents({ obligations: obligations?.list ?? [], tasks: taskList, summary });
  const calendarNotes = [
    data.tasks === "off" ? null : "משימות מוצגות עד שבוע קדימה.",
    summary ? "תחזית: מועדים צפויים של הוצאות קבועות, עד 30 יום קדימה. היא עוד לא נרשמה ולא שולמה." : null,
    "שולם: לפי הרישום בהתחייבות, ביום המועד שלה.",
    data.obligations === "unavailable" ? "לא הצלחתי לטעון את מועדי ההתחייבויות." : null,
    obligations?.truncated ? `מוצגות ${HUB_OBLIGATION_LIMIT.toLocaleString("he-IL")} ההתחייבויות הראשונות.` : null,
  ].filter((n): n is string => n !== null);

  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-labelledby="secretary-title">
      <Header now={now} tasksOn={tasksOn} />
      <StatusBar view={view} />
      <HubCards cards={cards} onCost={() => setCostOpen(true)} />

      <div className={s.work}>
        <div className={s.lists}>
          {view.state === "new" ? (
            <div className={s.note}>
              <p>אפשר להתחיל מרשימת ההוצאות הקבועות (שכירות, ארנונה, חשמל…) או למסור תשלום אחד עכשיו.</p>
              <div className={s.noteActs}>
                <Link href={HREF.bank} className={cx(s.btn, s.primary)}>בחירה מרשימת ההוצאות הקבועות</Link>
                <Link href={HREF.capture} className={cx(s.btn, s.secondary)}>מסירת תשלום אחד</Link>
              </div>
            </div>
          ) : null}

          <section className={s.zone} aria-labelledby="hub-today">
            <h2 className={s.zoneTitle} id="hub-today">מה מחכה לך היום</h2>
            {dueNow.length === 0 && tasksToday.length === 0 ? (
              <div className={s.calm}>
                <p>{view.state === "new" ? "עוד אין כאן תשלומים או משימות." : "אין היום תשלום או משימה שמחכים לך."}</p>
              </div>
            ) : null}
            {dueNow.map((group) => (
              <RowGroup key={group.key} groupKey={group.key} title={group.title} rows={group.rows} now={now} actions={actions} />
            ))}
            {tasksToday.length > 0 ? <TaskGroup title="משימות להיום" tasks={tasksToday} onDone={data.reloadTasks} /> : null}
          </section>

          {data.tasks !== "off" ? (
            <section className={s.zone} aria-labelledby="hub-tasks">
              <div className={s.zoneHead}>
                <h2 className={s.zoneTitle} id="hub-tasks">המשימות שלי</h2>
                <Link href={HREF.tasks} className={s.link}>לכל המשימות ›</Link>
              </div>
              {data.tasks === "loading" ? (
                <div className={s.rows} style={{ padding: 14, display: "grid", gap: 14 }}>
                  <span className={s.skel} style={{ blockSize: 36 }} />
                </div>
              ) : data.tasks === "unavailable" ? (
                <div className={s.calm}><p>לא הצלחתי לטעון את המשימות. אפשר לפתוח אותן במסך המשימות.</p></div>
              ) : taskList.length === 0 ? (
                <div className={s.calm}><p>אין משימות פתוחות לשבוע הקרוב.</p></div>
              ) : (
                <TaskGroup tasks={taskList.slice(0, TASKS_SHOWN)} onDone={data.reloadTasks} more={taskList.length - TASKS_SHOWN} />
              )}
            </section>
          ) : null}

          {view.state !== "new" ? (
            <section className={s.zone} aria-labelledby="hub-upcoming">
              <h2 className={s.zoneTitle} id="hub-upcoming">התחייבויות קרובות</h2>
              {dueSoon.length === 0 && view.watching.length === 0 ? (
                <div className={s.calm}><p>אין התחייבות שמועדה מתקרב. כשמועד מתקרב, הוא יופיע כאן.</p></div>
              ) : null}
              {dueSoon.map((group) => (
                <RowGroup key={group.key} groupKey={group.key} title={group.title} rows={group.rows} now={now} actions={actions} />
              ))}
              {view.watching.length > 0 ? (
                <RowGroup groupKey="WATCHING" title="במעקב שקט" rows={view.watching} now={now} actions={actions} quiet />
              ) : null}
            </section>
          ) : null}

          <nav className={s.zone} aria-labelledby="hub-more">
            <h2 className={s.zoneTitle} id="hub-more">היסטוריה ומידע נוסף</h2>
            <div className={s.links}>
              <Link href={HREF.all} className={s.link}>כל ההתחייבויות, כולל מה שנסגר ›</Link>
              <Link href={HREF.today} className={s.link}>היום שלי ›</Link>
              {view.watching.length > 0 ? <Link href={HREF.watching} className={s.link}>מה שאני שומרת ›</Link> : null}
              <Link href={HREF.bank} className={s.link}>רשימת ההוצאות הקבועות ›</Link>
              <Link href={HREF.payables} className={s.link}>מסך ההתחייבויות ›</Link>
            </div>
          </nav>
        </div>

        <aside className={s.side} aria-label="לוח שנה">
          <SecretaryCalendar events={events} notes={calendarNotes} loading={data.obligations === "loading"} />
        </aside>
      </div>

      <SecretaryCostDrawer open={costOpen} onClose={() => setCostOpen(false)} summary={summary} />
    </main>
  );
}

const TASKS_SHOWN = 6;

function Header({ now, tasksOn = false }: { now: Date; tasksOn?: boolean }) {
  return (
    <header className={s.head}>
      <div className={s.headText}>
        <p className={s.date}>{dayLabel(now)}</p>
        <h1 id="secretary-title" className={s.title}>המזכירה שלי</h1>
      </div>
      <nav className={s.entries} aria-label="פעולות ראשיות">
        {/* "הוסף משימה" is the task centre's own create form, and exists only where daily_tasks is ON. */}
        {tasksOn ? (
          <Link href={HREF.newTask} className={cx(s.btn, s.secondary)}>
            <PlusIcon />
            הוסף משימה
          </Link>
        ) : null}
        {/* The one way to create a commitment: the P3 flow, from its first step. */}
        <Link href={HREF.bank} className={cx(s.btn, s.primary)}>
          <PlusIcon />
          הוסף התחייבות
        </Link>
      </nav>
    </header>
  );
}

function StatusBar({ view }: { view: SecretaryHomeView }) {
  return (
    <section className={s.status} aria-label="מצב">
      <div className={s.say}>
        <span className={s.avatar} aria-hidden="true"><PersonIcon /></span>
        <div>
          <p className={s.who}>המזכירה שלך</p>
          <h2 className={s.headline}>{view.title}</h2>
          <p className={s.subline}>{view.subtitle}</p>
        </div>
      </div>
    </section>
  );
}

function HubCards({ cards, onCost }: { cards: HubCard[]; onCost: () => void }) {
  return (
    <section className={h.cards} aria-label="סיכום">
      {cards.map((c) => {
        const body = (
          <>
            <span className={h.cardLabel}>{c.label}</span>
            {c.state === "loading" ? (
              <span className={s.skel} style={{ blockSize: 26, inlineSize: "60%" }} />
            ) : (
              <span className={cx(h.cardValue, c.value === null && h.cardValueNone)}>{c.value === null ? "—" : <bdi>{c.value}</bdi>}</span>
            )}
            <span className={h.cardHint}>{c.hint}</span>
          </>
        );
        if (c.key === "cost" && c.state === "ready") {
          return (
            <button key={c.key} type="button" className={cx(h.sumCard, h.sumCardAction)} onClick={onCost} aria-haspopup="dialog">
              {body}
            </button>
          );
        }
        return (
          <div key={c.key} className={h.sumCard}>
            {body}
          </div>
        );
      })}
    </section>
  );
}

const BUCKET_TEXT: Record<HubTask["bucket"], string> = { OVERDUE: "באיחור", TODAY: "היום", UPCOMING: "השבוע", NO_DATE: "ללא תאריך" };

function TaskGroup({ title, tasks, onDone, more = 0 }: { title?: string; tasks: HubTask[]; onDone: () => Promise<void>; more?: number }) {
  return (
    <div className={s.group}>
      {title ? (
        <h3 className={s.groupHead}>
          <span className={cx(s.dot, h.dotTask)} aria-hidden="true" />
          {title}
          <em>· {tasks.length.toLocaleString("he-IL")}</em>
        </h3>
      ) : null}
      <ul className={s.rows}>
        {tasks.map((t) => (
          <TaskRow key={t.task.id} item={t} onDone={onDone} />
        ))}
      </ul>
      {more > 0 ? (
        <Link href={HREF.tasks} className={s.link}>ועוד {more.toLocaleString("he-IL")} במסך המשימות ›</Link>
      ) : null}
    </div>
  );
}

/** A task row. "בוצע" is the task centre's own action (POST /api/tasks/:id/complete) with the row's version. */
function TaskRow({ item, onDone }: { item: HubTask; onDone: () => Promise<void> }) {
  const { task, bucket } = item;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = task.dueOn ? shortDate(`${task.dueOn}T12:00:00Z`) : null;

  async function done() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await taskAction(task.id, "complete", { expectedVersion: task.version });
      await onDone();
    } catch (e) {
      setError(ownerErrorText(e, "לא הצלחתי לסמן שבוצע. שום דבר לא השתנה, ואפשר לנסות שוב."));
      setBusy(false);
    }
  }

  return (
    <li className={cx(s.row, h.taskRow)}>
      <button
        type="button"
        className={h.check}
        onClick={() => void done()}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`סמן שבוצע: ${task.title}`}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </button>
      <span className={s.main}>
        <span className={s.nameLine}>
          <Link href={HREF.tasks} className={s.name}>{task.title}</Link>
          <span className={cx(s.chip, bucket === "OVERDUE" ? s.chipLate : bucket === "TODAY" ? s.chipSoon : s.chipQuiet)}>{BUCKET_TEXT[bucket]}</span>
        </span>
        <span className={s.meta}>
          <span>משימה</span>
          {due ? (
            <>
              <span className={s.sep} aria-hidden="true">·</span>
              <span>{`עד ${due}`}</span>
            </>
          ) : null}
          {task.cadence ? (
            <>
              <span className={s.sep} aria-hidden="true">·</span>
              <span>{task.cadence}</span>
            </>
          ) : null}
          {task.link?.label ? (
            <>
              <span className={s.sep} aria-hidden="true">·</span>
              <span>{task.link.label}</span>
            </>
          ) : null}
        </span>
      </span>
      {error ? <p className={s.error} role="alert">{error}</p> : null}
    </li>
  );
}

const DOT: Record<HomeGroupKey, string> = { OVERDUE: s.dotLate, DUE_TODAY: s.dotSoon, DUE_SOON: s.dotSoon, WATCHING: s.dotQuiet };

function RowGroup({ groupKey, title, rows, now, actions, quiet = false }: { groupKey: HomeGroupKey; title: string; rows: HomeRow[]; now: Date; actions: SecretaryHomeActions; quiet?: boolean }) {
  const id = `sec-group-${groupKey}`;
  return (
    <section className={s.group} aria-labelledby={id}>
      <h3 className={s.groupHead} id={id}>
        <span className={cx(s.dot, DOT[groupKey])} aria-hidden="true" />
        {title}
        <em>· {rows.length.toLocaleString("he-IL")}</em>
      </h3>
      <ul className={cx(s.rows, quiet && s.quiet)} aria-labelledby={id}>
        {rows.map((row) => (
          <Row key={row.obligation.id} row={row} now={now} actions={actions} />
        ))}
      </ul>
    </section>
  );
}

function Row({ row, now, actions }: { row: HomeRow; now: Date; actions: SecretaryHomeActions }) {
  const id = row.obligation.id;
  const needsOwner = row.status !== "WATCHING";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const days = dueDays(row.obligation.dueAt, now);
  const currency = row.obligation.currency;

  async function handled() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await actions.onHandled(id);
    } catch (e) {
      setError(ownerErrorText(e, "לא הצלחתי לסמן שטופל. שום דבר לא השתנה, ואפשר לנסות שוב."));
    } finally {
      setBusy(false);
    }
  }

  // ReleaseControl keeps its own busy state but lets a failure through; the row says it in Hebrew.
  async function release() {
    setError(null);
    try {
      await actions.onRelease(id);
    } catch (e) {
      setError(ownerErrorText(e, "לא הצלחתי להסיר. ההתחייבות נשארה במעקב, ואפשר לנסות שוב."));
    }
  }

  const chipClass = row.status === "OVERDUE" ? s.chipLate : row.status === "WATCHING" ? s.chipQuiet : s.chipSoon;

  return (
    <li className={s.row}>
      <span className={s.mark} aria-hidden="true">{row.name.charAt(0)}</span>
      <span className={s.main}>
        <span className={s.nameLine}>
          <Link href={HREF.detail(id)} className={s.name}>{row.name}</Link>
          <span className={cx(s.chip, chipClass)}>{STATUS_LABEL[row.status]}</span>
        </span>
        <span className={s.meta}>
          <span>{row.cadence}</span>
          <span className={s.sep} aria-hidden="true">·</span>
          <span>{row.status === "OVERDUE" ? `היה לתשלום ב־${shortDate(row.obligation.dueAt)}` : `לתשלום ב־${shortDate(row.obligation.dueAt)}`}</span>
          {days !== null ? (
            <>
              <span className={s.sep} aria-hidden="true">·</span>
              <span className={row.status === "OVERDUE" ? s.late : undefined}>{relativeDays(days)}</span>
            </>
          ) : null}
          {row.progress ? (
            <span className={s.progress}>
              <span className={s.sep} aria-hidden="true">·</span>
              <span>
                שולמו <bdi>{formatMoney(row.progress.paid, currency)}</bdi> מתוך <bdi>{formatMoney(row.progress.total, currency)}</bdi>
              </span>
              <span className={s.track} aria-hidden="true">
                <span className={s.fill} style={{ inlineSize: `${progressPercent(row.progress)}%` }} />
              </span>
            </span>
          ) : null}
        </span>
      </span>
      <span className={s.amount}>
        <bdi className={s.money}>{formatMoney(row.amount, currency)}</bdi>
        {row.amountCaption ? <span className={s.caption}>{row.amountCaption}</span> : null}
      </span>
      <span className={s.acts}>
        {needsOwner ? (
          <button type="button" className={cx(s.btn, s.primary, s.small)} onClick={() => void handled()} disabled={busy} aria-busy={busy || undefined}>
            {busy ? "רגע…" : "סמן שטופל"}
          </button>
        ) : null}
        <RowMenu
          label={`פעולות נוספות ל${row.name}`}
          items={[
            { label: "פרטים", href: HREF.detail(id) },
            ...(needsOwner ? [{ label: "להזכיר לי אחר כך", href: HREF.remind(id) }] : []),
            { label: "עריכת התחייבות", href: HREF.update(id) },
            "separator" as const,
            { label: "כבר לא רלוונטי…", onSelect: () => setReleaseOpen(true), danger: true },
          ]}
        />
      </span>
      {releaseOpen ? (
        // The existing release control: same question, same answers, same onReleaseFlow.
        <div className={s.below}>
          <ReleaseControl onRelease={release} />
          <button type="button" className={cx(s.btn, s.secondary, s.small)} onClick={() => setReleaseOpen(false)}>
            סגירה
          </button>
        </div>
      ) : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
    </li>
  );
}

/** A visual ratio only — the figures shown beside it are the server's. */
function progressPercent(p: { paid: string; total: string }): number {
  const paid = Number(p.paid);
  const total = Number(p.total);
  if (!Number.isFinite(paid) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, paid / total)) * 100);
}

type MenuEntry = { label: string; href: string } | { label: string; onSelect: () => void; danger?: boolean } | "separator";

/** The "⋯" menu: Enter/Space/ArrowDown open, arrows move, Escape closes and returns focus. */
function RowMenu({ label, items }: { label: string; items: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const entries = () => Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusAt = (i: number) => {
    const list = entries();
    if (list.length) list[(i + list.length) % list.length].focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    const raf = requestAnimationFrame(() => {
      wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => {
      document.removeEventListener("mousedown", outside);
      cancelAnimationFrame(raf);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  return (
    <span className={s.menuWrap} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={cx(s.btn, s.secondary, s.small, s.iconOnly)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreIcon />
      </button>
      {open ? (
        <ul
          className={s.menu}
          role="menu"
          id={menuId}
          aria-label={label}
          onKeyDown={(e) => {
            const at = entries().indexOf(document.activeElement as HTMLElement);
            if (e.key === "Escape") {
              e.preventDefault();
              close(true);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              focusAt(at + 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              focusAt(at - 1);
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
        >
          {items.map((item, i) => {
            if (item === "separator") return <li key={`sep-${i}`} className={s.menuSep} role="separator" />;
            if ("href" in item) {
              return (
                <li key={item.label} role="none">
                  <Link href={item.href} role="menuitem" className={s.menuItem} onClick={() => setOpen(false)}>
                    {item.label}
                  </Link>
                </li>
              );
            }
            return (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={cx(s.menuItem, item.danger && s.menuDanger)}
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </span>
  );
}

/** Loading: the same structure, so the screen does not jump when data lands. */
export function SecretaryHomeLoading() {
  return (
    <main className={s.page} style={secretaryVars()} dir="rtl" aria-busy="true" aria-label="טוען את המזכירה">
      <Header now={new Date()} />
      <section className={s.status}>
        <div className={s.say}>
          <span className={s.avatar} aria-hidden="true"><PersonIcon /></span>
          <div style={{ display: "grid", gap: 8, minWidth: 0, flex: 1 }}>
            <span className={s.skel} style={{ inlineSize: "62%", blockSize: 22 }} />
            <span className={s.skel} style={{ inlineSize: "40%", blockSize: 14 }} />
          </div>
        </div>
      </section>
      <div className={s.work}>
        <div className={s.lists}>
          <div className={s.rows} style={{ padding: 14, display: "grid", gap: 14 }}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={s.skel} style={{ blockSize: 40 }} />
            ))}
          </div>
        </div>
      </div>
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
          className={cx(s.btn, s.primary)}
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

function PersonIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.3" />
      <path d="M5.4 19c0-3.7 3-6.2 6.6-6.2s6.6 2.5 6.6 6.2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="18" height="18">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}
