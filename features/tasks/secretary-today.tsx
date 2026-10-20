"use client";

/**
 * Daily Tasks — the secretary's "היום שלי" on the shared agenda (owner-approved mockup scene "המזכירה"; spec 10).
 * Shown only while daily_tasks is ON; with the flag OFF the secretary's own today screen is unchanged.
 *
 *   - the same agenda and the same counts as the task centre (GET /api/tasks/agenda) — one source, no second count;
 *   - the secretary's voice: the hero sentence, "קודם כול" = the agenda's first row, "ובהמשך היום" = the rest;
 *   - a supplier payment keeps the secretary's own flow: "טופל" asks "שילמת?" (page.tsx onCompleteFlow), "דחה
 *     תזכורת" opens her remind screen — the payment path is the existing one, untouched;
 *   - "בקשה חדשה" opens the task form (forms and buttons only, H1); "כל המשימות" opens /tasks.
 */
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import type { AgendaRow } from "@/lib/services/tasks/agenda-core";
import { errorText, sourceOp, taskAction } from "@/lib/tasks/tasks-client";
import { useAgenda } from "@/lib/tasks/use-agenda";

import { HeroText, SecretaryHeader, SecretaryScreen } from "@/app/(shell)/secretary/secretary-ui";
import { TaskForm } from "./task-form";
import { addDays, longDate, todayKey } from "./task-days";
import { DomainIcon, IconPlus } from "./task-icons";
import s from "./tasks.module.css";

const COUNT_WORDS = ["אף אחד", "אחד", "שניים", "שלושה", "ארבעה", "חמישה", "שישה", "שבעה", "שמונה", "תשעה", "עשרה"];

function rowTitle(r: AgendaRow): string {
  return r.type === "TASK" ? r.task.title : r.type === "SOURCE" ? r.item.title : r.type === "REPAIR" ? r.repair.title : r.title;
}
function rowFact(r: AgendaRow): string | null {
  return r.type === "SOURCE" ? r.item.fact : r.type === "QUEUE" ? r.fact : r.type === "TASK" ? (r.task.link?.label ? `קשור ל: ${r.task.link.label}` : null) : "מתעדכנת…";
}

