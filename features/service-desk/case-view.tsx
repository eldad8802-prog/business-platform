/**
 * Service Desk UI 1.3 — the case screen. Presentational only (data in, nothing fetched), so it renders the live screen
 * and the design previews alike. Hebrew, RTL, mobile first; on desktop a main column and a side column.
 *
 * Owner decisions: the status and the next action lead; collapsible sections, and the ones that need attention open by
 * themselves; long information in its own section; a full history; fields and sections follow the activity (a repair
 * at the business shows intake and handover, a service call does not). Actions are wired in the next step — the main
 * button is shown, not active, until then.
 */
import type { ReactNode } from "react";

import type { CaseActionDef } from "./case-actions-model";
import {
  caseNoun, caseSections, eventLabel, formatShortDate, historyItems, nextActionLabel, statusLabel, statusTone,
  type CaseCardData, type JournalItem, type SectionKey,
} from "./cases-model";
import s from "./cases.module.css";

export type CaseViewProps = {
  card: CaseCardData;
  events: readonly JournalItem[];
  now: Date;
  back: ReactNode;
  /** The actions the model offers for this case (primary first). Empty / absent = view only (read-only mode). */
  actions?: readonly CaseActionDef[];
  onAction?: (def: CaseActionDef) => void;
  busyId?: string | null;
  message?: { tone: "error" | "ok"; text: string } | null;
};

