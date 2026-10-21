"use client";

/**
 * Daily Tasks — the details panel (desktop/tablet column; mobile bottom sheet). Everything the "⋯" offers lives
 * here, as buttons:
 *
 *   own task      סיימתי · דחה למחר · שנה תאריך · דלג הפעם (series) · עריכה · בטל משימה; series: השהה / חדש / סיים
 *   supplier pay  לתשלום (the secretary) · טופל (→ "שילמת?"; only "כן" records a payment) · דחה תזכורת · חשוב
 *   lead          the lead's own slot: בוצע (clears the follow-up) · הזכר לי ב… (moves it) · טופל להיום · חשוב
 *   other source  open · טופל להיום · הזכר לי ב… (display state only) · חשוב
 *   repair        nothing until the occurrence is stored ("מתעדכנת…", 8.7)
 *
 * "טופל להיום" and "הזכר לי ב…" on a business item change only what this list shows; the item returns at once
 * when new evidence arrives (spec 3.4, 8.5).
 */
import Link from "next/link";
import { useEffect, useState } from "react";

import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey, Translator } from "@/lib/i18n/translate";
import type { AgendaRow, SourceItem } from "@/lib/services/tasks/agenda-core";
import { buildClientAuthHeaders } from "@/lib/client-session";
import {
  ackQueue,
  changeSeries,
  fetchItemHistory,
  editTask,
  seriesAction,
  sourceOp,
  taskAction,
  type AgendaResponse,
} from "@/lib/tasks/tasks-client";

import { addDays, chipLabel, short, todayKey } from "./task-days";
import { DomainIcon } from "./task-icons";
import s from "./tasks.module.css";

type Act = (fn: () => Promise<unknown>, done?: string, undo?: () => Promise<void>) => Promise<boolean>;

const SOURCE_HINT: Record<string, MessageKey> = {
  supplier_payment: "tasks.details.sourceHint.supplierPayment",
  customer_debt: "tasks.details.sourceHint.customerDebt",
  invoice_review: "tasks.details.sourceHint.invoiceReview",
  lead: "tasks.details.sourceHint.lead",
  conversation: "tasks.details.sourceHint.conversation",
  documents_queue: "tasks.details.sourceHint.documentsQueue",
  stock: "tasks.details.sourceHint.stock",
};

function sourceHint(kind: string, t: Translator): string {
  const key = SOURCE_HINT[kind];
  return key ? t(key) : "";
}