export function SecretaryToday({
  onPaymentHandled,
  aside,
}: {
  /** The secretary's own "סמן שטופל" flow for an obligation (asks "שילמת?" when the ledger says so). */
  onPaymentHandled: (obligationId: number) => Promise<void>;
  aside?: ReactNode;
}) {
  const router = useRouter();
  const { state, refresh } = useAgenda();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const agenda = state.status === "ready" ? state.agenda : null;
  const counted = agenda ? agenda.buckets.filter((b) => b.bucket === "OVERDUE" || b.bucket === "TODAY").flatMap((b) => b.rows) : [];
  const overdue = agenda?.buckets.find((b) => b.bucket === "OVERDUE")?.items ?? 0;
  const focus = counted[0] ?? null;
  const rest = counted.slice(1, 8);

  const n = agenda?.count ?? 0;
  const plus = agenda?.countPartial ? "+" : "";
  const title = !agenda
    ? "רגע, אוספת את היום…"
    : agenda.emptyAllowed
      ? "הכול תחת שליטה להיום."
      : n === 0
        ? "אין כרגע משהו לטיפול היום."
        : `יש ${n}${plus} דברים לטיפול היום.${overdue ? ` ${overdue === 1 ? "אחד מהם" : `${COUNT_WORDS[overdue] ?? overdue} מהם`} באיחור.` : ""}`;
  const subtitle = agenda
    ? `אותו סדר יום כמו ב"משימות": ${n}${plus} לטיפול${agenda.doneToday ? `, ${agenda.doneToday} בוצעו` : ""}.`
    : "";

  async function run(fn: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await fn();
      await refresh();
      setNote(done);
    } catch (e) {
      setNote(errorText(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const focusActions = (r: AgendaRow): ReactNode => {
    if (r.type === "TASK") {
      const v = { expectedVersion: r.task.version };
      return (
        <>
          <button type="button" className={`${s.btn} ${s.pri}`} disabled={busy} onClick={() => void run(() => taskAction(r.task.id, "complete", v), "סומן כבוצע")}>סיימתי</button>
          <button type="button" className={s.btn} disabled={busy} onClick={() => void run(() => taskAction(r.task.id, "snooze", { ...v, dueOn: addDays(todayKey(), 1) }), "נדחה למחר")}>דחה למחר</button>
        </>
      );
    }
    if (r.type === "SOURCE") {
      const it = r.item;
      const ref = { sourceKind: it.sourceKind, dedupeKey: it.dedupeKey };
      if (it.sourceKind === "supplier_payment" && it.entity) {
        const id = it.entity.id;
        return (
          <>
            <Link href={it.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{it.action.label}</Link>
            <button type="button" className={s.btn} disabled={busy} onClick={() => void run(() => onPaymentHandled(id), "סומן כטופל")}>טופל</button>
            <button type="button" className={s.btn} onClick={() => router.push(`/secretary?screen=remind&id=${id}`)}>דחה תזכורת</button>
          </>
        );
      }
      return (
        <>
          <Link href={it.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{it.action.label}</Link>
          <button type="button" className={s.btn} disabled={busy} onClick={() => void run(() => sourceOp("acknowledge", ref), "טופל להיום")}>טופל להיום</button>
        </>
      );
    }
    if (r.type === "QUEUE") return <Link href={r.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{r.action.label}</Link>;
    return null;
  };

  return (
    <SecretaryScreen>
      <SecretaryHeader status={`המזכירה · ${longDate(agenda?.dayKey ?? todayKey())}`} tone={n === 0 ? "done" : overdue ? "critical" : "busy"} />
      <div className={s.secGrid}>
        <div className={s.secMain}>
          <HeroText title={title} subtitle={subtitle} />

          {focus ? (
            <section className={s.focus} aria-labelledby="sec-focus">
              <span className={s.focusK}>קודם כול</span>
              <h2 id="sec-focus">{rowTitle(focus)}</h2>
              {rowFact(focus) ? <p className={s.focusFact}>{rowFact(focus)}</p> : null}
              <div className={s.actions}>{focusActions(focus)}</div>
            </section>
          ) : null}

          {rest.length ? (
            <section className={s.bucket} aria-labelledby="sec-rest">
              <h2 id="sec-rest" className={s.bucketHead}>
                ובהמשך היום <span className={s.n}>{counted.length - 1}</span>
              </h2>
              <div className={s.rows} role="list">
                {rest.map((r) => (
                  <Link key={r.key} role="listitem" href={r.type === "SOURCE" ? r.item.action.href : r.type === "QUEUE" ? r.action.href : "/tasks"} prefetch={false} className={s.row} style={{ color: "inherit", textDecoration: "none" }}>
                    {r.type === "SOURCE" ? <DomainIcon kind={r.item.sourceKind} /> : r.type === "QUEUE" ? <DomainIcon kind={r.sourceKind} /> : <span className={s.chk} aria-hidden />}
                    <span className={s.rbody}>
                      <span className={s.rtitle}>{rowTitle(r)}</span>
                      {rowFact(r) ? <span className={s.rfact}>{rowFact(r)}</span> : null}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {state.status === "error" ? <p className={s.error} role="alert">לא הצלחתי לטעון את סדר היום. נסה שוב עוד רגע.</p> : null}
          {note ? <p className={s.hint} aria-live="polite">{note}</p> : null}

          <div className={s.linkRow}>
            <Link href="/tasks" prefetch={false} className={`${s.btn} ${s.ghost}`}>כל המשימות ←</Link>
            <button type="button" className={`${s.btn} ${s.soft}`} onClick={() => setCreating(true)}>
              <IconPlus /> בקשה חדשה
            </button>
          </div>
        </div>

        <aside className={s.secAside}>
          {aside}
          <section className={s.card} aria-labelledby="sec-capture">
            <h2 id="sec-capture">מה למסור לי?</h2>
            <div className={s.chips}>
              <button type="button" className={`${s.chip} ${s.chipOn}`} onClick={() => setCreating(true)}>משימה</button>
              <Link href="/secretary?screen=capture" prefetch={false} className={s.chip} style={{ textDecoration: "none" }}>התחייבות לתשלום</Link>
            </div>
            <p className={s.hint}>&quot;משימה&quot; פותחת את אותו טופס כמו במרכז המשימות.</p>
          </section>
        </aside>
      </div>

      <AdaptiveOverlay open={creating} onClose={() => setCreating(false)} labelledBy="sec-task-form">
        <div style={{ padding: 20 }}>
          {creating ? (
            <TaskForm
              origin="SECRETARY"
              titleId="sec-task-form"
              onDone={async () => {
                setCreating(false);
                await refresh();
                setNote("המשימה נשמרה");
              }}
              onCancel={() => setCreating(false)}
            />
          ) : null}
        </div>
      </AdaptiveOverlay>
    </SecretaryScreen>
  );
}
