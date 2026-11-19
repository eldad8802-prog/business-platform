/**
 * Service Desk UI 1.3 — the panels around a case (presentational; the visual design is under the owner's review):
 * QA checklist, quote from a billing QUOTE document, pickup calls, replacement items (loans), linked tasks, and the
 * light fields (item location, estimated date). Every panel shows what the server holds; read-only hides the controls.
 */
import { useState, type ReactNode } from "react";

import { offerableQuoteDocs, PICKUP_OUTCOME_TEXT, qaProgress, type QaResults } from "./case-extras-model";
import { formatShortDate } from "./cases-model";
import type { CaseFields, CaseQa, CaseTask, Loan, PickupCall, QuoteDoc } from "./service-desk-client";
import s from "./cases.module.css";

function Panel({ title, hint, children, id }: { title: string; hint?: string | null; children: ReactNode; id: string }) {
  return (
    <section className={s.infoCard} style={{ gap: 10 }} aria-labelledby={`${id}-t`} data-panel={id}>
      <p className={s.infoTitle} id={`${id}-t`}>{title}{hint ? <span className={s.sectionHint}> · {hint}</span> : null}</p>
      {children}
    </section>
  );
}
const Later = () => <p className={s.muted}>יהיה זמין אחרי עדכון מסד הנתונים של המערכת (A7).</p>;

// ── QA ──
export function QaPanel(p: { qa: CaseQa; editable: boolean; busy: boolean; onSave: (r: QaResults) => void }) {
  const [draft, setDraft] = useState<QaResults>(p.qa.results);
  const t = p.qa.template;
  if (!t) return null;
  const prog = qaProgress(t.items, draft, t.everyCheckRecorded);
  const set = (k: string, v: "PASS" | "FAIL") => setDraft({ ...draft, [k]: v });
  return (
    <Panel id="qa" title="בדיקות לפני מסירה" hint={p.qa.mode === "OPTIONAL" ? "לא חובה" : p.qa.completed ? "הושלמו" : `${prog.recorded} מתוך ${prog.total}`}>
      <ul className={s.timeline} style={{ gap: 8 }}>
        {t.items.map((i) => (
          <li key={i.key} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={s.tlText} style={{ flex: "1 1 160px" }}>{i.label}{i.required ? " *" : ""}</span>
            <span className={s.choices} role="group" aria-label={i.label} style={{ flex: "0 0 auto" }}>
              <button type="button" className={s.choice} style={{ whiteSpace: "nowrap", paddingInline: 14 }} aria-pressed={draft[i.key] === "PASS"} disabled={!p.editable || p.busy} onClick={() => set(i.key, "PASS")}>עבר</button>
              <button type="button" className={s.choice} style={{ whiteSpace: "nowrap", paddingInline: 14 }} aria-pressed={draft[i.key] === "FAIL"} disabled={!p.editable || p.busy} onClick={() => set(i.key, "FAIL")}>לא עבר</button>
            </span>
          </li>
        ))}
      </ul>
      {prog.failed ? <p className={s.rowReason}>{prog.failed === 1 ? "בדיקה אחת לא עברה" : `${prog.failed} בדיקות לא עברו`}. אפשר לרשום ולהחליט אם להחזיר לעבודה.</p> : null}
      {p.editable ? (
        <div className={s.actionsRow}>
          <button type="button" className={s.secondary} disabled={p.busy || prog.recorded === 0} onClick={() => p.onSave(draft)}>{p.busy ? "שומר…" : "לשמור את הבדיקות"}</button>
        </div>
      ) : null}
    </Panel>
  );
}