export function TaskDetails({
  row,
  agenda,
  act,
  onAskPaid,
  onClosed,
}: {
  row: AgendaRow;
  agenda: AgendaResponse;
  act: Act;
  onAskPaid: (item: SourceItem) => void;
  onClosed: () => void;
}) {
  const { t } = useI18n();
  if (row.type === "TASK") return <OwnTask row={row} agenda={agenda} act={act} onClosed={onClosed} />;
  if (row.type === "SOURCE") return <SourceDetail item={row.item} pinned={row.pinned} act={act} onAskPaid={onAskPaid} onClosed={onClosed} />;
  if (row.type === "QUEUE") {
    const everyone = [...row.members, ...row.handledToday];
    return (
      <>
        <div className={s.detH}>
          <DomainIcon kind={row.sourceKind} />
          <div>
            <h2>{row.title}</h2>
            <p className={s.hint}>{sourceHint(row.sourceKind, t)}</p>
          </div>
        </div>
        {row.newCount !== null ? (
          <p className={`${s.fact} ${s.factNeutral}`}>
            {t("tasks.details.queue.handledSince", { handled: row.handledToday.length, newCount: row.newCount })}
          </p>
        ) : null}
        <ul className={s.hist}>
          {everyone.slice(0, 8).map((m) => (
            <li key={m.dedupeKey}>
              <span>{m.title}</span>
            </li>
          ))}
          {everyone.length > 8 ? <li className={s.hint}>{t("tasks.details.queue.andMore", { count: everyone.length - 8 })}</li> : null}
        </ul>
        <div className={s.actions}>
          <Link href={row.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{row.action.label}</Link>
          <button
            type="button"
            className={s.btn}
            onClick={() => void act(() => ackQueue(row.sourceKind, everyone.map((m) => m.dedupeKey)), t("tasks.common.handledToday")).then((ok) => ok && onClosed())}
          >
            {t("tasks.common.handledToday")}
          </button>
        </div>
        <p className={s.hint}>{t("tasks.details.queue.hint")}</p>
      </>
    );
  }
  return (
    <>
      <div className={s.detH}>
        <div>
          <h2>{row.repair.title}</h2>
          <p className={s.hint}>{row.repair.cadence ? t("tasks.details.repair.recurringCadence", { cadence: row.repair.cadence }) : t("tasks.details.repair.recurring")}</p>
        </div>
      </div>
      <p className={`${s.fact} ${s.factNeutral}`}>{t("tasks.details.repair.updating")}</p>
      <dl className={s.kv}>
        <dt>{t("tasks.common.due")}</dt>
        <dd>{chipLabel(row.repair.dueOn, t)}</dd>
      </dl>
    </>
  );
}

// ── own task ────────────────────────────────────────────────────────────────────────────────────

type HistoryEntry = { type: string; actor: string; at: string; payload: Record<string, unknown> };

function historyText(h: HistoryEntry, t: Translator): string {
  const p = h.payload ?? {};
  switch (h.type) {
    case "TASK_COMPLETED":
      return typeof p.lateDays === "number" && p.lateDays > 0
        ? p.lateDays === 1
          ? t("tasks.details.history.doneLateOne")
          : t("tasks.details.history.doneLateMany", { count: p.lateDays })
        : t("tasks.details.history.done");
    case "TASK_CANCELED":
      return p.closeReason === "SKIPPED" || p.closeReason === "SKIP" ? t("tasks.details.history.skipped") : t("tasks.details.history.canceled");
    case "TASK_SNOOZED":
      return typeof p.to === "string" ? t("tasks.details.history.snoozedTo", { date: short(p.to) }) : t("tasks.details.history.snoozed");
    case "TASK_RESCHEDULED":
      return typeof p.to === "string" ? t("tasks.details.history.rescheduledTo", { date: short(p.to) }) : t("tasks.details.history.rescheduled");
    case "TASK_REOPENED":
      return t("tasks.common.reopened");
    case "TASK_CREATED":
      return h.actor === "SYSTEM" ? t("tasks.details.history.newOccurrence") : t("tasks.details.history.created");
    default:
      return "";
  }
}

function OwnTask({ row, agenda, act, onClosed }: { row: Extract<AgendaRow, { type: "TASK" }>; agenda: AgendaResponse; act: Act; onClosed: () => void }) {
  const { t: tr } = useI18n();
  const t = row.task;
  const today = todayKey();
  const series = t.seriesId ? agenda.series.find((x) => x.id === t.seriesId) ?? null : null;
  const [mode, setMode] = useState<"idle" | "date" | "edit" | "cancel" | "end">("idle");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tasks/${t.id}`, { cache: "no-store", headers: buildClientAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { history?: HistoryEntry[] } | null) => !cancelled && setHistory(j?.history ?? []))
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, [t.id, t.version]);

  const v = { expectedVersion: t.version };
  const closeAnd = (fn: () => Promise<unknown>, done: string) => act(fn, done).then((ok) => ok && onClosed());
  const linkLabel = t.link
    ? t.link.label ?? (t.link.kind === "customer" ? tr("tasks.common.customer") : t.link.kind === "supplier" ? tr("tasks.common.supplier") : tr("tasks.details.own.link"))
    : null;

  return (
    <>
      <div className={s.detH}>
        <button
          type="button"
          className={s.chk}
          aria-label={tr("tasks.common.markDoneAria", { title: t.title })}
          onClick={() => void closeAnd(() => taskAction(t.id, "complete", v), tr("tasks.common.markedDone"))}
        />
        <div>
          <h2>{t.title}</h2>
          <p className={s.hint}>{t.seriesId ? tr("tasks.details.own.hintSeries") : tr("tasks.details.own.hintTask")}</p>
        </div>
      </div>

      <dl className={s.kv}>
        <dt>{tr("tasks.common.due")}</dt>
        <dd>{t.dueOn ? (t.dueOn === today ? tr("tasks.details.own.todayDate", { date: short(t.dueOn) }) : chipLabel(t.dueOn, tr)) : tr("tasks.details.own.noDate")}</dd>
        {t.pinned ? (<><dt>{tr("tasks.common.marking")}</dt><dd>{tr("tasks.common.important")}</dd></>) : null}
        {t.cadence ? (<><dt>{tr("tasks.details.own.repeat")}</dt><dd>{series?.paused ? tr("tasks.details.own.cadencePaused", { cadence: t.cadence }) : t.cadence}</dd></>) : null}
        {t.note ? (<><dt>{tr("tasks.details.own.note")}</dt><dd>{t.note}</dd></>) : null}
        {t.link ? (<><dt>{tr("tasks.details.own.relatedTo")}</dt><dd>{linkLabel}</dd></>) : null}
      </dl>

      {mode === "idle" ? (
        <>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.pri}`} onClick={() => void closeAnd(() => taskAction(t.id, "complete", v), tr("tasks.common.markedDone"))}>{tr("tasks.common.finished")}</button>
            <button type="button" className={s.btn} onClick={() => void act(() => taskAction(t.id, "snooze", { ...v, dueOn: addDays(today, 1) }), tr("tasks.common.snoozedTomorrow"))}>{tr("tasks.common.snoozeTomorrow")}</button>
            <button type="button" className={s.btn} onClick={() => setMode("date")}>{tr("tasks.details.own.changeDate")}</button>
            {t.seriesId ? (
              <button type="button" className={s.btn} onClick={() => void closeAnd(() => taskAction(t.id, "skip", v), tr("tasks.details.own.skippedOnce"))}>{tr("tasks.details.own.skipOnce")}</button>
            ) : null}
          </div>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setMode("edit")}>{t.seriesId ? tr("tasks.details.own.editSeries") : tr("tasks.details.own.edit")}</button>
            <button
              type="button"
              className={`${s.btn} ${s.ghost}`}
              aria-pressed={t.pinned}
              onClick={() => void act(() => taskAction(t.id, t.pinned ? "unpin" : "pin", v), t.pinned ? tr("tasks.common.unmarked") : tr("tasks.common.markedImportant"))}
            >
              {t.pinned ? tr("tasks.common.unpin") : tr("tasks.common.pin")}
            </button>
            {series ? (
              <button
                type="button"
                className={`${s.btn} ${s.ghost}`}
                onClick={() => void act(() => seriesAction(series.id, series.paused ? "resume" : "pause", series.version), series.paused ? tr("tasks.details.own.seriesResumed") : tr("tasks.details.own.seriesPaused"))}
              >
                {series.paused ? tr("tasks.details.own.resumeSeries") : tr("tasks.details.own.pauseSeries")}
              </button>
            ) : null}
            {series ? (
              <button type="button" className={`${s.btn} ${s.ghost} ${s.danger}`} onClick={() => setMode("end")}>{tr("tasks.details.own.endSeries")}</button>
            ) : (
              <button type="button" className={`${s.btn} ${s.ghost} ${s.danger}`} onClick={() => setMode("cancel")}>{tr("tasks.details.own.cancelTask")}</button>
            )}
          </div>
        </>
      ) : null}

      {mode === "date" ? (
        <DayPick
          label={tr("tasks.details.own.whichDay")}
          confirm={tr("tasks.details.own.saveDate")}
          onCancel={() => setMode("idle")}
          onPick={(day) => act(() => taskAction(t.id, "reschedule", { ...v, dueOn: day }), tr("tasks.details.history.rescheduledTo", { date: short(day) })).then(() => setMode("idle"))}
        />
      ) : null}

      {mode === "edit" ? (
        <EditForm
          title={t.title}
          note={t.note}
          onCancel={() => setMode("idle")}
          onSave={(title, note) =>
            act(
              () => (series ? changeSeries(series.id, { expectedVersion: series.version, title, note }) : editTask(t.id, { ...v, title, note })),
              series ? tr("tasks.details.own.seriesUpdated") : tr("tasks.common.saved"),
            ).then(() => setMode("idle"))
          }
        />
      ) : null}

      {mode === "cancel" || mode === "end" ? (
        <div className={`${s.fact} ${s.factNeutral}`} role="alertdialog" aria-label={tr("tasks.details.own.confirmAria")}>
          <p style={{ margin: "0 0 8px" }}>{mode === "end" ? tr("tasks.details.own.confirmEnd") : tr("tasks.details.own.confirmCancel")}</p>
          <div className={s.actions}>
            <button
              type="button"
              className={`${s.btn} ${s.danger}`}
              onClick={() =>
                void (mode === "end" && series
                  ? closeAnd(() => seriesAction(series.id, "end", series.version), tr("tasks.details.own.seriesEnded"))
                  : closeAnd(() => taskAction(t.id, "cancel", v), tr("tasks.details.own.taskCanceled")))
              }
            >
              {mode === "end" ? tr("tasks.details.own.yesEnd") : tr("tasks.details.own.yesCancel")}
            </button>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setMode("idle")}>{tr("tasks.details.own.no")}</button>
          </div>
        </div>
      ) : null}

      {history && history.length ? (
        <ul className={s.hist} aria-label={tr("tasks.details.history.aria")}>
          {history.map((h, i) => {
            const text = historyText(h, tr);
            return text ? (
              <li key={i}>
                <time dateTime={h.at}>{short(todayKey(new Date(h.at)))}</time>
                <span>{text}</span>
              </li>
            ) : null;
          })}
        </ul>
      ) : null}
    </>
  );
}

