/**
 * Service Desk UI 1.3 — the case-opening form (presentational; the visual design is under the owner's review).
 * One scroll on the phone; on desktop the form and, beside it, what is known about the chosen customer.
 * Fields appear by what was chosen: a repair asks for the item and the fault; a service call for the work and the place.
 */
import type { ReactNode } from "react";

import { formatPhoneForDisplay } from "@/lib/format/phone-display";

import { formatShortDate, statusLabel, type CaseStatus } from "./cases-model";
import { draftIssues, phoneIssue, ISSUE_TEXT, TRACK_FORMS, type CustomerPick, type DraftIssue, type OpenCaseDraft, type PastCase, type Track } from "./open-case-model";
import s from "./cases.module.css";

export type OpenCaseViewProps = {
  back: ReactNode;
  now: Date;
  tracks: { first: Track[]; more: Track[] };
  showMore: boolean;
  onShowMore: () => void;
  draft: OpenCaseDraft;
  onDraft: (d: OpenCaseDraft) => void;
  customerQuery: string;
  onCustomerQuery: (q: string) => void;
  customerHits: { id: number; name: string; phone: string | null }[];
  newCustomer: { open: boolean; name: string; phone: string };
  onNewCustomer: (v: { open: boolean; name: string; phone: string }) => void;
  onCreateCustomer: () => void;
  pastCases: PastCase[];
  suggestion: { caseId: number; caseNumber: number; daysAgo: number; warrantyDays: number } | null;
  /** Show the missing-field lines (after a first attempt). */
  showIssues: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
};

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={s.infoCard} style={{ gap: 10 }}>
      {title ? <p className={s.infoTitle}>{title}</p> : null}
      {children}
    </section>
  );
}

