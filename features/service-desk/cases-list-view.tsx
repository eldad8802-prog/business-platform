/**
 * Service Desk UI 1.3 — the cases list (the module's entry screen). Presentational only: the data, the filter and the
 * query come in as props, so the same view renders the live screen and the design previews. Hebrew, RTL, mobile first.
 *
 * Owner decisions: the list IS the entry (no dashboard); search + a few filters; cases that need attention first, each
 * with its reason; a clear button to open a case — the opening form itself waits for its design approval (A8), so the
 * button says so instead of opening a form that was not approved.
 */
import type { ReactNode } from "react";

import {
  buildListSections, formatShortDate, LIST_FILTERS, rowDescription, statusLabel, statusTone,
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
  /** The opening form is not approved yet: the button is shown but not active. */
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

function Row({ row, reason, now, href }: { row: CaseRowData; reason?: string; now: Date; href: string }) {
  const tone = statusTone(row.status, row.holdReason);
  return (
    <li>
      <a className={s.row} href={href}>
        <span className={s.rowMain}>
          <span className={s.rowTop}>
            <span className={s.rowNumber}>#{row.caseNumber}</span>
            <span className={s.rowCustomer}>{row.customerName ?? "לקוח ללא שם"}</span>
          </span>
          <span className={s.rowDetail}>
            <span className={s.rowDesc}>{rowDescription(row)}</span>
            {reason ? <span className={s.rowReason}>{reason}</span> : null}
          </span>
        </span>
        <span className={s.rowSide}>
          <span className={s.pill} data-tone={tone}>{statusLabel(row.status)}</span>
          <span className={s.rowDate}>{formatShortDate(row.updatedAt, now)}</span>
        </span>
      </a>
    </li>
  );
}

export function CasesListView(p: CasesListViewProps) {
  const sections = buildListSections(p.rows, { filter: p.filter, query: p.query, now: p.now });
  const counts: Record<ListFilter, number> = {
    all: buildListSections(p.rows, { filter: "all", query: "", now: p.now }).shown,
    attention: buildListSections(p.rows, { filter: "attention", query: "", now: p.now }).shown,
    active: buildListSections(p.rows, { filter: "active", query: "", now: p.now }).shown,
    ready: buildListSections(p.rows, { filter: "ready", query: "", now: p.now }).shown,
    closed: buildListSections(p.rows, { filter: "closed", query: "", now: p.now }).shown,
  };
  const nothing = sections.shown === 0;

  return (
    <main className={s.screen} data-page-intent="content" dir="rtl">
      <div className={s.wrap}>
        <header className={s.head}>
          {p.back}
          <div className={s.headTitles}>
            <h1 className={s.title}>תיקונים ושירות</h1>
            <p className={s.subtitle}>{counts.all} פתוחים{counts.attention ? ` · ${counts.attention} דורשים טיפול` : ""}</p>
          </div>
          <a className={s.headLink} href={p.settingsHref}>הגדרות</a>
        </header>

        <div className={s.toolbar}>
          <label className={s.searchBox}>
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>חיפוש תיקים</span>
            <SearchIcon />
            <input
              className={s.search}
              type="search"
              inputMode="search"
              placeholder="חיפוש לפי לקוח, מספר תיק או תיאור"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
            />
          </label>
          {p.readOnly ? null : p.openCaseEnabled ? (
            <a className={s.primary} href={p.newCaseHref ?? "/service-desk/new"}><span aria-hidden="true">+</span> תיק חדש</a>
          ) : (
            <button type="button" className={s.primary} aria-disabled={true} disabled title="טופס הפתיחה יתווסף אחרי אישור העיצוב">
              <span aria-hidden="true">+</span> תיק חדש
            </button>
          )}
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
              {f.key !== "all" && counts[f.key] ? <span className={s.chipCount}>{counts[f.key]}</span> : null}
            </button>
          ))}
        </div>

        {nothing ? (
          <div className={s.empty}>
            <h2>{p.query.trim() ? "לא נמצאו תיקים" : p.rows.length === 0 ? "עדיין אין תיקים" : "אין תיקים בסינון הזה"}</h2>
            <p className={s.count}>{p.query.trim() ? "אפשר לחפש לפי שם הלקוח, מספר התיק או מילה מהתיאור." : "תיקים חדשים יופיעו כאן."}</p>
          </div>
        ) : null}

        {sections.attention.length ? (
          <section aria-label="דורשים טיפול">
            <h2 className={s.groupTitle}>דורשים טיפול</h2>
            <ul className={s.list}>
              {sections.attention.map(({ row, reason }) => <Row key={row.id} row={row} reason={reason} now={p.now} href={p.caseHref(row.id)} />)}
            </ul>
          </section>
        ) : null}

        {sections.rest.length ? (
          <section aria-label="שאר התיקים">
            {sections.attention.length ? <h2 className={s.groupTitle}>בעבודה</h2> : null}
            <ul className={s.list}>
              {sections.rest.map((row) => <Row key={row.id} row={row} now={p.now} href={p.caseHref(row.id)} />)}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
