"use client";

/**
 * Service Desk («תיקונים ושירות») — the case screen, presentational (data in, nothing fetched), in four zones (owner
 * decision 2026-11-24):
 *   ① the head — the item / subject, the case number, the customer, the status (and a call button when a phone is known);
 *   ② the next action — what the stage is, what to do now, ONE main action that can always be pressed (a step that waits
 *      for an earlier one leads to that step instead of a locked button), secondary actions only when they apply;
 *   ③ what matters now — only the panels of the current stage;
 *   ④ «עוד» and the history — everything else, closed rows with a one-line summary; the latest history lines, then all.
 * Hebrew, RTL, mobile first; on desktop the main column and a side column (④).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { CaseActionDef } from "./case-actions-model";
import {
  attentionReason, caseNoun, formatShortDate, mergedHistory, nextActionLabel, statusLabel, statusTone,
  type CaseCardData, type HistoryNames, type JournalItem, type NextActionContext, type SideHistoryItem,
} from "./cases-model";
import s from "./cases.module.css";

export type MoreItem = { key: string; title: string; summary?: string | null; body: ReactNode };
export type Step = { label: string; detail?: string | null; state: "done" | "current" | "todo" };

export type CaseViewProps = {
  card: CaseCardData;
  events: readonly JournalItem[];
  /** Records kept outside the journal (loans, pickup calls), with their own stored times — merged into the history. */
  sideHistory?: readonly SideHistoryItem[];
  /** Names for ids the journal stores (loans, tasks), from what the screen already read. */
  historyNames?: HistoryNames;
  /** What is already done, so the "next action" never names a finished step. */
  nextCtx?: NextActionContext;
  now: Date;
  back: ReactNode;
  /** The actions the model offers for this case (primary first). Empty / absent = view only (read-only mode). */
  actions?: readonly CaseActionDef[];
  onAction?: (def: CaseActionDef) => void;
  busyId?: string | null;
  message?: { tone: "error" | "ok"; text: string } | null;
  /** Reminders under the wait reason (an open loan at handover, the pickup calls) — never a block. */
  notes?: readonly string[];
  /** The steps the next action belongs to (e.g. 1 set the charge, 2 hand over). */
  steps?: readonly Step[];
  /** ③ — the panels of the current stage. */
  nowPanels?: ReactNode;
  /** ④ — everything else, as closed rows. */
  more?: readonly MoreItem[];
  /** A "tel:" link when the customer's phone is known (the head's call button). */
  callHref?: string | null;
  /** Shown above everything when set (the case changed elsewhere, with a way to refresh). */
  banner?: ReactNode;
};

function Caret() {
  return (
    <svg className={s.caret} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  );
}

