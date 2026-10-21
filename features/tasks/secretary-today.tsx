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

import { useI18n } from "@/components/i18n/I18nProvider";
import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { AgendaRow } from "@/lib/services/tasks/agenda-core";
import { errorText, sourceOp, taskAction } from "@/lib/tasks/tasks-client";
import { useAgenda } from "@/lib/tasks/use-agenda";

import { HeroText, SecretaryHeader, SecretaryScreen } from "@/app/(shell)/secretary/secretary-ui";
import { TaskForm } from "./task-form";
import { addDays, longDate, todayKey } from "./task-days";
import { DomainIcon, IconPlus } from "./task-icons";
import s from "./tasks.module.css";

const COUNT_WORDS: readonly MessageKey[] = [
  "tasks.secretaryToday.countWords.zero",
  "tasks.secretaryToday.countWords.one",
  "tasks.secretaryToday.countWords.two",
  "tasks.secretaryToday.countWords.three",
  "tasks.secretaryToday.countWords.four",
  "tasks.secretaryToday.countWords.five",
  "tasks.secretaryToday.countWords.six",
  "tasks.secretaryToday.countWords.seven",
  "tasks.secretaryToday.countWords.eight",
  "tasks.secretaryToday.countWords.nine",
  "tasks.secretaryToday.countWords.ten",
];

function rowTitle(r: AgendaRow): string {
  return r.type === "TASK" ? r.task.title : r.type === "SOURCE" ? r.item.title : r.type === "REPAIR" ? r.repair.title : r.title;
}
function rowFact(r: AgendaRow, t: Translator): string | null {
  return r.type === "SOURCE" ? r.item.fact : r.type === "QUEUE" ? r.fact : r.type === "TASK" ? (r.task.link?.label ? t("tasks.common.relatedTo", { label: r.task.link.label }) : null) : t("tasks.secretaryToday.updating");
}