function Caret() {
  return (
    <svg className={s.caret} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function sectionBody(key: SectionKey, c: CaseCardData, events: readonly JournalItem[], now: Date): { hint?: string; body: ReactNode } {
  const held = c.kind === "IN_SHOP";
  switch (key) {
    case "details":
      return {
        body: (
          <dl className={s.fields}>
            {c.subjectName ? <Field label={held ? "פריט" : "מערכת"}>{c.subjectName}</Field> : null}
            <Field label={held ? "התקלה" : "תיאור העבודה"}>{c.problemDescription ?? "—"}</Field>
            <Field label="נפתח">{formatShortDate(c.openedAt, now)}</Field>
            {c.coverage ? <Field label="כיסוי">{c.coverage.decision === "APPROVED" ? "אחריות מאושרת" : "בבדיקת אחריות"}</Field> : null}
            {c.parentCaseId ? <Field label="טיפול חוזר">מקושר לתיק קודם</Field> : null}
          </dl>
        ),
      };
    case "intake":
      return c.intake
        ? {
          hint: c.intake.conditionRecorded && c.intake.accessoriesRecorded ? "הושלמה" : "חסרים פרטים",
          body: (
            <dl className={s.fields}>
              <Field label="מצב הפריט">{c.intake.conditionNote ?? (c.intake.conditionRecorded ? "נרשם" : "לא נרשם")}</Field>
              <Field label="אביזרים">{c.intake.accessoriesNote ?? (c.intake.accessoriesRecorded ? "נרשמו" : "לא נרשמו")}</Field>
            </dl>
          ),
        }
        : { hint: "עוד לא בוצעה", body: <p className={s.muted}>הקליטה מתעדת את מצב הפריט והאביזרים לפני תחילת העבודה.</p> };
    case "quote":
      return c.status === "QUOTE_PENDING"
        ? { hint: "ממתינה לתשובה", body: <p className={s.muted}>הצעת המחיר נשלחה ללקוח. התשובה תירשם כאן.</p> }
        : { body: <p className={s.muted}>אין הצעת מחיר פתוחה.</p> };
    case "checks":
      return c.status === "QA"
        ? { hint: "בתהליך", body: <p className={s.muted}>רשימת הבדיקות של סוג העבודה תופיע כאן.</p> }
        : { body: <p className={s.muted}>הבדיקות מופעלות לפי הגדרות העסק לסוג העבודה.</p> };
    case "handover":
      return c.status === "READY"
        ? { hint: "מוכן", body: <p className={s.muted}>מסירה בלחיצה אחת, עם תיעוד המועד ואישור בעל העסק.</p> }
        : { body: <p className={s.muted}>{c.stamps.deliveredAt ? `נמסר ב־${formatShortDate(c.stamps.deliveredAt, now)}` : "עוד לא נמסר."}</p> };
    case "history": {
      const items = historyItems(events);
      return {
        hint: items.length ? `${items.length} עדכונים` : undefined,
        body: items.length ? (
          <ol className={s.timeline}>
            {items.map((e) => (
              <li key={e.seq}>
                <span className={s.dot} aria-hidden="true" />
                <span className={s.tlText}>{eventLabel(e)}</span>
                <span className={s.tlDate}>{formatShortDate(e.occurredAt, now)}</span>
              </li>
            ))}
          </ol>
        ) : <p className={s.muted}>אין עדיין עדכונים.</p>,
      };
    }
  }
}

export function CaseView({ card, events, now, back, actions = [], onAction, busyId = null, message = null }: CaseViewProps) {
  const noun = caseNoun(card.kind);
  const tone = statusTone(card.status, card.holdReason);
  const next = nextActionLabel(card.status, card.kind);
  const sections = caseSections(card);
  const main = sections.filter((x) => x.key !== "history");
  const history = sections.find((x) => x.key === "history");

  return (
    <main className={s.screen} data-page-intent="content" dir="rtl">
      <div className={`${s.wrap} ${s.wrapWide}`}>
        <header className={s.head}>
          {back}
          <div className={s.headTitles}>
            <h1 className={s.title}>{noun} #{card.caseNumber}</h1>
            <p className={s.subtitle}>{card.customerName ?? "לקוח ללא שם"}</p>
          </div>
        </header>

        <section className={s.statusCard} aria-label="מצב ופעולה הבאה">
          <div>
            <div className={s.statusTop}>
              <span className={s.pill} data-tone={tone}>{statusLabel(card.status)}</span>
              <span className={s.statusMeta}>עודכן {formatShortDate(card.updatedAt, now)}</span>
            </div>
            {next ? (
              <>
                <p className={s.nextLabel} style={{ marginTop: 12 }}>הפעולה הבאה</p>
                <p className={s.nextText}>{next}</p>
              </>
            ) : <p className={s.nextText} style={{ marginTop: 12 }}>ה{noun} סגור</p>}
          </div>
          {actions.length ? (
            <div className={s.statusActions}>
              {actions.filter((a) => a.tone !== "danger").map((a) =>
                a.target.endpoint === "link" ? (
                  <a key={a.id} className={a.tone === "primary" ? s.primary : s.secondary} href={a.target.href}>{a.label}</a>
                ) : (
                  <button key={a.id} type="button" className={a.tone === "primary" ? s.primary : s.secondary} disabled={busyId !== null}
                    onClick={() => onAction?.(a)}>{busyId === a.id ? "שומר…" : a.label}</button>
                ))}
            </div>
          ) : null}
        </section>
        {message ? <p className={s.msg} data-tone={message.tone} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p> : null}

        <div className={s.columns}>
          <div className={s.mainCol}>
            {main.map((sec) => {
              const { hint, body } = sectionBody(sec.key, card, events, now);
              return (
                <details key={sec.key} className={s.section} open={sec.open}>
                  <summary>
                    <span>{sec.title} {hint ? <span className={s.sectionHint}>· {hint}</span> : null}</span>
                    <Caret />
                  </summary>
                  <div className={s.sectionBody}>{body}</div>
                </details>
              );
            })}
          </div>
          <aside className={s.sideCol} aria-label="לקוח והיסטוריה">
            <div className={s.infoCard}>
              <p className={s.infoTitle}>לקוח</p>
              <p className={s.infoMain}>{card.customerName ?? "לקוח ללא שם"}</p>
            </div>
            {actions.some((a) => a.tone === "danger") ? (
              <div className={s.infoCard}>
                {actions.filter((a) => a.tone === "danger").map((a) => (
                  <button key={a.id} type="button" className={s.dangerLink} disabled={busyId !== null} onClick={() => onAction?.(a)}>{a.label}</button>
                ))}
              </div>
            ) : null}
            {history ? (() => {
              const { hint, body } = sectionBody("history", card, events, now);
              return (
                <details className={s.section} open>
                  <summary>
                    <span>{history.title} {hint ? <span className={s.sectionHint}>· {hint}</span> : null}</span>
                    <Caret />
                  </summary>
                  <div className={s.sectionBody}>{body}</div>
                </details>
              );
            })() : null}
          </aside>
        </div>
      </div>
    </main>
  );
}