/** The ⋯ menu: the destructive actions (cancel) live here, never as a red button in the middle of the screen. */
function CaseMenu({ items, busy, onPick }: { items: readonly CaseActionDef[]; busy: boolean; onPick: (d: CaseActionDef) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (!items.length) return null;
  return (
    <div className={s.menuWrap} ref={ref}>
      <button type="button" className={s.iconButton} aria-label="עוד פעולות" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <MenuIcon />
      </button>
      {open ? (
        <div className={s.menu} role="menu">
          {items.map((a) => (
            <button key={a.id} type="button" role="menuitem" className={s.menuItem} data-tone={a.tone} disabled={busy} onClick={() => { setOpen(false); onPick(a); }}>{a.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const HISTORY_PREVIEW = 3;

export function CaseView(p: CaseViewProps) {
  const { card, events, now } = p;
  const actions = p.actions ?? [];
  const noun = caseNoun(card.kind);
  const tone = statusTone(card.status, card.holdReason);
  const next = nextActionLabel(card.status, card.kind, card.holdReason, p.nextCtx ?? {});
  const waiting = attentionReason(card, now);
  const main = actions.filter((a) => a.tone !== "danger");
  const menu = actions.filter((a) => a.tone === "danger");
  const blocked = main.filter((a) => a.blockedReason);
  const title = card.subjectName?.trim() || card.customerName?.trim() || `${noun} #${card.caseNumber}`;
  const meta = [`${noun} #${card.caseNumber}`, card.subjectName?.trim() ? card.customerName ?? "לקוח ללא שם" : null].filter(Boolean).join(" · ");
  const history = mergedHistory(events, p.sideHistory ?? [], p.historyNames ?? {});
  const [allHistory, setAllHistory] = useState(false);
  const shownHistory = allHistory ? history : history.slice(0, HISTORY_PREVIEW);
  const finished = !next;
  const busy = p.busyId !== null && p.busyId !== undefined;

  const actionButton = (a: CaseActionDef, primary: boolean) =>
    a.target.endpoint === "link" ? (
      <a key={a.id} className={primary ? s.primary : s.secondary} href={a.target.href}>{a.label}</a>
    ) : (
      <button key={a.id} type="button" className={primary ? s.primary : s.secondary} disabled={busy || !!a.blockedReason}
        aria-describedby={a.blockedReason ? `sd-blocked-${a.id}` : undefined}
        onClick={() => p.onAction?.(a)}>{p.busyId === a.id ? "שומר…" : a.label}</button>
    );

  return (
    <main className={s.screen} data-page-intent="content" dir="rtl">
      <div className={`${s.wrap} ${s.wrapWide}`}>
        <div className={s.topBar}>
          {p.back}
          <CaseMenu items={menu} busy={busy} onPick={(a) => p.onAction?.(a)} />
        </div>

        {/* ① the head */}
        <header className={s.caseHead} aria-label="כותרת התיק">
          <div className={s.caseHeadText}>
            <h1 className={s.caseTitle}>{title}</h1>
            <div className={s.caseMeta}>
              <span>{meta}</span>
              <span className={s.pill} data-tone={tone}>{statusLabel(card.status)}</span>
            </div>
          </div>
          {p.callHref ? (
            <a className={s.callButton} href={p.callHref} aria-label={`להתקשר ל${card.customerName ?? "לקוח"}`}><PhoneIcon /></a>
          ) : null}
        </header>

        {p.banner}

        {/* ② the next action */}
        <section className={finished ? s.doneCard : s.nextCard} data-tone={finished ? tone : undefined} aria-label="מצב ופעולה הבאה">
          {finished ? (
            <>
              <p className={s.doneTitle}>
                {card.status === "DELIVERED" ? `ה${noun} נמסר ללקוח` : card.status === "CANCELLED" ? `ה${noun} בוטל` : card.status === "ABANDONED" ? "הפריט לא נאסף" : `ה${noun} ${noun === "קריאה" ? "סגורה" : "סגור"}`}
              </p>
              <p className={s.doneMeta}>עודכן {formatShortDate(card.updatedAt, now)} · אין פעולות נוספות</p>
            </>
          ) : (
            <>
              <p className={s.nextLabel}>הפעולה הבאה{waiting ? ` · ${waiting}` : ""}</p>
              <p className={s.nextText}>{next}</p>
              {(p.notes ?? []).map((n) => <p key={n} className={s.statusWait} data-note>{n}</p>)}
              {p.steps?.length ? (
                <ol className={s.steps} aria-label="שלבים">
                  {p.steps.map((st, i) => (
                    <li key={st.label} data-state={st.state}>
                      <span className={s.stepDot} aria-hidden="true">{st.state === "done" ? "✓" : i + 1}</span>
                      <span><strong>{st.label}</strong>{st.detail ? <span className={s.stepDetail}> · {st.detail}</span> : null}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {blocked.map((a) => <p key={a.id} id={`sd-blocked-${a.id}`} className={s.blockedNote} role="note">{a.blockedReason}</p>)}
              {main.length ? (
                <div className={s.statusActions}>
                  {main.map((a, i) => actionButton(a, i === 0))}
                </div>
              ) : null}
            </>
          )}
        </section>
        {p.message ? <p className={s.msg} data-tone={p.message.tone} role={p.message.tone === "error" ? "alert" : "status"}>{p.message.text}</p> : null}

        <div className={s.columns}>
          {/* ③ what matters now */}
          <div className={s.mainCol}>
            {p.nowPanels}
          </div>

          {/* ④ more + history */}
          <aside className={s.sideCol} aria-label="עוד והיסטוריה">
            {p.more?.length ? (
              <div className={s.moreList}>
                <p className={s.zoneTitle}>עוד</p>
                {p.more.map((m) => (
                  <details key={m.key} className={s.section} data-more={m.key}>
                    <summary>
                      <span>{m.title}{m.summary ? <span className={s.sectionHint}> · {m.summary}</span> : null}</span>
                      <Caret />
                    </summary>
                    <div className={s.sectionBody}>{m.body}</div>
                  </details>
                ))}
              </div>
            ) : null}
            <section className={s.infoCard} aria-label="היסטוריה">
              <p className={s.historyTitle}>היסטוריה <span className={s.sectionHint}>· {history.length ? `${history.length} פעולות` : "אין עדיין"}</span></p>
              {shownHistory.length ? (
                <ol className={s.timeline}>
                  {shownHistory.map((e) => (
                    <li key={e.key}>
                      <span className={s.dot} aria-hidden="true" />
                      <span className={s.tlText}>{e.text}</span>
                      <span className={s.tlDate}>{formatShortDate(e.occurredAt, now)}{e.actor ? ` · ${e.actor}` : ""}</span>
                    </li>
                  ))}
                </ol>
              ) : <p className={s.muted}>אין עדיין עדכונים.</p>}
              {history.length > HISTORY_PREVIEW ? (
                <button type="button" className={s.secondary} aria-expanded={allHistory} onClick={() => setAllHistory((x) => !x)}>
                  {allHistory ? "להציג פחות" : `כל ההיסטוריה (${history.length})`}
                </button>
              ) : null}
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

/** The item and the problem — shown in ③ while diagnosing, otherwise in «עוד». */
export function DetailsBody({ card, now }: { card: CaseCardData; now: Date }) {
  const held = card.kind === "IN_SHOP";
  return (
    <dl className={s.fields}>
      <div className={s.field}><dt>{held ? "פריט" : "מערכת"}</dt><dd>{card.subjectName?.trim() || "לא צוין"}</dd></div>
      <div className={s.field}><dt>{held ? "התקלה" : "תיאור העבודה"}</dt><dd>{card.problemDescription ?? "—"}</dd></div>
      <div className={s.field}><dt>נפתח</dt><dd>{formatShortDate(card.openedAt, now)}</dd></div>
      {card.coverage ? <div className={s.field}><dt>כיסוי</dt><dd>{card.coverage.decision === "APPROVED" ? "אחריות מאושרת" : "בבדיקת אחריות"}</dd></div> : null}
      {card.parentCaseId ? <div className={s.field}><dt>טיפול חוזר</dt><dd>מקושר לתיק קודם</dd></div> : null}
    </dl>
  );
}

/** The intake as recorded — in «עוד» once the item was taken in. */
export function IntakeBody({ card }: { card: CaseCardData }) {
  if (!card.intake) return <p className={s.muted}>הקליטה מתעדת את מצב הפריט והאביזרים לפני תחילת העבודה.</p>;
  return (
    <dl className={s.fields}>
      <div className={s.field}><dt>מצב הפריט</dt><dd>{card.intake.conditionNote ?? (card.intake.conditionRecorded ? "נרשם" : "לא נרשם")}</dd></div>
      <div className={s.field}><dt>אביזרים</dt><dd>{card.intake.accessoriesNote ?? (card.intake.accessoriesRecorded ? "נרשמו" : "לא נרשמו")}</dd></div>
    </dl>
  );
}