function EditForm({ title, note, onSave, onCancel }: { title: string; note: string | null; onSave: (title: string, note: string | null) => Promise<unknown>; onCancel: () => void }) {
  const { t } = useI18n();
  const [tv, setT] = useState(title);
  const [nv, setN] = useState(note ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={s.form}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!tv.trim()) return;
        setBusy(true);
        await onSave(tv.trim(), nv.trim() ? nv.trim() : null);
        setBusy(false);
      }}
    >
      <div className={s.field}>
        <label htmlFor="edit-title">{t("tasks.details.edit.title")}</label>
        <input id="edit-title" className={s.input} value={tv} maxLength={200} onChange={(e) => setT(e.target.value)} required />
      </div>
      <div className={s.field}>
        <label htmlFor="edit-note">{t("tasks.details.edit.note")}</label>
        <textarea id="edit-note" className={s.input} rows={3} value={nv} maxLength={2000} onChange={(e) => setN(e.target.value)} />
      </div>
      <div className={s.actions}>
        <button type="submit" className={`${s.btn} ${s.pri}`} disabled={busy || !tv.trim()}>{t("tasks.common.save")}</button>
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onCancel}>{t("tasks.common.cancel")}</button>
      </div>
    </form>
  );
}

// ── business item ───────────────────────────────────────────────────────────────────────────────

