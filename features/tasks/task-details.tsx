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

import type { AgendaRow, SourceItem } from "@/lib/services/tasks/agenda-core";
import { buildClientAuthHeaders } from "@/lib/client-session";
import {
  changeSeries,
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

const SOURCE_HINT: Record<string, string> = {
  supplier_payment: "מהמזכירה · תשלום לספק",
  customer_debt: "מהגבייה · לקוח שחייב לעסק",
  invoice_review: "מהחשבוניות · ממתינה לבדיקה",
  lead: "מהלידים",
  conversation: "מהשיחות · ממתינה לתשובה",
  documents_queue: "מהמסמכים · ממתינים לבדיקה",
  stock: "מהמלאי",
};

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
  if (row.type === "TASK") return <OwnTask row={row} agenda={agenda} act={act} onClosed={onClosed} />;
  if (row.type === "SOURCE") return <SourceDetail item={row.item} pinned={row.pinned} act={act} onAskPaid={onAskPaid} onClosed={onClosed} />;
  if (row.type === "QUEUE") {
    return (
      <>
        <div className={s.detH}>
          <DomainIcon kind={row.sourceKind} />
          <div>
            <h2>{row.title}</h2>
            <p className={s.hint}>{SOURCE_HINT[row.sourceKind] ?? ""}</p>
          </div>
        </div>
        <ul className={s.hist}>
          {row.members.slice(0, 8).map((m) => (
            <li key={m.dedupeKey}>
              <span>{m.title}</span>
            </li>
          ))}
          {row.members.length > 8 ? <li className={s.hint}>ועוד {row.members.length - 8}</li> : null}
        </ul>
        <div className={s.actions}>
          <Link href={row.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>{row.action.label}</Link>
        </div>
      </>
    );
  }
  return (
    <>
      <div className={s.detH}>
        <div>
          <h2>{row.repair.title}</h2>
          <p className={s.hint}>משימה חוזרת{row.repair.cadence ? ` · ${row.repair.cadence}` : ""}</p>
        </div>
      </div>
      <p className={`${s.fact} ${s.factNeutral}`}>המופע הזה מתעדכן ברשימה. הפעולות יופיעו ברגע שיישמר.</p>
      <dl className={s.kv}>
        <dt>מועד</dt>
        <dd>{chipLabel(row.repair.dueOn)}</dd>
      </dl>
    </>
  );
}

// ── own task ────────────────────────────────────────────────────────────────────────────────────

type HistoryEntry = { type: string; actor: string; at: string; payload: Record<string, unknown> };

function historyText(h: HistoryEntry): string {
  const p = h.payload ?? {};
  switch (h.type) {
    case "TASK_COMPLETED":
      return typeof p.lateDays === "number" && p.lateDays > 0 ? `בוצע באיחור של ${p.lateDays === 1 ? "יום" : `${p.lateDays} ימים`}` : "בוצע";
    case "TASK_CANCELED":
      return p.closeReason === "SKIPPED" || p.closeReason === "SKIP" ? "דולג" : "בוטל";
    case "TASK_SNOOZED":
      return typeof p.to === "string" ? `נדחה ל־${short(p.to)}` : "נדחה";
    case "TASK_RESCHEDULED":
      return typeof p.to === "string" ? `התאריך שונה ל־${short(p.to)}` : "התאריך שונה";
    case "TASK_REOPENED":
      return "הוחזר לרשימה";
    case "TASK_CREATED":
      return h.actor === "SYSTEM" ? "נוצר מופע חדש" : "נוצרה";
    default:
      return "";
  }
}

function OwnTask({ row, agenda, act, onClosed }: { row: Extract<AgendaRow, { type: "TASK" }>; agenda: AgendaResponse; act: Act; onClosed: () => void }) {
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

  return (
    <>
      <div className={s.detH}>
        <button
          type="button"
          className={s.chk}
          aria-label={`סמן כבוצע: ${t.title}`}
          onClick={() => void closeAnd(() => taskAction(t.id, "complete", v), "סומן כבוצע")}
        />
        <div>
          <h2>{t.title}</h2>
          <p className={s.hint}>{t.seriesId ? "משימה חוזרת · נוצרה על ידך" : "משימה · נוצרה על ידך"}</p>
        </div>
      </div>

      <dl className={s.kv}>
        <dt>מועד</dt>
        <dd>{t.dueOn ? (t.dueOn === today ? `היום, ${short(t.dueOn)}` : chipLabel(t.dueOn)) : "ללא תאריך"}</dd>
        {t.cadence ? (<><dt>חזרה</dt><dd>{t.cadence}{series?.paused ? " · מושהית" : ""}</dd></>) : null}
        {t.note ? (<><dt>הערה</dt><dd>{t.note}</dd></>) : null}
        {t.link ? (<><dt>קשור ל</dt><dd>{t.link.label ?? (t.link.kind === "customer" ? "לקוח" : t.link.kind === "supplier" ? "ספק" : "קישור")}</dd></>) : null}
      </dl>

      {mode === "idle" ? (
        <>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.pri}`} onClick={() => void closeAnd(() => taskAction(t.id, "complete", v), "סומן כבוצע")}>סיימתי</button>
            <button type="button" className={s.btn} onClick={() => void act(() => taskAction(t.id, "snooze", { ...v, dueOn: addDays(today, 1) }), "נדחה למחר")}>דחה למחר</button>
            <button type="button" className={s.btn} onClick={() => setMode("date")}>שנה תאריך</button>
            {t.seriesId ? (
              <button type="button" className={s.btn} onClick={() => void closeAnd(() => taskAction(t.id, "skip", v), "דולג הפעם")}>דלג הפעם</button>
            ) : null}
          </div>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setMode("edit")}>{t.seriesId ? "עריכת הסדרה" : "עריכה"}</button>
            {series ? (
              <button
                type="button"
                className={`${s.btn} ${s.ghost}`}
                onClick={() => void act(() => seriesAction(series.id, series.paused ? "resume" : "pause", series.version), series.paused ? "הסדרה חודשה" : "הסדרה הושהתה")}
              >
                {series.paused ? "חדש סדרה" : "השהה סדרה"}
              </button>
            ) : null}
            {series ? (
              <button type="button" className={`${s.btn} ${s.ghost} ${s.danger}`} onClick={() => setMode("end")}>סיים סדרה</button>
            ) : (
              <button type="button" className={`${s.btn} ${s.ghost} ${s.danger}`} onClick={() => setMode("cancel")}>בטל משימה</button>
            )}
          </div>
        </>
      ) : null}

      {mode === "date" ? (
        <DayPick
          label="לאיזה יום?"
          confirm="שמור תאריך"
          onCancel={() => setMode("idle")}
          onPick={(day) => act(() => taskAction(t.id, "reschedule", { ...v, dueOn: day }), `התאריך שונה ל־${short(day)}`).then(() => setMode("idle"))}
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
              series ? "הסדרה עודכנה — מהמופע הבא" : "נשמר",
            ).then(() => setMode("idle"))
          }
        />
      ) : null}

      {mode === "cancel" || mode === "end" ? (
        <div className={`${s.fact} ${s.factNeutral}`} role="alertdialog" aria-label="אישור">
          <p style={{ margin: "0 0 8px" }}>{mode === "end" ? "לסיים את הסדרה? מופעים חדשים לא ייווצרו." : "לבטל את המשימה? היא תוסר מהרשימה."}</p>
          <div className={s.actions}>
            <button
              type="button"
              className={`${s.btn} ${s.danger}`}
              onClick={() =>
                void (mode === "end" && series
                  ? closeAnd(() => seriesAction(series.id, "end", series.version), "הסדרה הסתיימה")
                  : closeAnd(() => taskAction(t.id, "cancel", v), "המשימה בוטלה"))
              }
            >
              {mode === "end" ? "כן, לסיים" : "כן, לבטל"}
            </button>
            <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => setMode("idle")}>לא</button>
          </div>
        </div>
      ) : null}

      {history && history.length ? (
        <ul className={s.hist} aria-label="היסטוריה">
          {history.map((h, i) => {
            const text = historyText(h);
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
        <label htmlFor="edit-title">כותרת</label>
        <input id="edit-title" className={s.input} value={tv} maxLength={200} onChange={(e) => setT(e.target.value)} required />
      </div>
      <div className={s.field}>
        <label htmlFor="edit-note">הערה (לא חובה)</label>
        <textarea id="edit-note" className={s.input} rows={3} value={nv} maxLength={2000} onChange={(e) => setN(e.target.value)} />
      </div>
      <div className={s.actions}>
        <button type="submit" className={`${s.btn} ${s.pri}`} disabled={busy || !tv.trim()}>שמירה</button>
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onCancel}>ביטול</button>
      </div>
    </form>
  );
}

// ── business item ───────────────────────────────────────────────────────────────────────────────

function SourceDetail({ item, pinned, act, onAskPaid, onClosed }: { item: SourceItem; pinned: boolean; act: Act; onAskPaid: (item: SourceItem) => void; onClosed: () => void }) {
  const [pick, setPick] = useState<null | "remind">(null);
  const ref = { sourceKind: item.sourceKind, dedupeKey: item.dedupeKey };
  const d = item.details ?? {};
  const isPay = item.sourceKind === "supplier_payment";
  const isLead = item.sourceKind === "lead";
  const closeAnd = (fn: () => Promise<unknown>, done: string) => act(fn, done).then((ok) => ok && onClosed());

  const handled = () => {
    // handled ≠ paid: a ledger-backed payment with something still unpaid asks "שילמת?" first.
    if (isPay && d.installmentId && d.commitmentId && Number(d.remaining ?? 0) > 0) onAskPaid(item);
    else void closeAnd(() => sourceOp("payment_handled", ref), "סומן כטופל");
  };

  return (
    <>
      <div className={s.detH}>
        <DomainIcon kind={item.sourceKind} />
        <div>
          <h2>{item.title}</h2>
          <p className={s.hint}>{SOURCE_HINT[item.sourceKind] ?? ""}</p>
        </div>
      </div>

      {item.fact ? <p className={`${s.fact} ${isPay ? "" : s.factNeutral}`}>{item.fact}</p> : null}

      <dl className={s.kv}>
        {item.dueOn ? (<><dt>מועד</dt><dd>{chipLabel(item.dueOn)}</dd></>) : null}
        {item.reminderPostponed ? (<><dt>תזכורת</dt><dd>נדחתה עד {chipLabel(item.reminderPostponed.until)} · עדיין לא שולם</dd></>) : null}
        {pinned ? (<><dt>סימון</dt><dd>חשוב</dd></>) : null}
      </dl>

      {pick === "remind" ? (
        <DayPick
          label={isPay ? "עד מתי לדחות את התזכורת?" : "מתי להזכיר?"}
          confirm={isPay ? "דחה תזכורת" : "הזכר לי"}
          onCancel={() => setPick(null)}
          onPick={(day) =>
            closeAnd(
              () => sourceOp(isPay ? "payment_snooze" : isLead ? "lead_snooze" : "snooze", ref, { until: day }),
              isPay ? `התזכורת נדחתה ל־${short(day)}` : `נזכיר ב־${short(day)}`,
            )
          }
        />
      ) : (
        <div className={s.actions}>
          <Link href={item.action.href} prefetch={false} className={`${s.btn} ${s.pri}`}>
            {isPay ? "לתשלום במזכירה" : item.action.label}
          </Link>
          {isPay ? (
            <button type="button" className={s.btn} onClick={handled}>טופל</button>
          ) : isLead && d.followUpDue ? (
            <button type="button" className={s.btn} onClick={() => void closeAnd(() => sourceOp("lead_done", ref), "המעקב בוצע")}>בוצע</button>
          ) : null}
          {!isPay ? (
            <button type="button" className={s.btn} onClick={() => void closeAnd(() => sourceOp("acknowledge", ref), "טופל להיום")}>טופל להיום</button>
          ) : null}
          {isPay || isLead || item.snooze === "STATE" ? (
            <button type="button" className={s.btn} onClick={() => setPick("remind")}>{isPay ? "דחה תזכורת" : "הזכר לי ב…"}</button>
          ) : null}
          <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => void act(() => sourceOp(pinned ? "unpin" : "pin", ref), pinned ? "הוסר הסימון" : "סומן כחשוב")}>
            {pinned ? "בטל \"חשוב\"" : "סמן כחשוב"}
          </button>
        </div>
      )}

      {isPay ? <p className={s.hint}>&quot;טופל&quot; לא רושם תשלום. אחריו נשאל &quot;שילמת?&quot;, ורק &quot;כן&quot; רושם תשלום.</p> : null}
      {!isPay && !isLead ? <p className={s.hint}>&quot;טופל להיום&quot; מסתיר את הפריט עד מחר. אם יגיע משהו חדש — הוא יחזור מיד.</p> : null}
    </>
  );
}

// ── day picker ──────────────────────────────────────────────────────────────────────────────────

function DayPick({ label, confirm, onPick, onCancel }: { label: string; confirm: string; onPick: (day: string) => Promise<unknown>; onCancel: () => void }) {
  const today = todayKey();
  const [day, setDay] = useState(addDays(today, 1));
  const [busy, setBusy] = useState(false);
  const options: [string, string][] = [
    [addDays(today, 1), "מחר"],
    [addDays(today, 2), chipLabel(addDays(today, 2))],
    [addDays(today, 7), "בעוד שבוע"],
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
        <input type="date" className={s.input} aria-label="תאריך אחר" min={addDays(today, 1)} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
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
        <button type="button" className={`${s.btn} ${s.ghost}`} onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}
