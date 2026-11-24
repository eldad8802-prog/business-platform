/**
 * Service Desk UI 1.3 — the panels around a case (presentational; the visual design is under the owner's review):
 * QA checklist, quote from a billing QUOTE document, pickup calls, replacement items (loans), linked tasks, and the
 * light fields (item location, estimated date). Every panel shows what the server holds; read-only hides the controls.
 */
import { useState, type ReactNode } from "react";

import { billingStatusText, chargeSummary, docName, ils, offerableQuoteDocs, PICKUP_OUTCOME_TEXT, qaProgress, QUOTE_STATE_TEXT, type QaResults } from "./case-extras-model";
import { formatShortDate } from "./cases-model";
import type { CaseChargeView, CaseFields, CaseQa, CaseTask, Loan, PickupCall, QuoteDoc, QuoteSummary, SettlementDoc } from "./service-desk-client";
import s from "./cases.module.css";

function Panel({ title, hint, children, id }: { title: string; hint?: string | null; children: ReactNode; id: string }) {
  return (
    <section className={s.infoCard} style={{ gap: 10 }} aria-labelledby={`${id}-t`} data-panel={id} id={`sd-${id}`}>
      <p className={s.infoTitle} id={`${id}-t`}>{title}{hint ? <span className={s.sectionHint}> · {hint}</span> : null}</p>
      {children}
    </section>
  );
}
const Later = () => <p className={s.muted}>עוד לא זמין בעסק הזה.</p>;

// ── QA ──
export function QaPanel(p: { qa: CaseQa; editable: boolean; busy: boolean; onSave: (r: QaResults) => void; onDraft?: (r: QaResults) => void }) {
  const [draft, setDraftState] = useState<QaResults>(p.qa.results);
  const t = p.qa.template;
  if (!t) return null;
  const prog = qaProgress(t.items, draft, t.everyCheckRecorded);
  const setDraft = (next: QaResults) => { setDraftState(next); p.onDraft?.(next); };
  const set = (k: string, v: "PASS" | "FAIL") => setDraft({ ...draft, [k]: v });
  const failedLabels = t.items.filter((i) => draft[i.key] === "FAIL").map((i) => i.label);
  const changed = t.items.some((i) => (draft[i.key] ?? null) !== (p.qa.results[i.key] ?? null));
  return (
    <Panel id="qa" title="בדיקות לפני מסירה" hint={p.qa.mode === "OPTIONAL" ? "לא חובה" : `${prog.recorded} מתוך ${prog.total} בדיקות הושלמו`}>
      <div className={s.progress} role="img" aria-label={`${prog.recorded} מתוך ${prog.total} בדיקות הושלמו`}><span style={{ width: `${prog.total ? Math.round((prog.recorded / prog.total) * 100) : 0}%` }} /></div>
      <ul className={s.timeline} style={{ gap: 8 }}>
        {t.items.map((i) => (
          <li key={i.key} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`${s.tlText} ${draft[i.key] === "FAIL" ? s.qaFailed : ""}`} style={{ flex: "1 1 160px" }}>
              {draft[i.key] === "PASS" ? "✓ " : draft[i.key] === "FAIL" ? "✕ " : ""}{i.label}{i.required ? " *" : ""}
            </span>
            <span className={s.choices} role="group" aria-label={i.label} style={{ flex: "0 0 auto" }}>
              <button type="button" className={s.choice} data-result="PASS" style={{ whiteSpace: "nowrap", paddingInline: 14 }} aria-pressed={draft[i.key] === "PASS"} disabled={!p.editable || p.busy} onClick={() => set(i.key, "PASS")}>✓ עבר</button>
              <button type="button" className={s.choice} data-result="FAIL" style={{ whiteSpace: "nowrap", paddingInline: 14 }} aria-pressed={draft[i.key] === "FAIL"} disabled={!p.editable || p.busy} onClick={() => set(i.key, "FAIL")}>✕ לא עבר</button>
            </span>
          </li>
        ))}
      </ul>
      {failedLabels.length ? (
        <p className={s.blockedNote} role="note">
          {failedLabels.length === 1 ? `הבדיקה "${failedLabels[0]}" לא עברה.` : `${failedLabels.length} בדיקות לא עברו: ${failedLabels.join(", ")}.`} מה עכשיו: מחזירים לעבודה, מתקנים, ומסיימים שוב — התיק יחזור לבדיקות.
        </p>
      ) : prog.missing ? <p className={s.muted}>חסרות עוד {prog.missing === 1 ? "בדיקה אחת" : `${prog.missing} בדיקות`}. מסמנים כל בדיקה אחרי שבודקים אותה בפועל.</p> : null}
      {p.editable && changed && !prog.complete && !failedLabels.length ? (
        <div className={s.actionsRow}>
          <button type="button" className={s.secondary} disabled={p.busy} onClick={() => p.onSave(draft)}>{p.busy ? "שומר…" : "לשמור בלי לאשר"}</button>
        </div>
      ) : null}
    </Panel>
  );
}