// ── Quote (from a billing QUOTE document; billing itself is not changed) ──
export function QuotePanel(p: { mode: "send" | "revise"; docs: QuoteDoc[]; sentDocIds: number[]; editable: boolean; busy: boolean; newQuoteHref: string; onSend: (docId: number) => void }) {
  const docs = offerableQuoteDocs(p.docs, p.sentDocIds);
  return (
    <Panel id="quote" title={p.mode === "send" ? "הצעת מחיר ללקוח" : "עדכון הצעת המחיר"} hint={p.mode === "revise" ? "ההצעה הקודמת תוחלף" : null}>
      {docs.length ? (
        <ul className={s.list} aria-label="הצעות מחיר של הלקוח">
          {docs.map((d) => (
            <li key={d.id} className={s.row} style={{ gridTemplateColumns: "1fr auto" }}>
              <span className={s.rowMain}>
                <span className={s.rowCustomer}>הצעה {d.number ?? `#${d.id}`}</span>
                <span className={s.rowDesc}>₪{Number(d.totalAmount).toLocaleString("he-IL")} · {d.status === "DRAFT" ? "טיוטה" : d.status === "ISSUED" ? "הופקה" : d.status}</span>
              </span>
              {p.editable ? <button type="button" className={s.secondary} disabled={p.busy} onClick={() => p.onSend(d.id)}>{p.mode === "send" ? "לשלוח ללקוח" : "להחליף בה"}</button> : null}
            </li>
          ))}
        </ul>
      ) : <p className={s.muted}>אין ללקוח הצעת מחיר פתוחה.</p>}
      {p.editable ? <a className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} href={p.newQuoteHref}>+ הצעת מחיר חדשה במסמכים</a> : null}
      <p className={s.muted}>ההצעה נשמרת כעותק קבוע בתיק. הלקוח מאשר בטלפון או בעסק, ואת התשובה רושמים בתיק.</p>
    </Panel>
  );
}

