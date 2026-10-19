"use client";

/**
 * Daily Tasks — the task centre ("היום שלי"), as the owner approved it (mockups Version 1, 1791822519-0d65):
 *
 *   - one agenda for the owner's own tasks and the business's items: באיחור · היום · ללא תאריך · בהמשך השבוע;
 *   - a manual task has a check circle; a business item has a button named for its action and "⋯" for the rest
 *     (טופל להיום · הזכר לי ב… · חשוב, or the domain's own: בוצע / טופל / דחה תזכורת);
 *   - the count is OVERDUE + TODAY; "N+ · חלקי" when a source failed or was cut; the empty state
 *     "הכול תחת שליטה להיום" only when the list is COMPLETE (8.7);
 *   - desktop: list · week column · details panel; tablet: list · details; mobile: list, details in a bottom sheet.
 *
 * Everything shown comes from GET /api/tasks/agenda; every change goes through /api/tasks with an
 * Idempotency-Key. The page itself is behind the daily_tasks flag (404 from the API when OFF).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AdaptiveOverlay } from "@/components/ui/adaptive-overlay";
import { useBreakpoint } from "@/lib/ui/use-breakpoint";
import type { AgendaRow, BucketView, SourceItem, Tag } from "@/lib/services/tasks/agenda-core";
import {
  createTask,
  errorText,
  sourceOp,
  taskAction,
  uuidV7,
  type AgendaResponse,
} from "@/lib/tasks/tasks-client";
import { useAgenda } from "@/lib/tasks/use-agenda";
import { PaidQuestionSheet, type PaidDetails } from "@/app/(shell)/secretary/paid-question";
import type { ObligationApi } from "@/lib/obligations/secretary-client";

import { TaskDetails } from "./task-details";
import { TaskForm } from "./task-form";
import { longDate, short, todayKey } from "./task-days";
import { DomainIcon, IconCheck, IconDots, IconPlus, IconAlert } from "./task-icons";
import s from "./tasks.module.css";

export type Selection = { key: string } | null;

export function TasksScreen() {
  const bp = useBreakpoint();
  const router = useRouter();
  const params = useSearchParams();
  const { state, refresh, retrySync } = useAgenda();
  const [selected, setSelected] = useState<string | null>(null);
  // "+" → "משימה חדשה" lands here with ?new=1.
  const [creating, setCreating] = useState(() => params?.get("new") === "1");
  const [toast, setToast] = useState<{ text: string; undo?: () => Promise<void> } | null>(null);
  const [paidFor, setPaidFor] = useState<SourceItem | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const quickRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (params?.get("new") === "1") router.replace("/tasks", { scroll: false });
  }, [params, router]);

  const agenda = state.status === "ready" ? state.agenda : null;
  const rows = useMemo(() => (agenda ? agenda.buckets.flatMap((b) => b.rows) : []), [agenda]);
  // Wide screens keep something in the details panel: the first row, as in the mockup.
  const chosen = rows.find((r) => r.key === selected) ?? null;
  const selectedRow = chosen ?? (bp !== "mobile" && !creating ? rows[0] ?? null : null);

  // N — new task (desktop: the quick-add line; elsewhere: the form). Escape closes the form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if ((e.key === "n" || e.key === "N" || e.key === "מ") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (bp === "desktop" && quickRef.current) quickRef.current.focus();
        else setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bp]);

  const flash = useCallback((text: string, undo?: () => Promise<void>) => {
    setToast({ text, undo });
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 6000);
  }, []);

  /** Run an action, reload the agenda, say what happened; failures speak the owner's language. */
  const act = useCallback(
    async (fn: () => Promise<unknown>, done?: string, undo?: () => Promise<void>) => {
      try {
        await fn();
        await refresh();
        if (done) flash(done, undo);
        return true;
      } catch (e) {
        flash(errorText(e));
        await refresh();
        return false;
      }
    },
    [refresh, flash],
  );

  const completeTask = (row: Extract<AgendaRow, { type: "TASK" }>) =>
    act(
      () => taskAction(row.task.id, "complete", { expectedVersion: row.task.version }),
      "סומן כבוצע",
      async () => {
        await act(() => taskAction(row.task.id, "reopen", { expectedVersion: row.task.version + 1 }), "הוחזר לרשימה");
      },
    );

  const onPaid = async (details: PaidDetails) => {
    const item = paidFor!;
    const ref = { sourceKind: item.sourceKind, dedupeKey: item.dedupeKey };
    await sourceOp("payment_paid", ref, { amount: details.amount, paidAt: details.paidAt, method: details.method });
    await sourceOp("payment_handled", ref);
    setPaidFor(null);
    await refresh();
    flash("התשלום נרשם והתזכורת נסגרה");
  };
  const onHandledOnly = async () => {
    const item = paidFor!;
    await sourceOp("payment_handled", { sourceKind: item.sourceKind, dedupeKey: item.dedupeKey });
    setPaidFor(null);
    await refresh();
    flash("סומן כטופל — לא נרשם תשלום");
  };

  const details = selectedRow ? (
    <TaskDetails
      key={selectedRow.key}
      row={selectedRow}
      agenda={agenda!}
      act={act}
      onAskPaid={(item) => setPaidFor(item)}
      onClosed={() => setSelected(null)}
    />
  ) : null;

  const form = (
    <TaskForm
      titleId="task-form-title"
      onDone={async () => {
        setCreating(false);
        await refresh();
        flash("המשימה נשמרה");
      }}
      onCancel={() => setCreating(false)}
    />
  );

  return (
    <main dir="rtl" className={s.screen} data-page-intent="content">
      <Header agenda={agenda} onNew={() => setCreating(true)} />

      {state.status === "error" ? (
        <div className={`${s.banner} ${s.bannerBad}`} role="alert">
          <IconAlert />
          <span>לא הצלחנו לטעון את המשימות.</span>
          <span className={s.grow} />
          <button type="button" className={s.btn} onClick={() => void refresh()}>נסה שוב</button>
        </div>
      ) : null}

      <div className={s.cols}>
        <div className={s.main}>
          {agenda ? <QuickAdd inputRef={quickRef} act={act} /> : null}
          {agenda ? <Banners agenda={agenda} syncing={state.status === "ready" && state.syncing} retrySync={retrySync} reload={refresh} /> : null}
          {state.status === "loading" ? <Skeleton /> : null}
          {agenda ? (
            <AgendaList
              agenda={agenda}
              bp={bp}
              selected={selectedRow?.key ?? null}
              open={open}
              setOpen={(k, v) => setOpen((o) => ({ ...o, [k]: v }))}
              onSelect={(k) => {
                setCreating(false);
                setSelected(k);
              }}
              onComplete={completeTask}
              onNew={() => setCreating(true)}
            />
          ) : null}
        </div>

        <aside className={s.week} aria-label="בהמשך השבוע ומשימות חוזרות">
          {agenda ? <WeekColumn agenda={agenda} onSelect={(k) => { setCreating(false); setSelected(k); }} /> : null}
        </aside>

        <aside className={s.detail} aria-label="פרטים">
          {bp === "desktop" && creating ? form : details ?? (
            <div className={s.placeholder}>
              <span>בחר שורה כדי לראות את הפרטים והפעולות.</span>
              <button type="button" className={`${s.btn} ${s.soft}`} onClick={() => setCreating(true)}>
                <IconPlus /> משימה חדשה
              </button>
            </div>
          )}
        </aside>
      </div>

      {/* tablet: the form as a dialog; mobile: form and details as bottom sheets */}
      <AdaptiveOverlay open={creating && bp !== "desktop"} onClose={() => setCreating(false)} labelledBy="task-form-title">
        <div style={{ padding: 20 }}>{creating && bp !== "desktop" ? form : null}</div>
      </AdaptiveOverlay>
      <AdaptiveOverlay open={bp === "mobile" && !!selectedRow && !creating} onClose={() => setSelected(null)}>
        <div style={{ padding: "8px 18px 24px", display: "flex", flexDirection: "column", gap: 14 }}>{bp === "mobile" ? details : null}</div>
      </AdaptiveOverlay>

      {paidFor ? (
        <PaidQuestionSheet
          obligation={paidObligation(paidFor)}
          onPaid={onPaid}
          onHandledOnly={onHandledOnly}
          onCancel={() => setPaidFor(null)}
        />
      ) : null}

      {toast ? (
        <div className={s.toast} role="status">
          <span>{toast.text}</span>
          {toast.undo ? (
            <button type="button" onClick={() => { const u = toast.undo!; setToast(null); void u(); }}>
              ביטול
            </button>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

/** The ledger facts the secretary's "שילמת?" sheet reads — from the item, never a second fetch. */
function paidObligation(item: SourceItem): ObligationApi {
  const d = item.details ?? {};
  return {
    obligeeName: item.title,
    amount: String(d.amount ?? ""),
    ledger: { remaining: String(d.remaining ?? d.amount ?? ""), commitmentId: Number(d.commitmentId), installmentId: Number(d.installmentId) },
  } as unknown as ObligationApi;
}

// ── header ──────────────────────────────────────────────────────────────────────────────────────

function Header({ agenda, onNew }: { agenda: AgendaResponse | null; onNew: () => void }) {
  const day = agenda?.dayKey ?? todayKey();
  let counter: ReactNode = null;
  let partial = false;
  if (agenda) {
    partial = agenda.countPartial;
    if (agenda.emptyAllowed) counter = <>הרשימה שלמה{agenda.doneToday ? ` · ${agenda.doneToday} בוצעו` : ""}</>;
    else if (partial) counter = <><b>{agenda.count}+</b> · חלקי</>;
    else counter = <><b>{agenda.count}</b> לטיפול היום{agenda.doneToday ? ` · ${agenda.doneToday} בוצעו` : ""}</>;
  }
  return (
    <header className={s.top}>
      <h1 className={s.title}>היום שלי</h1>
      <div className={s.mobileLine}>
        <span className={s.date}>{longDate(day)}</span>
      </div>
      <span className={s.grow} />
      {counter ? (
        <span className={`${s.counter} ${partial ? s.counterPartial : ""}`} aria-live="polite">{counter}</span>
      ) : null}
      <button type="button" className={`${s.btn} ${s.pri} ${s.newBtn}`} onClick={onNew}>
        <IconPlus /> משימה חדשה
      </button>
    </header>
  );
}

// ── quick add (desktop) ─────────────────────────────────────────────────────────────────────────

function QuickAdd({ inputRef, act }: { inputRef: React.RefObject<HTMLInputElement | null>; act: (fn: () => Promise<unknown>, done?: string) => Promise<boolean> }) {
  const [v, setV] = useState("");
  const intent = useRef(uuidV7());
  return (
    <form
      className={s.quickadd}
      onSubmit={async (e) => {
        e.preventDefault();
        const title = v.trim();
        if (!title) return;
        const ok = await act(() => createTask(intent.current, { title, dueOn: todayKey(), link: null }), "נוספה משימה להיום");
        if (ok) {
          setV("");
          intent.current = uuidV7();
        }
      }}
    >
      <IconPlus />
      <label className={s.sr} htmlFor="quick-add">הוסף משימה להיום</label>
      <input id="quick-add" ref={inputRef} value={v} maxLength={200} onChange={(e) => setV(e.target.value)} placeholder="הוסף משימה להיום… (Enter לשמירה)" autoComplete="off" />
      <span className={s.kbd} aria-hidden>N</span>
    </form>
  );
}

// ── banners (8.7) ───────────────────────────────────────────────────────────────────────────────

function Banners({ agenda, syncing, retrySync, reload }: { agenda: AgendaResponse; syncing: boolean; retrySync: () => void; reload: () => Promise<void> }) {
  const failed = agenda.sources.filter((x) => x.status === "FAILED");
  const capped = agenda.sources.filter((x) => x.status === "CAPPED");
  return (
    <>
      {agenda.integrity.includes("SYNC_FAILED") ? (
        <div className={`${s.banner} ${s.bannerBad}`} role="alert">
          <IconAlert />
          <span>לא הצלחנו לעדכן את הרשימה. מה שמוצג עשוי להיות חלקי.</span>
          <span className={s.grow} />
          <button type="button" className={s.btn} onClick={retrySync} disabled={syncing}>{syncing ? "מעדכן…" : "נסה שוב"}</button>
        </div>
      ) : agenda.integrity.includes("REPAIR_PENDING") ? (
        <div className={`${s.banner} ${s.bannerInfo}`} role="status">מעדכנים את הרשימה…</div>
      ) : null}
      {failed.map((f) => (
        <div key={f.kind} className={`${s.banner} ${s.bannerSource}`} role="alert">
          <IconAlert />
          <span>לא הצלחנו לטעון {f.name}</span>
          <span className={s.grow} />
          <button type="button" className={`${s.btn} ${s.ghost}`} onClick={() => void reload()}>נסה שוב</button>
        </div>
      ))}
      {capped.length ? (
        <div className={`${s.banner} ${s.bannerInfo}`} role="status">
          יש עוד פריטים ב{capped.map((c) => c.name).join(", ")} מעבר למה שמוצג כאן — הרשימה המלאה במסך עצמו.
        </div>
      ) : null}
    </>
  );
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

function AgendaList({
  agenda,
  bp,
  selected,
  open,
  setOpen,
  onSelect,
  onComplete,
  onNew,
}: {
  agenda: AgendaResponse;
  bp: "mobile" | "tablet" | "desktop";
  selected: string | null;
  open: Record<string, boolean>;
  setOpen: (k: string, v: boolean) => void;
  onSelect: (key: string) => void;
  onComplete: (row: Extract<AgendaRow, { type: "TASK" }>) => void;
  onNew: () => void;
}) {
  const counted = agenda.buckets.filter((b) => b.bucket === "OVERDUE" || b.bucket === "TODAY");
  const showEmpty = agenda.emptyAllowed && counted.every((b) => b.total === 0);
  return (
    <>
      {showEmpty ? (
        <section className={s.empty} aria-live="polite">
          <span className={s.ring}><IconCheck size={30} /></span>
          <h2>הכול תחת שליטה להיום</h2>
          <span>אין פריט שדורש אותך היום.{agenda.doneToday ? ` ${agenda.doneToday} בוצעו.` : ""}</span>
          <button type="button" className={`${s.btn} ${s.pri}`} onClick={onNew}>משימה חדשה</button>
        </section>
      ) : null}
      {agenda.buckets.map((b) => {
        // Desktop shows "בהמשך השבוע" in its own column; tablet and mobile fold the two quiet buckets.
        if (b.bucket === "UPCOMING" && bp === "desktop") return null;
        if (b.total === 0) return null;
        const foldable = b.bucket === "NO_DATE" || b.bucket === "UPCOMING";
        const folded = foldable && bp !== "desktop" && !open[b.bucket];
        const capped = !foldable && !open[b.bucket] && b.shown < b.total;
        const visible = folded ? [] : capped ? b.rows.slice(0, b.shown) : b.rows;
        return (
          <BucketSection
            key={b.bucket}
            b={b}
            rows={visible}
            fold={
              folded ? { label: `הצג ${b.items}`, on: () => setOpen(b.bucket, true) }
              : capped ? { label: `עוד ${b.total - b.shown}`, on: () => setOpen(b.bucket, true) }
              : foldable && bp !== "desktop" ? { label: "הסתר", on: () => setOpen(b.bucket, false) }
              : null
            }
            selected={selected}
            onSelect={onSelect}
            onComplete={onComplete}
            compact={bp === "tablet"}
          />
        );
      })}
    </>
  );
}

function BucketSection({
  b,
  rows,
  fold,
  selected,
  onSelect,
  onComplete,
  compact,
}: {
  b: BucketView;
  rows: AgendaRow[];
  fold: { label: string; on: () => void } | null;
  selected: string | null;
  onSelect: (key: string) => void;
  onComplete: (row: Extract<AgendaRow, { type: "TASK" }>) => void;
  compact: boolean;
}) {
  const id = `bucket-${b.bucket}`;
  return (
    <section className={s.bucket} aria-labelledby={id}>
      <h2 id={id} className={`${s.bucketHead} ${b.bucket === "OVERDUE" ? s.bucketOver : ""}`}>
        {b.title} <span className={s.n}>{b.items}</span>
        {fold ? (
          <button type="button" className={s.fold} onClick={fold.on}>{fold.label}</button>
        ) : null}
      </h2>
      {rows.length ? (
        <div className={s.rows} role="list">
          {rows.map((r) => (
            <Row key={r.key} row={r} selected={selected === r.key} onSelect={onSelect} onComplete={onComplete} compact={compact} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Tags({ tags }: { tags: Tag[] }) {
  if (!tags.length) return null;
  return (
    <span className={s.tags}>
      {tags.map((t, i) => (
        <span key={i} className={`${s.tag} ${s[`tag_${t.tone}`]}`}>{t.text}</span>
      ))}
    </span>
  );
}

function Row({
  row,
  selected,
  onSelect,
  onComplete,
  compact,
}: {
  row: AgendaRow;
  selected: boolean;
  onSelect: (key: string) => void;
  onComplete: (row: Extract<AgendaRow, { type: "TASK" }>) => void;
  compact: boolean;
}) {
  const cls = `${s.row} ${selected ? s.rowSel : ""} ${(row.type === "SOURCE" && row.dimmed) || row.type === "REPAIR" ? s.rowDim : ""}`;
  const select = () => onSelect(row.key);
  const keySelect = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select();
    }
  };
  const common = { className: cls, role: "listitem", tabIndex: 0, onClick: select, onKeyDown: keySelect, "aria-current": selected ? ("true" as const) : undefined };

  if (row.type === "TASK") {
    const t = row.task;
    const fact = t.link?.label ? `קשור ל: ${t.link.label}` : t.note ? t.note : null;
    return (
      <div {...common}>
        <button
          type="button"
          className={s.chk}
          aria-label={`סמן כבוצע: ${t.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onComplete(row);
          }}
        />
        <div className={s.rbody}>
          <span className={s.rtitle}>{t.title}</span>
          {fact ? <span className={s.rfact}>{fact}</span> : null}
          <Tags tags={row.tags} />
        </div>
      </div>
    );
  }
  if (row.type === "REPAIR") {
    return (
      <div {...common}>
        <button type="button" className={s.chk} disabled aria-label="המשימה מתעדכנת" onClick={(e) => e.stopPropagation()} />
        <div className={s.rbody}>
          <span className={s.rtitle}>{row.repair.title}</span>
          <Tags tags={row.tags} />
        </div>
      </div>
    );
  }
  if (row.type === "QUEUE") {
    return (
      <div {...common}>
        <DomainIcon kind={row.sourceKind} />
        <div className={s.rbody}>
          <span className={s.rtitle}>{row.title}</span>
          <span className={s.rfact}>{row.fact}</span>
          <Tags tags={row.tags} />
        </div>
        <Link href={row.action.href} prefetch={false} className={`${s.btn} ${s.soft}`} onClick={(e) => e.stopPropagation()}>
          {row.action.label}
        </Link>
      </div>
    );
  }
  const it = row.item;
  return (
    <div {...common}>
      <DomainIcon kind={it.sourceKind} />
      <div className={s.rbody}>
        <span className={s.rtitle}>{it.title}</span>
        {it.fact ? <span className={s.rfact}>{it.fact}</span> : null}
        <Tags tags={row.tags} />
      </div>
      {!compact ? (
        <Link href={it.action.href} prefetch={false} className={`${s.btn} ${s.soft} ${s.rowAction}`} onClick={(e) => e.stopPropagation()}>
          {it.action.label}
        </Link>
      ) : null}
      <button
        type="button"
        className={s.more}
        aria-label={`פעולות נוספות: ${it.title}`}
        onClick={(e) => {
          e.stopPropagation();
          select();
        }}
      >
        <IconDots />
      </button>
    </div>
  );
}

// ── week column (desktop) ───────────────────────────────────────────────────────────────────────

function WeekColumn({ agenda, onSelect }: { agenda: AgendaResponse; onSelect: (key: string) => void }) {
  const upcoming = agenda.buckets.find((b) => b.bucket === "UPCOMING")?.rows ?? [];
  const label = (r: AgendaRow) =>
    r.type === "TASK" ? r.task.title : r.type === "SOURCE" ? r.item.title : r.type === "REPAIR" ? r.repair.title : r.title;
  const day = (r: AgendaRow) =>
    r.type === "TASK" ? r.task.dueOn : r.type === "SOURCE" ? r.item.dueOn : r.type === "REPAIR" ? r.repair.dueOn : null;
  return (
    <>
      <section className={s.card} aria-labelledby="week-upcoming">
        <h2 id="week-upcoming">בהמשך השבוע</h2>
        {upcoming.length ? (
          upcoming.map((r) => (
            <button key={r.key} type="button" className={s.mini} onClick={() => onSelect(r.key)}>
              <span>{label(r)}</span>
              <span>{day(r) ? short(day(r)!) : ""}</span>
            </button>
          ))
        ) : (
          <p className={s.quiet}>אין משהו מתוכנן לשבוע הקרוב.</p>
        )}
      </section>
      <section className={s.card} aria-labelledby="week-series">
        <h2 id="week-series">משימות חוזרות</h2>
        {agenda.series.length ? (
          agenda.series.map((x) => (
            <div key={x.id} className={s.mini} style={{ cursor: "default" }}>
              <span>{x.title}</span>
              <span>{x.paused ? "מושהית" : x.cadence}</span>
            </div>
          ))
        ) : (
          <p className={s.quiet}>אין עדיין משימות חוזרות. אפשר ליצור אחת בטופס, ב&quot;חזרה&quot;.</p>
        )}
      </section>
    </>
  );
}

// ── loading ─────────────────────────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <section className={s.bucket} aria-busy="true" aria-label="טוען משימות">
      <div className={s.rows}>
        {[72, 55, 64, 48, 60].map((w, i) => (
          <div key={i} className={s.skel}>
            <span className={s.bar} style={{ width: 22, height: 22, borderRadius: 11 }} />
            <span className={s.bar} style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </section>
  );
}

