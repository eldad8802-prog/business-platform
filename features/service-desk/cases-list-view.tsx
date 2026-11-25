/**
 * Service Desk («תיקונים ושירות») — the cases list (the module's entry screen). Presentational only: the data, the filter
 * and the query come in as props, so the same view renders the live screen and the design previews. Hebrew, RTL, mobile
 * first.
 *
 * Owner decisions: the list IS the entry (no dashboard); search + three filters; «ממתינים לך» first — only the cases whose
 * next step is the business's and overdue, each with its explained reason (2026-11-24); every other active case shows its
 * next step in a quiet line, so nothing disappears; the item first, then the case number and the customer.
 */
import type { ReactNode } from "react";

import {
  attentionReason, buildListSections, caseNoun, formatShortDate, LIST_FILTERS, nextStepHint, statusLabel, statusTone,
  type CaseRowData, type ListFilter,
} from "./cases-model";
import s from "./cases.module.css";

export type CasesListViewProps = {
  rows: readonly CaseRowData[];
  now: Date;
  filter: ListFilter;
  query: string;
  onFilter: (f: ListFilter) => void;
  onQuery: (q: string) => void;
  /** The head's back control (the live screen passes Dubiz's BackButton). */
  back: ReactNode;
  caseHref: (id: number) => string;
  settingsHref: string;
  readOnly?: boolean;
  openCaseEnabled?: boolean;
  newCaseHref?: string;
  /** Set while the business has not chosen its activity types yet (decision 1): a banner to the activation screen. */
  setupHref?: string | null;
};

function SearchIcon() {
  return (
    <svg className={s.searchIcon} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
    </svg>
  );
}

/** The row's title: the item / system when there is one, else the customer (a remote call, a service without an item). */
function rowTitle(row: CaseRowData): string {
  return row.subjectName?.trim() || row.customerName?.trim() || "ללא שם";
}

function Row({ row, reason, now, href }: { row: CaseRowData; reason?: string; now: Date; href: string }) {
  const tone = statusTone(row.status, row.holdReason);
  const noun = caseNoun(row.kind);
  const hasSubject = !!row.subjectName?.trim();
  const meta = [`${noun === "קריאה" ? "קריאה " : ""}#${row.caseNumber}`, hasSubject ? row.customerName ?? "לקוח ללא שם" : null, row.problemExcerpt?.trim() || null]
    .filter((x): x is string => !!x).join(" · ");
  const hint = reason ? null : nextStepHint(row);
  return (
    <li>
      <a className={s.row} href={href}>
        <span className={s.rowMain}>
          <span className={s.rowTitle}>{rowTitle(row)}</span>
          <span className={s.rowMeta}>{meta}</span>
          {reason ? <span className={s.rowReason}>{reason}</span> : hint ? <span className={s.rowHint}>{hint}</span> : null}
        </span>
        <span className={s.rowSide}>
          <span className={s.pill} data-tone={tone}>{statusLabel(row.status, row.holdReason)}</span>
          <span className={s.rowDate}>{formatShortDate(row.updatedAt, now)}</span>
        </span>
      </a>
    </li>
  );
}