// ── Pickup calls (READY) ──
export function PickupPanel(p: { calls: PickupCall[]; now: Date; editable: boolean; busy: boolean; onRecord: (o: PickupCall["outcome"], note: string | null) => void }) {
  const [note, setNote] = useState("");
  return (
    <Panel id="pickup" title="תזכורות איסוף" hint={p.calls.length ? `${p.calls.length}` : null}>
      {p.calls.length ? (
        <ul className={s.timeline}>
          {p.calls.map((c) => (
            <li key={c.id}><span className={s.dot} aria-hidden="true" /><span className={s.tlText}>{PICKUP_OUTCOME_TEXT[c.outcome]}{c.note ? ` · ${c.note}` : ""}</span><span className={s.tlDate}>{formatShortDate(c.calledAt, p.now)}</span></li>
          ))}
        </ul>
      ) : <p className={s.muted}>עוד לא תועדה שיחה ללקוח.</p>}
      {p.editable ? (
        <>
          <input className={s.input} id="sd-pickup-note" value={note} maxLength={1000} placeholder="הערה (לא חובה)" onChange={(e) => setNote(e.target.value)} />
          <div className={s.choices} style={{ flexWrap: "wrap" }} role="group" aria-label="תיעוד שיחה">
            {(Object.keys(PICKUP_OUTCOME_TEXT) as PickupCall["outcome"][]).map((o) => (
              <button key={o} type="button" className={s.choice} style={{ flex: "1 1 120px" }} disabled={p.busy} onClick={() => { p.onRecord(o, note.trim() || null); setNote(""); }}>{PICKUP_OUTCOME_TEXT[o]}</button>
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ── Loans (decision 5: a reminder only) ──
export function LoansPanel(p: { available: boolean; loans: Loan[]; now: Date; editable: boolean; busy: boolean; onLend: (name: string, note: string | null) => void; onReturn: (id: number) => void }) {
  const [form, setForm] = useState({ open: false, name: "", note: "" });
  const open = p.loans.filter((l) => !l.returnedAt).length;
  return (
    <Panel id="loans" title="ציוד חלופי" hint={open ? `${open} אצל הלקוח` : null}>
      {!p.available ? <Later /> : (
        <>
          {p.loans.length ? (
            <ul className={s.timeline}>
              {p.loans.map((l) => (
                <li key={l.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={s.dot} aria-hidden="true" />
                  <span className={s.tlText} style={{ flex: 1 }}>{l.itemName}{l.returnedAt ? ` · הוחזר ${formatShortDate(l.returnedAt, p.now)}` : ` · ניתן ${formatShortDate(l.lentAt, p.now)}`}</span>
                  {!l.returnedAt && p.editable ? <button type="button" className={s.secondary} disabled={p.busy} onClick={() => p.onReturn(l.id)}>הוחזר</button> : null}
                </li>
              ))}
            </ul>
          ) : <p className={s.muted}>לא ניתן ציוד חלופי.</p>}
          {p.editable ? (form.open ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input className={s.input} id="sd-loan-name" value={form.name} maxLength={120} placeholder="מה ניתן ללקוח" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className={s.input} id="sd-loan-note" value={form.note} maxLength={500} placeholder="הערה (לא חובה)" onChange={(e) => setForm({ ...form, note: e.target.value })} />
              <button type="button" className={s.secondary} disabled={p.busy || !form.name.trim()} onClick={() => { p.onLend(form.name.trim(), form.note.trim() || null); setForm({ open: false, name: "", note: "" }); }}>לרשום</button>
            </div>
          ) : <button type="button" className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} onClick={() => setForm({ ...form, open: true })}>+ ציוד חלופי</button>) : null}
        </>
      )}
    </Panel>
  );
}

// ── Linked tasks (decision 7) ──
export function TasksPanel(p: { available: boolean; linked: CaseTask[]; open: CaseTask[]; editable: boolean; busy: boolean; onLink: (id: number, link: boolean) => void }) {
  const [pick, setPick] = useState("");
  return (
    <Panel id="tasks" title="משימות" hint={p.linked.length ? `${p.linked.length}` : null}>
      {!p.available ? <Later /> : (
        <>
          {p.linked.length ? (
            <ul className={s.timeline}>
              {p.linked.map((t) => (
                <li key={t.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={s.dot} aria-hidden="true" />
                  <a className={s.tlText} style={{ flex: 1, color: "inherit", textDecoration: t.done ? "line-through" : "none" }} href={`/tasks?task=${t.id}`}>{t.title}</a>
                  {p.editable ? <button type="button" className={s.dangerLink} style={{ color: "inherit" }} disabled={p.busy} onClick={() => p.onLink(t.id, false)}>להסיר</button> : null}
                </li>
              ))}
            </ul>
          ) : <p className={s.muted}>אין משימות מקושרות.</p>}
          {p.editable && p.open.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select className={s.input} id="sd-task-pick" style={{ flex: "1 1 180px" }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="משימה פתוחה לקישור">
                <option value="">בחרו משימה פתוחה</option>
                {p.open.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <button type="button" className={s.secondary} disabled={p.busy || !pick} onClick={() => { p.onLink(Number(pick), true); setPick(""); }}>לקשר</button>
            </div>
          ) : null}
          {p.editable ? <a className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} href="/tasks">+ משימה חדשה במשימות</a> : null}
        </>
      )}
    </Panel>
  );
}

// ── Light fields (A7) ──
export function FieldsPanel(p: { fields: CaseFields; editable: boolean; busy: boolean; held: boolean; onSave: (loc: string | null, date: string | null) => void }) {
  const [loc, setLoc] = useState(p.fields.itemLocationNote ?? "");
  const [date, setDate] = useState(p.fields.estimatedReadyOn ?? "");
  const dirty = (loc.trim() || null) !== p.fields.itemLocationNote || (date || null) !== p.fields.estimatedReadyOn;
  return (
    <Panel id="fields" title="פרטים נוספים">
      {!p.fields.available ? <Later /> : (
        <>
          {p.held ? (
            <label className={s.label}>איפה הפריט נמצא
              <input className={s.input} id="sd-item-location" value={loc} maxLength={120} placeholder="למשל מדף 3" disabled={!p.editable} onChange={(e) => setLoc(e.target.value)} />
            </label>
          ) : null}
          <label className={s.label}>סיום משוער (לא חובה)
            <input className={s.input} id="sd-estimated" type="date" value={date} disabled={!p.editable} onChange={(e) => setDate(e.target.value)} />
          </label>
          {p.editable && dirty ? <div className={s.actionsRow}><button type="button" className={s.secondary} disabled={p.busy} onClick={() => p.onSave(loc.trim() || null, date || null)}>לשמור</button></div> : null}
        </>
      )}
    </Panel>
  );
}