// ── Quote (from a billing QUOTE document; billing itself is not changed) ──
export function QuotePanel(p: {
  mode: "send" | "revise" | null; docs: QuoteDoc[]; caseQuotes: QuoteSummary[]; otherCaseDocIds: number[]; editable: boolean; busy: boolean; newQuoteHref: string;
  now: Date; onPick: (doc: QuoteDoc) => void;
}) {
  const sentIds = p.caseQuotes.map((q) => q.billingDocumentId).filter((x): x is number => typeof x === "number");
  const docs = p.mode ? offerableQuoteDocs(p.docs, sentIds, p.otherCaseDocIds) : [];
  const docOf = (id?: number) => p.docs.find((d) => d.id === id);
  const history = [...p.caseQuotes].sort((a, b) => b.version - a.version);
  if (!p.mode && history.length === 0) return null;
  return (
    <Panel id="quote" title="הצעת מחיר" hint={p.mode === "revise" ? "ממתינה לתשובה" : null}>
      {history.length ? (
        <ul className={s.timeline} aria-label="הצעות המחיר של התיק">
          {history.map((q) => {
            const d = docOf(q.billingDocumentId);
            return (
              <li key={q.version}>
                <span className={s.dot} aria-hidden="true" />
                <span className={s.tlText}>
                  גרסה {q.version}{q.totalAgorot !== null ? ` · ${ils(q.totalAgorot)}` : ""} · <strong>{QUOTE_STATE_TEXT[q.state] ?? q.state}</strong>
                  {q.approvalMethod === "PHONE" ? " (בטלפון)" : q.approvalMethod === "IN_PERSON" ? " (פנים אל פנים)" : ""}
                  {d ? <span className={s.rowDesc} style={{ display: "block" }}>{docName("מסמך הצעה", d.number)} · {billingStatusText(d.status)}</span> : null}
                </span>
                <span className={s.tlDate}>{formatShortDate(q.decidedAt ?? q.sentAt ?? "", p.now)}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {p.mode ? (
        <>
          {docs.length ? (
            <ul className={s.list} aria-label="הצעות מחיר של הלקוח">
              {docs.map((d) => (
                <li key={d.id} className={s.row} style={{ gridTemplateColumns: "1fr auto" }}>
                  <span className={s.rowMain}>
                    <span className={s.rowCustomer}>{docName("הצעה", d.number)}</span>
                    <span className={s.rowDesc}>₪{Number(d.totalAmount).toLocaleString("he-IL")} · {billingStatusText(d.status)}</span>
                  </span>
                  {p.editable ? <button type="button" className={s.secondary} disabled={p.busy} onClick={() => p.onPick(d)}>{p.mode === "send" ? "לצרף לתיק" : "להחליף בה"}</button> : null}
                </li>
              ))}
            </ul>
          ) : <p className={s.muted}>אין ללקוח הצעת מחיר שאפשר לצרף לתיק הזה.</p>}
          {p.editable ? <a className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} href={p.newQuoteHref}>+ הצעת מחיר חדשה במסמכים</a> : null}
          <p className={s.muted}>צירוף ההצעה שומר בתיק עותק קבוע שלה ומעביר את התיק להמתנה לתשובת הלקוח. המערכת לא שולחת את ההצעה ללקוח — מוסרים אותה בעצמכם (הדפסה, וואטסאפ או מייל ממסך המסמכים), ואת תשובת הלקוח רושמים כאן.</p>
        </>
      ) : null}
    </Panel>
  );
}

// ── Charge: what the case is charged, and the balance the handover is judged by (server: case-charge.service) ──
const SETTLEMENT_TYPE: Record<string, string> = { TAX_INVOICE: "חשבונית מס", TAX_INVOICE_RECEIPT: "חשבונית מס קבלה", RECEIPT: "קבלה" };

export function ChargePanel(p: {
  charge: CaseChargeView | null; settlementDocs: SettlementDoc[]; editable: boolean; busy: boolean;
  /** A service call: «לפני הסגירה», never «לפני המסירה». */
  field?: boolean;
  onNoCharge: () => void; onAmount: () => void; onLink: (doc: SettlementDoc) => void;
}) {
  const sum = chargeSummary(p.charge?.balance ?? null, { field: p.field });
  const c = p.charge?.current ?? null;
  const linked = new Set((p.charge?.links ?? []).filter((l) => l.active).map((l) => l.billingDocumentId));
  const linkable = c?.mode === "CHARGEABLE" ? p.settlementDocs.filter((d) => !linked.has(d.id)) : [];
  return (
    <Panel id="charge" title="חיוב ותשלום" hint={sum.blocksHandover ? "צריך לקבוע" : null}>
      {c ? (
        <p className={s.tlText} style={{ margin: 0 }}>
          {c.mode === "NO_CHARGE" ? "ללא חיוב"
            : `חיוב: ${ils(c.amountAgorot ?? 0)}${c.source === "APPROVED_QUOTE" ? ` (לפי הצעת המחיר שאושרה${c.quoteVersion ? `, גרסה ${c.quoteVersion}` : ""})` : ""}`}
        </p>
      ) : null}
      <p className={sum.blocksHandover ? s.blockedNote : s.muted} role={sum.blocksHandover ? "note" : undefined}>{sum.text}</p>
      {linked.size ? <p className={s.muted}>{linked.size === 1 ? "מסמך אחד מקושר" : `${linked.size} מסמכים מקושרים`} לתיק.</p> : null}
      {p.editable ? (
        <div className={s.actionsRow}>
          <button type="button" className={s.secondary} disabled={p.busy} onClick={p.onAmount}>{c?.mode === "CHARGEABLE" ? "לשנות סכום" : "לקבוע סכום לחיוב"}</button>
          {c?.mode !== "NO_CHARGE" && linked.size === 0 ? <button type="button" className={s.secondary} disabled={p.busy} onClick={p.onNoCharge}>ללא חיוב</button> : null}
        </div>
      ) : null}
      {p.editable && linkable.length ? (
        <ul className={s.list} aria-label="חשבוניות וקבלות של הלקוח">
          {linkable.map((d) => (
            <li key={d.id} className={s.row} style={{ gridTemplateColumns: "1fr auto" }}>
              <span className={s.rowMain}>
                <span className={s.rowCustomer}>{docName(SETTLEMENT_TYPE[d.type] ?? "מסמך", d.number)}</span>
                <span className={s.rowDesc}>₪{Number(d.totalAmount).toLocaleString("he-IL")}</span>
              </span>
              <button type="button" className={s.secondary} disabled={p.busy} onClick={() => p.onLink(d)}>לקשר לתיק</button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className={s.muted}>החיוב בתיק לא מפיק מסמך. חשבונית או קבלה מפיקים במסך המסמכים, ומקשרים אותן לכאן.</p>
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
export function LoansPanel(p: { available: boolean; loans: Loan[]; now: Date; editable: boolean; busy: boolean; onLend: (name: string, note: string | null) => void; onReturn: (id: number) => void; finished?: boolean }) {
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
          {p.editable && !p.finished ? (form.open ? (
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
export function TasksPanel(p: { available: boolean; linked: CaseTask[]; open: CaseTask[]; editable: boolean; busy: boolean; onLink: (id: number, link: boolean) => void; finished?: boolean }) {
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
          {p.editable && !p.finished && p.open.length ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <select className={s.input} id="sd-task-pick" style={{ flex: "1 1 180px" }} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="משימה פתוחה לקישור">
                <option value="">בחרו משימה פתוחה</option>
                {p.open.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
              <button type="button" className={s.secondary} disabled={p.busy || !pick} onClick={() => { p.onLink(Number(pick), true); setPick(""); }}>לקשר</button>
            </div>
          ) : null}
          {p.editable && !p.finished ? <a className={s.dangerLink} style={{ color: "inherit", alignSelf: "flex-start" }} href="/tasks">+ משימה חדשה במשימות</a> : null}
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