function sourceHistoryText(kind: string, until: string | null | undefined, t: Translator): string {
  switch (kind) {
    case "APPEARED": return t("tasks.details.source.appeared");
    case "SOURCE_ITEM_ACKNOWLEDGED": return t("tasks.details.source.acknowledged");
    case "SOURCE_ITEM_SNOOZED": return until ? t("tasks.details.source.snoozedUntil", { date: short(until) }) : t("tasks.details.history.snoozed");
    case "SOURCE_ITEM_PINNED": return t("tasks.common.markedImportant");
    case "SOURCE_ITEM_UNPINNED": return t("tasks.details.source.unpinned");
    case "SOURCE_CLOSED_OBSERVED": return t("tasks.details.source.closed");
    default: return "";
  }
}

/** The item's handling history: its cycles and display actions (journal), plus its domain facts (the item itself). */
function ItemHistory({ item }: { item: SourceItem }) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<{ day: string; text: string }[] | null>(null);
  const postponedUntil = item.reminderPostponed?.until ?? null;
  useEffect(() => {
    let cancelled = false;
    fetchItemHistory(item.sourceKind, item.dedupeKey)
      .then((r) => {
        if (cancelled) return;
        const list = r.history.map((h) => ({ day: todayKey(new Date(h.at)), text: sourceHistoryText(h.kind, h.until, t) })).filter((x) => x.text);
        // Domain facts, from the item as the source shows it now (11.1: the domain keeps its own record).
        if (item.sourceKind === "supplier_payment" && item.dueOn && item.dueOn <= todayKey()) list.push({ day: item.dueOn, text: t("tasks.details.source.paymentDue") });
        if (postponedUntil) list.push({ day: todayKey(), text: t("tasks.details.source.reminderPostponed", { date: short(postponedUntil) }) });
        list.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
        setEntries(list);
      })
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [item.sourceKind, item.dedupeKey, item.dueOn, postponedUntil, t]);
  if (!entries || entries.length === 0) return null;
  return (
    <ul className={s.hist} aria-label={t("tasks.details.source.historyAria")}>
      {entries.map((e, i) => (
        <li key={i}>
          <time dateTime={e.day}>{short(e.day)}</time>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  );
}

function SourceDetail({ item, pinned, act, onAskPaid, onClosed }: { item: SourceItem; pinned: boolean; act: Act; onAskPaid: (item: SourceItem) => void; onClosed: () => void }) {
  const { t } = useI18n();
  const [pick, setPick] = useState<null | "remind">(null);
  const ref = { sourceKind: item.sourceKind, dedupeKey: item.dedupeKey };
  const d = item.details ?? {};
  const isPay = item.sourceKind === "supplier_payment";
  const isLead = item.sourceKind === "lead";
  const closeAnd = (fn: () => Promise<unknown>, done: string) => act(fn, done).then((ok) => ok && onClosed());

  const handled = () => {
    // handled ≠ paid: a ledger-backed payment with something still unpaid asks "שילמת?" first.
    if (isPay && d.installmentId && d.commitmentId && Number(d.remaining ?? 0) > 0) onAskPaid(item);
    else void closeAnd(() => sourceOp("payment_handled", ref), t("tasks.common.markedHandled"));
  };

  return (
    <>
      <div className={s.detH}>
        <DomainIcon kind={item.sourceKind} />
        <div>
          <h2>{item.title}</h2>
          <p className={s.hint}>{sourceHint(item.sourceKind, t)}</p>
        </div>
      </div>

      {item.fact ? <p className={`${s.fact} ${isPay ? "" : s.factNeutral}`}>{item.fact}</p> : null}

      <dl className={s.kv}>
        {item.dueOn ? (<><dt>{t("tasks.common.due")}</dt><dd>{chipLabel(item.dueOn, t)}</dd></>) : null}
        {item.reminderPostponed ? (<><dt>{t("tasks.details.source.reminder")}</dt><dd>{t("tasks.details.source.postponedUntil", { date: chipLabel(item.reminderPostponed.until, t) })}</dd></>) : null}
        {pinned ? (<><dt>{t("tasks.common.marking")}</dt><dd>{t("tasks.common.important")}</dd></>) : null}
      </dl>

      {pick === "remind" ? (
        <DayPick
          label={isPay ? t("tasks.details.source.untilWhen") : t("tasks.details.source.whenRemind")}
          confirm={isPay ? t("tasks.common.snoozeReminder") : t("tasks.details.source.remindMe")}
          onCancel={() => setPick(null)}
          onPick={(day) =>
            closeAnd(
              () => sourceOp(isPay ? "payment_snooze" : isLead ? "lead_snooze" : "snooze", ref, { until: day }),
              isPay ? t("tasks.details.source.reminderMovedTo", { date: short(day) }) : t("tasks.details.source.willRemindOn", { date: short(day) }),
            )
          }
        />
      ) : (
        <div className={s.actions}>
          <Link href={item.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>
            {isPay ? t("tasks.details.source.payInSecretary") : item.action.label}
          </Link>
          {isPay ? (
            <button type="button" className={s.btn} onClick={handled}>{t("tasks.common.handled")}</button>
          ) : isLead && d.followUpDue ? (
            <button type="button" className={s.btn} onClick={() => void closeAnd(() => sourceOp("lead_done", ref), t("tasks.details.source.followUpDone"))}>{t("tasks.details.source.done")}</button>
          ) : null}
          {!isPay ? (
            <button type="button" className={s.btn} onClick={() => void closeAnd(() => sourceOp("acknowledge", ref), t("tasks.common.handledToday"))}>{t("tasks.common.handledToday")}</button>
          ) : null}
          {isPay || isLead || item.snooze === "STATE" ? (
            <button type="button" className={s.btn} onClick={() => setPick("remind")}>{isPay ? t("tasks.common.snoozeReminder") : t("tasks.details.source.remindMeOn")}</button>
          ) : null}
          <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => void act(() => sourceOp(pinned ? "unpin" : "pin", ref), pinned ? t("tasks.common.unmarked") : t("tasks.common.markedImportant"))}>
            {pinned ? t("tasks.common.unpin") : t("tasks.common.pin")}
          </button>
        </div>
      )}

      {isPay ? <p className={s.hint}>{t("tasks.details.source.payHint")}</p> : null}
      {!isPay && !isLead ? <p className={s.hint}>{t("tasks.details.source.ackHint")}</p> : null}
      <ItemHistory item={item} />
    </>
  );
}

// ── day picker ──────────────────────────────────────────────────────────────────────────────────

function DayPick({ label, confirm, onPick, onCancel }: { label: string; confirm: string; onPick: (day: string) => Promise<unknown>; onCancel: () => void }) {
  const { t } = useI18n();
  const today = todayKey();
  const [day, setDay] = useState(addDays(today, 1));
  const [busy, setBusy] = useState(false);
  const options: [string, string][] = [
    [addDays(today, 1), t("tasks.common.tomorrow")],
    [addDays(today, 2), chipLabel(addDays(today, 2), t)],
    [addDays(today, 7), t("tasks.details.dayPick.inAWeek")],
  ];
  return (
    <div className={s.form}>
      <div className={s.field}>
        <span style={{ fontSize: 12.5, color: "var(--dz-text-secondary)", fontWeight: 500 }}>{label}</span>
        <div className={s.chips}>
          {options.map(([k, l]) => (
            <button key={k} type="button" className={`${s.chip} ${day === k ? s.chipOn : ""}`} aria-pressed={day === k} onClick={() => setDay(k)}>
              {l}
            </button>
          ))}
        </div>
        <input type="date" className={s.input} aria-label={t("tasks.details.dayPick.otherDate")} min={addDays(today, 1)} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={`${s.btn} ${s.pri}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onPick(day);
            setBusy(false);
          }}
        >
          {confirm}
        </button>
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onCancel}>{t("tasks.common.cancel")}</button>
      </div>
    </div>
  );
}