export function OpenCaseView(p: OpenCaseViewProps) {
  const d = p.draft;
  // Shown once the number looks finished (or the owner moved on): no red line while the first digits are typed.
  const phoneProblem = p.newCustomer.phone.replace(/D/g, "").length >= 9 || /[^ds-()+]/.test(p.newCustomer.phone) ? phoneIssue(p.newCustomer.phone) : null;
  const form = d.track ? TRACK_FORMS[d.track] : null;
  const issues = p.showIssues ? draftIssues(d) : [];
  const issue = (k: DraftIssue) =>
    issues.includes(k) ? <span className={s.rowReason} role="alert">{ISSUE_TEXT[k]}</span> : null;
  const set = (patch: Partial<OpenCaseDraft>) => p.onDraft({ ...d, ...patch });
  const pick = (c: CustomerPick) => set({ customer: c, parentCaseId: null });
  const title = form ? (form.noun === "קריאה" ? "קריאה חדשה" : "תיק חדש") : "פתיחה חדשה";
  const cta = form ? (form.next === "intake" ? "לפתוח ולעבור לקליטה" : form.noun === "קריאה" ? "לפתוח קריאה" : "לפתוח תיק") : "לפתוח";
  const trackButtons = [...p.tracks.first, ...(p.showMore ? p.tracks.more : [])];

  const formColumn = (
    <div className={s.mainCol}>
      <Card title="מה פותחים?">
        <div className={s.choices} style={{ flexWrap: "wrap" }} role="group" aria-label="סוג הפעילות">
          {trackButtons.map((t) => (
            <button key={t} type="button" className={s.choice} style={{ flex: "1 1 140px" }} aria-pressed={d.track === t}
              onClick={() => set({ track: t })}>{TRACK_FORMS[t].label}</button>
          ))}
        </div>
        {!p.showMore && p.tracks.more.length ? <button type="button" className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} onClick={p.onShowMore}>עוד סוגים</button> : null}
        {issue("track")}
      </Card>

      {form ? (
        <Card title="לקוח">
          {d.customer ? (
            <div className={s.statusTop} style={{ background: "var(--sc-sunk)", borderRadius: 12, padding: "10px 12px" }}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}><strong>{d.customer.name}</strong>{d.customer.phone ? <span dir="ltr"> · {formatPhoneForDisplay(d.customer.phone)}</span> : ""}</span>
              <button type="button" className={s.dangerLink} style={{ color: "inherit" }} onClick={() => pick(null)}>להחליף</button>
            </div>
          ) : (
            <>
              <label className={s.label}>
                חיפוש לפי שם או טלפון
                <input className={s.input} id="sd-open-customer" value={p.customerQuery} onChange={(e) => p.onCustomerQuery(e.target.value)} placeholder="שם או טלפון" autoComplete="off" />
              </label>
              {p.customerHits.length ? (
                <ul className={s.list} aria-label="לקוחות שנמצאו">
                  {p.customerHits.map((c) => (
                    <li key={c.id}>
                      <button type="button" className={s.row} style={{ width: "100%", border: 0, background: "none", font: "inherit", textAlign: "start", cursor: "pointer" }} onClick={() => pick(c)}>
                        <span className={s.rowMain}><span className={s.rowCustomer}>{c.name}</span>{c.phone ? <span className={s.rowDesc} dir="ltr" style={{ textAlign: "end" }}>{formatPhoneForDisplay(c.phone)}</span> : null}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {p.newCustomer.open ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <input className={s.input} id="sd-new-customer-name" value={p.newCustomer.name} placeholder="שם הלקוח" onChange={(e) => p.onNewCustomer({ ...p.newCustomer, name: e.target.value })} />
                  <input className={s.input} id="sd-new-customer-phone" value={p.newCustomer.phone} placeholder="טלפון (לא חובה)" inputMode="tel" dir="ltr" style={{ textAlign: "end" }}
                    aria-invalid={phoneProblem ? true : undefined} aria-describedby={phoneProblem ? "sd-new-customer-phone-err" : undefined}
                    onChange={(e) => p.onNewCustomer({ ...p.newCustomer, phone: e.target.value })} />
                  {phoneProblem ? <p id="sd-new-customer-phone-err" className={s.fieldError} role="alert">{phoneProblem}</p> : null}
                  <button type="button" className={s.secondary} disabled={!p.newCustomer.name.trim() || !!phoneProblem || p.busy} onClick={p.onCreateCustomer}>להוסיף לקוח</button>
                </div>
              ) : (
                <button type="button" className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} onClick={() => p.onNewCustomer({ open: true, name: p.customerQuery, phone: "" })}>+ לקוח חדש</button>
              )}
            </>
          )}
          {issue("customer")}
        </Card>
      ) : null}

      {form ? (
        <Card title={form.experience === "repair" ? "הפריט והתקלה" : "העבודה"}>
          {form.subject ? (
            <label className={s.label}>
              {form.subject.label}
              <input className={s.input} id="sd-open-subject" value={d.subjectName} maxLength={120} placeholder={form.subject.placeholder} onChange={(e) => set({ subjectName: e.target.value, parentCaseId: null })} />
              {issue("subject")}
            </label>
          ) : null}
          {p.suggestion && !d.parentCaseId ? (
            <div className={s.msg} data-tone="ok" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span>נמצא תיק קודם על הפריט הזה: #{p.suggestion.caseNumber}, לפני {p.suggestion.daysAgo} ימים (אחריות {p.suggestion.warrantyDays} ימים).</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" className={s.secondary} onClick={() => set({ parentCaseId: p.suggestion?.caseId ?? null })}>לקשר לתיק הקודם</button>
              </span>
            </div>
          ) : null}
          {d.parentCaseId ? <p className={s.muted}>מקושר לתיק קודם. <button type="button" className={s.dangerLink} style={{ color: "inherit" }} onClick={() => set({ parentCaseId: null })}>לבטל קישור</button></p> : null}
          <label className={s.label}>
            {form.problemLabel}
            <textarea className={s.textarea} id="sd-open-problem" value={d.problem} maxLength={4000} placeholder={form.problemPlaceholder} onChange={(e) => set({ problem: e.target.value })} />
            {issue("problem")}
          </label>
          {form.address ? (
            <label className={s.label}>
              {form.address === "required" ? "כתובת לביצוע" : "כתובת (לא חובה)"}
              <input className={s.input} id="sd-open-address" value={d.siteAddress} maxLength={300} placeholder="רחוב, מספר, עיר" onChange={(e) => set({ siteAddress: e.target.value })} />
              {issue("address")}
            </label>
          ) : null}
        </Card>
      ) : null}

      {p.error ? <p className={s.msg} data-tone="error" role="alert">{p.error}</p> : null}
      {form ? (
        <div className={s.actionsRow}>
          <button type="button" className={s.primary} disabled={p.busy} onClick={p.onSubmit}>{p.busy ? "פותח…" : cta}</button>
        </div>
      ) : null}
    </div>
  );

  return (
    <main className={s.screen} data-page-intent="content" dir="rtl">
      <div className={`${s.wrap} ${s.wrapWide}`}>
        <header className={s.head}>
          {p.back}
          <div className={s.headTitles}><h1 className={s.title}>{title}</h1></div>
        </header>
        <div className={s.columns}>
          {formColumn}
          <aside className={s.sideCol} aria-label="מה ידוע על הלקוח">
            {d.customer ? (
              <Card title={`מה ידוע על ${d.customer.name}`}>
                {p.pastCases.length ? (
                  <ul className={s.timeline}>
                    {p.pastCases.slice(0, 5).map((c) => (
                      <li key={c.id}>
                        <span className={s.dot} aria-hidden="true" />
                        <span className={s.tlText}>#{c.caseNumber} · {c.subjectName ?? c.problemExcerpt ?? "ללא תיאור"} · {statusLabel(c.status as CaseStatus)}</span>
                        <span className={s.tlDate}>{formatShortDate(c.updatedAt, p.now)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className={s.muted}>אין תיקים קודמים ללקוח הזה.</p>}
                <p className={s.muted}>המידע מוצע בלבד. משתמשים בו רק אחרי אישור.</p>
              </Card>
            ) : (
              <Card><p className={s.muted}>אחרי שבוחרים לקוח, יופיעו כאן התיקים הקודמים שלו.</p></Card>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