export function CasesListView(p: CasesListViewProps) {
  const sections = buildListSections(p.rows, { filter: p.filter, query: p.query, now: p.now });
  const active = buildListSections(p.rows, { filter: "all", query: "", now: p.now });
  const counts: Record<ListFilter, number> = {
    all: active.shown,
    attention: active.attention.length,
    active: 0,
    ready: buildListSections(p.rows, { filter: "ready", query: "", now: p.now }).shown,
    closed: buildListSections(p.rows, { filter: "closed", query: "", now: p.now }).shown,
  };
  const searching = p.query.trim() !== "";
  const nothing = sections.shown === 0;
  const canOpen = !p.readOnly && p.openCaseEnabled;

  return (
    <main className={s.screen} data-page-intent="content" dir="rtl">
      <div className={s.wrap}>
        <header className={s.head}>
          {p.back}
          <div className={s.headTitles}>
            <h1 className={s.title}>תיקונים ושירות</h1>
            <p className={s.subtitle}>{counts.all} פעילים{counts.attention ? ` · ${counts.attention} ממתינים לך` : ""}</p>
          </div>
          <a className={s.iconButton} href={p.settingsHref} aria-label="הגדרות"><SettingsIcon /></a>
        </header>

        <div className={s.toolbar}>
          <label className={s.searchBox}>
            <span className={s.srOnly}>חיפוש תיקים</span>
            <SearchIcon />
            <input
              className={s.search}
              type="search"
              inputMode="search"
              placeholder="חיפוש: לקוח, פריט או מספר תיק"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
            />
          </label>
          {canOpen ? (
            <a className={s.primary} href={p.newCaseHref ?? "/service-desk/new"}><span aria-hidden="true">+</span> תיק שירות חדש</a>
          ) : null}
        </div>
        {!p.readOnly && p.setupHref ? (
          <a className={s.msg} data-tone="ok" href={p.setupHref} data-setup-banner style={{ display: "block", textDecoration: "none", color: "inherit" }}>
            <strong>לפני שמתחילים:</strong> בוחרים את סוגי הפעילות של העסק. בחרנו מראש לפי התחום, ואפשר לשנות. ←
          </a>
        ) : null}

        <div className={s.filters} role="group" aria-label="סינון">
          {LIST_FILTERS.map((f) => (
            <button key={f.key} type="button" className={s.chip} aria-pressed={p.filter === f.key} onClick={() => p.onFilter(f.key)}>
              {f.label}
              {counts[f.key] ? <span className={s.chipCount}>{counts[f.key]}</span> : null}
            </button>
          ))}
        </div>

        {nothing ? (
          searching ? (
            <div className={s.empty}>
              <h2>לא נמצא תיק עם «{p.query.trim()}»</h2>
              <p className={s.count}>מחפשים לפי שם הלקוח, שם הפריט, מספר התיק או מילה מהתקלה.</p>
              <button type="button" className={s.secondary} onClick={() => p.onQuery("")}>לנקות את החיפוש</button>
            </div>
          ) : p.rows.length === 0 ? (
            <div className={s.empty}>
              <h2>עוד אין תיקי שירות</h2>
              <p className={s.count}>כשלקוח מביא פריט לתיקון או מזמין ביקור, פותחים כאן תיק. כל השלבים — מקליטה ועד מסירה — יופיעו בו.</p>
              {canOpen ? <a className={s.primary} href={p.newCaseHref ?? "/service-desk/new"}>לפתוח את התיק הראשון</a> : null}
            </div>
          ) : (
            <div className={s.empty}>
              <h2>{p.filter === "closed" ? "אין תיקים סגורים" : p.filter === "ready" ? "אין תיקים מוכנים" : "אין תיקים פעילים"}</h2>
              <p className={s.count}>תיקים יופיעו כאן כשיגיעו לשלב הזה.</p>
            </div>
          )
        ) : null}

        {p.filter === "all" && !searching && !nothing && sections.attention.length === 0 ? (
          <p className={s.calm} role="status"><span aria-hidden="true">✓</span> אין כרגע תיקים שממתינים לך</p>
        ) : null}

        {sections.attention.length ? (
          <section aria-label="ממתינים לך">
            <h2 className={s.groupTitle}><span className={s.groupDot} aria-hidden="true" />ממתינים לך · {sections.attention.length}</h2>
            <ul className={s.list}>
              {sections.attention.map(({ row, reason }) => <Row key={row.id} row={row} reason={reason} now={p.now} href={p.caseHref(row.id)} />)}
            </ul>
          </section>
        ) : null}

        {sections.rest.length ? (
          <section aria-label="שאר התיקים">
            {p.filter === "all" && !searching ? <h2 className={s.groupTitle}>בעבודה · {sections.rest.length}</h2> : null}
            <ul className={s.list}>
              {sections.rest.map((row) => <Row key={row.id} row={row} reason={p.filter !== "all" ? attentionReason(row, p.now) ?? undefined : undefined} now={p.now} href={p.caseHref(row.id)} />)}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