export function SecretaryToday({
  onPaymentHandled,
  aside,
}: {
  /** The secretary's own "סמן שטופל" flow for an obligation (asks "שילמת?" when the ledger says so). */
  onPaymentHandled: (obligationId: number) => Promise<void>;
  aside?: ReactNode;
}) {
  const { t } = useI18n();
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
    ? t("tasks.secretaryToday.collecting")
    : agenda.emptyAllowed
      ? t("tasks.secretaryToday.allUnderControl")
      : n === 0
        ? t("tasks.secretaryToday.nothingToday")
        : !overdue
          ? t("tasks.secretaryToday.count", { count: `${n}${plus}` })
          : overdue === 1
            ? t("tasks.secretaryToday.countOverdueOne", { count: `${n}${plus}` })
            : t("tasks.secretaryToday.countOverdueMany", { count: `${n}${plus}`, overdue: COUNT_WORDS[overdue] ? t(COUNT_WORDS[overdue]) : overdue });
  const subtitle = agenda
    ? agenda.doneToday
      ? t("tasks.secretaryToday.subtitleDone", { count: `${n}${plus}`, done: agenda.doneToday })
      : t("tasks.secretaryToday.subtitle", { count: `${n}${plus}` })
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
          <button type="button" className={`${s.btn} ${s.pri}`} disabled={busy} onClick={() => void run(() => taskAction(r.task.id, "complete", v), t("tasks.common.markedDone"))}>{t("tasks.common.finished")}</button>
          <button type="button" className={s.btn} disabled={busy} onClick={() => void run(() => taskAction(r.task.id, "snooze", { ...v, dueOn: addDays(todayKey(), 1) }), t("tasks.common.snoozedTomorrow"))}>{t("tasks.common.snoozeTomorrow")}</button>
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
            <button type="button" className={s.btn} disabled={busy} onClick={() => void run(() => onPaymentHandled(id), t("tasks.common.markedHandled"))}>{t("tasks.common.handled")}</button>
            <button type="button" className={s.btn} onClick={() => router.push(`/secretary?screen=remind&id=${id}`)}>{t("tasks.common.snoozeReminder")}</button>
          </>
        );
      }
      return (
        <>
          <Link href={it.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{it.action.label}</Link>
          <button type="button" className={s.btn} disabled={busy} onClick={() => void run(() => sourceOp("acknowledge", ref), t("tasks.common.handledToday"))}>{t("tasks.common.handledToday")}</button>
        </>
      );
    }
    if (r.type === "QUEUE") return <Link href={r.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{r.action.label}</Link>;
    return null;
  };

  return (
    <SecretaryScreen>
      <SecretaryHeader status={t("tasks.secretaryToday.status", { date: longDate(agenda?.dayKey ?? todayKey(), t) })} tone={n === 0 ? "done" : overdue ? "critical" : "busy"} />
      <div className={s.secGrid}>
        <div className={s.secMain}>
          <HeroText title={title} subtitle={subtitle} />

          {focus ? (
            <section className={s.focus} aria-labelledby="sec-focus">
              <span className={s.focusK}>{t("tasks.secretaryToday.first")}</span>
              <h2 id="sec-focus">{rowTitle(focus)}</h2>
              {rowFact(focus, t) ? <p className={s.focusFact}>{rowFact(focus, t)}</p> : null}
              <div className={s.actions}>{focusActions(focus)}</div>
            </section>
          ) : null}

          {rest.length ? (
            <section className={s.bucket} aria-labelledby="sec-rest">
              <h2 id="sec-rest" className={s.bucketHead}>
                {t("tasks.secretaryToday.laterToday")} <span className={s.n}>{counted.length - 1}</span>
              </h2>
              <div className={s.rows} role="list">
                {rest.map((r) => (
                  <Link key={r.key} role="listitem" href={r.type === "SOURCE" ? r.item.action.href : r.type === "QUEUE" ? r.action.href : "/tasks"} prefetch={false} className={s.row} style={{ color: "inherit", textDecoration: "none" }}>
                    {r.type === "SOURCE" ? <DomainIcon kind={r.item.sourceKind} /> : r.type === "QUEUE" ? <DomainIcon kind={r.sourceKind} /> : <span className={s.chk} aria-hidden />}
                    <span className={s.rbody}>
                      <span className={s.rtitle}>{rowTitle(r)}</span>
                      {rowFact(r, t) ? <span className={s.rfact}>{rowFact(r, t)}</span> : null}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {state.status === "error" ? <p className={s.error} role="alert">{t("tasks.secretaryToday.loadFailed")}</p> : null}
          {note ? <p className={s.hint} aria-live="polite">{note}</p> : null}

          <div className={s.linkRow}>
            <Link href="/tasks" prefetch={false} className={`${s.btn} ${s.ghost}`}>{t("tasks.secretaryToday.allTasks")}</Link>
            <button type="button" className={`${s.btn} ${s.soft}`} onClick={() => setCreating(true)}>
              <IconPlus /> {t("tasks.secretaryToday.newRequest")}
            </button>
          </div>
        </div>

        <aside className={s.secAside}>
          {aside}
          <section className={s.card} aria-labelledby="sec-capture">
            <h2 id="sec-capture">{t("tasks.secretaryToday.whatToHandOver")}</h2>
            <div className={s.chips}>
              <button type="button" className={`${s.chip} ${s.chipOn}`} onClick={() => setCreating(true)}>{t("tasks.secretaryToday.task")}</button>
              <Link href="/secretary?screen=capture" prefetch={false} className={s.chip} style={{ textDecoration: "none" }}>{t("tasks.secretaryToday.commitment")}</Link>
            </div>
            <p className={s.hint}>{t("tasks.secretaryToday.taskHint")}</p>
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
                setNote(t("tasks.common.taskSaved"));
              }}
              onCancel={() => setCreating(false)}
            />
          ) : null}
        </div>
      </AdaptiveOverlay>
    </SecretaryScreen>
  );
}
