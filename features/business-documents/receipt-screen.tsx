"use client";

/**
 * "קבלה חדשה" — issue a receipt (קבלה) through the EXISTING billing routes, in the order the billing service expects:
 * create a RECEIPT draft → its payment lines → its allocations to the customer's issued tax invoices → issue. One
 * payment that settles several invoices is a "קבלה מרכזת" (owner decision ה׳3). Nothing in billing changes: numbering,
 * issuance rules, payment validation, PDF and export are the existing ones, and every rule is enforced there again.
 * Behind business_documents (off by default).
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

import {
  BillingRequestError,
  createReceiptDraftRequest,
  fetchBillingPdf,
  getBillingDocument,
  issueReceiptRequest,
  listCustomerOptions,
  listOpenInvoices,
  setReceiptAllocationsRequest,
  setReceiptPaymentsRequest,
  type PickOption,
  type ReceiptDocWire,
} from "./business-documents-client";
import {
  allocationsPayload,
  allocationsTotal,
  autoAllocate,
  billingErrorText,
  decimalToAgorot,
  emptyLine,
  FIELD_LABEL,
  formatAgorot,
  isConsolidated,
  linesTotal,
  METHOD_FIELDS,
  METHOD_LABEL,
  METHODS,
  paymentsPayload,
  receiptProblems,
  type LineField,
  type OpenInvoice,
  type PaymentLineForm,
  type ReceiptForm,
  type ReceiptMethod,
} from "./receipt-model";
import { FeatureOff, Loading, ScreenHead } from "./ui";
import s from "./docs.module.css";

type Step = "edit" | "confirm" | "issuing" | "done";

export function ReceiptScreen() {
  const on = useFeatureState("business_documents");
  const today = jerusalemDayKey(new Date());
  const [customers, setCustomers] = useState<PickOption[]>([]);
  const [form, setForm] = useState<ReceiptForm>({ customerId: "", lines: [emptyLine(today)], allocations: {} });
  /** The open invoices of the customer they were loaded for (a stale answer for another customer is ignored). */
  const [loaded, setLoaded] = useState<{ customerId: string; rows: OpenInvoice[] | "failed" } | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("edit");
  const [issued, setIssued] = useState<ReceiptDocWire | null>(null);
  /** The billing draft of the current attempt: a retry reuses it (payment lines and allocations are replaced). */
  const draft = useRef<{ id: number; customerId: string; allocated: boolean } | null>(null);

  useEffect(() => {
    if (on !== true) return;
    listCustomerOptions().then(setCustomers).catch(() => setCustomers([]));
  }, [on]);

  useEffect(() => {
    const customerId = form.customerId;
    if (on !== true || !/^\d+$/.test(customerId)) return;
    let live = true;
    listOpenInvoices(Number(customerId)).then(
      (rows) =>
        live &&
        setLoaded({
          customerId,
          rows: rows
            .map((r) => ({ id: r.id, number: r.number, issuedAt: r.issuedAt, totalAgorot: decimalToAgorot(r.total), remainingAgorot: decimalToAgorot(r.remaining) }))
            .filter((r) => r.remainingAgorot > 0),
        }),
      () => live && setLoaded({ customerId, rows: "failed" })
    );
    return () => {
      live = false;
    };
  }, [on, form.customerId]);

  const current = loaded && loaded.customerId === form.customerId ? loaded.rows : null;
  const invoices = current === "failed" ? null : current;
  const invoicesFailed = current === "failed";

  const edit = (next: ReceiptForm) => {
    setForm(next);
    setProblems({});
    setMessage(null);
    if (step === "confirm") setStep("edit");
  };
  const setLine = (i: number, patch: Partial<PaymentLineForm>) => edit({ ...form, lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  const total = linesTotal(form.lines);
  const allocated = allocationsTotal(form.allocations);

  const review = () => {
    const p = receiptProblems(form, invoices ?? []);
    setProblems(p);
    if (Object.keys(p).length > 0) {
      setMessage("יש לתקן את השדות המסומנים.");
      return;
    }
    setMessage(null);
    setStep("confirm");
  };

  const issue = async () => {
    setStep("issuing");
    setMessage(null);
    const allocations = allocationsPayload(form.allocations);
    try {
      // A draft that already holds allocations cannot be cleared through the existing route (it takes a non-empty
      // list), and a draft belongs to one customer: either case starts a new draft.
      if (draft.current) {
        // A previous attempt may have issued the receipt and lost only the answer (and the check after it): ask the
        // document first, so a retry finishes that receipt instead of issuing a second one.
        const previous = await getBillingDocument(draft.current.id);
        if (previous.status === "ISSUED") {
          draft.current = null;
          setIssued(previous);
          setStep("done");
          return;
        }
      }
      if (draft.current && (draft.current.customerId !== form.customerId || (draft.current.allocated && !allocations))) draft.current = null;
      if (!draft.current) {
        const created = await createReceiptDraftRequest(Number(form.customerId));
        draft.current = { id: created.id, customerId: form.customerId, allocated: false };
      }
      const id = draft.current.id;
      await setReceiptPaymentsRequest(id, paymentsPayload(form.lines));
      if (allocations) {
        await setReceiptAllocationsRequest(id, allocations);
        draft.current.allocated = true;
      }
      let doc: ReceiptDocWire;
      try {
        doc = await issueReceiptRequest(id);
      } catch (e) {
        // The answer was lost, not necessarily the issuance: ask the document itself before reporting a failure.
        if (e instanceof BillingRequestError && e.status === null) {
          const current = await getBillingDocument(id);
          if (current.status !== "ISSUED") throw e;
          doc = current;
        } else throw e;
      }
      draft.current = null;
      setIssued(doc);
      setStep("done");
    } catch (e) {
      const text = e instanceof BillingRequestError ? billingErrorText(e.status, e.serverMessage) : "הפעולה נכשלה. נסו שוב.";
      setMessage(`${text} הקבלה לא הופקה${draft.current ? " (הטיוטה נשמרה במסך החשבוניות, וניסיון חוזר ימשיך אותה)" : ""}.`);
      setStep("edit");
    }
  };

  const downloadPdf = async () => {
    if (!issued) return;
    try {
      const blob = await fetchBillingPdf(issued.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `receipt-${issued.documentNumberFormatted ?? issued.id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setMessage("לא הצלחנו להוריד את הקובץ. אפשר לפתוח את הקבלה במסך החשבוניות.");
    }
  };

  const restart = () => {
    draft.current = null;
    setIssued(null);
    setForm({ customerId: "", lines: [emptyLine(today)], allocations: {} });
    setProblems({});
    setMessage(null);
    setStep("edit");
  };

  const lineField = (i: number, f: LineField, control: React.ReactNode) => (
    <div className={s.field} key={f}>
      <label className={s.label} htmlFor={`rc-${i}-${f}`}>{FIELD_LABEL[f]}</label>
      {control}
      {problems[`line.${i}.${f}`] ? <span className={s.problem} role="alert">{problems[`line.${i}.${f}`]}</span> : null}
    </div>
  );
  const text = (i: number, f: LineField, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input id={`rc-${i}-${f}`} className={s.input} value={form.lines[i][f]} maxLength={200} onChange={(e) => setLine(i, { [f]: e.target.value })} {...props} />
  );
  const customerName = customers.find((c) => String(c.id) === form.customerId)?.name ?? "";
  const busy = step === "issuing";

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="קבלה חדשה" subtitle="קבלה על תשלום — גם על כמה חשבוניות (קבלה מרכזת)" fallback="/business-documents" fallbackLabel="למסמכים נוספים" />
        {on === false ? (
          <FeatureOff />
        ) : on === null ? (
          <Loading />
        ) : step === "done" && issued ? (
          <section className={s.section}>
            <h2 className={s.sectionTitle}>הקבלה הופקה</h2>
            <p className={s.note} role="status">קבלה מס׳ {issued.documentNumberFormatted ?? "—"} על סך {formatAgorot(decimalToAgorot(issued.totalAmount))} ₪.</p>
            {message ? <p className={s.error} role="alert">{message}</p> : null}
            <div className={s.actions}>
              <button type="button" className={`${s.button} ${s.primary}`} onClick={() => void downloadPdf()}>הורדת PDF</button>
              <Link className={s.button} href={`/billing/${issued.id}`}>לקבלה במסך החשבוניות</Link>
              <button type="button" className={s.button} onClick={restart}>קבלה חדשה</button>
            </div>
          </section>
        ) : (
          <form className={s.section} onSubmit={(e) => { e.preventDefault(); review(); }} noValidate>
            <p className={s.note}>הקבלה מופקת במנגנון החשבוניות הקיים, עם המספור שלו. אחרי ההפקה אי אפשר לערוך אותה.</p>

            <div className={s.field}>
              <label className={s.label} htmlFor="rc-customer">לקוח</label>
              <select id="rc-customer" className={s.select} value={form.customerId} disabled={busy} onChange={(e) => edit({ ...form, customerId: e.target.value, allocations: {} })}>
                <option value="">בחירת לקוח</option>
                {customers.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
              {problems.customer ? <span className={s.problem} role="alert">{problems.customer}</span> : null}
            </div>

            <h2 className={s.sectionTitle}>תשלומים</h2>
            {problems.lines ? <p className={s.problem} role="alert">{problems.lines}</p> : null}
            {form.lines.map((line, i) => (
              <fieldset key={i} className={s.section} disabled={busy}>
                <legend className={s.label}>תשלום {i + 1}</legend>
                <div className={s.field}>
                  <label className={s.label} htmlFor={`rc-${i}-method`}>אמצעי תשלום</label>
                  <select id={`rc-${i}-method`} className={s.select} value={line.method} onChange={(e) => setLine(i, { method: e.target.value as ReceiptMethod })}>
                    {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
                  </select>
                </div>
                {lineField(i, "amount", text(i, "amount", { inputMode: "decimal", placeholder: "0.00" }))}
                {lineField(i, "paymentDate", text(i, "paymentDate", { type: "date" }))}
                {METHOD_FIELDS[line.method].map((f) => lineField(i, f, text(i, f, f === "checkDueDate" ? { type: "date" } : f === "cardLast4" ? { inputMode: "numeric", maxLength: 4 } : {})))}
                {METHOD_FIELDS[line.method].includes("reference") ? null : lineField(i, "reference", text(i, "reference", { placeholder: "לא חובה" }))}
                {form.lines.length > 1 ? (
                  <div className={s.actions}>
                    <button type="button" className={s.button} onClick={() => edit({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>הסרת התשלום</button>
                  </div>
                ) : null}
              </fieldset>
            ))}
            <div className={s.actions}>
              <button type="button" className={s.button} disabled={busy} onClick={() => edit({ ...form, lines: [...form.lines, emptyLine(today)] })}>תשלום נוסף</button>
            </div>
            <p className={s.note}>סכום הקבלה: {formatAgorot(total)} ₪</p>

            {/^\d+$/.test(form.customerId) ? (
              <>
                <h2 className={s.sectionTitle}>שיוך לחשבוניות פתוחות</h2>
                <p className={s.hint}>לא חובה. בלי שיוך, הקבלה מתעדת תשלום שלא סוגר חשבונית. עם שיוך, הסכומים חייבים להסתכם בדיוק לסכום הקבלה. שיוך ליותר מחשבונית אחת הוא קבלה מרכזת.</p>
                {invoicesFailed ? (
                  <p className={s.error} role="alert">לא הצלחנו לטעון את החשבוניות הפתוחות.</p>
                ) : invoices === null ? (
                  <Loading />
                ) : invoices.length === 0 ? (
                  <p className={s.note}>ללקוח אין חשבוניות מס פתוחות.</p>
                ) : (
                  <>
                    <ul className={s.list}>
                      {invoices.map((inv) => (
                        <li key={inv.id} className={s.row}>
                          <span className={s.rowText}>
                            <span className={s.rowTitle}>חשבונית מס {inv.number ?? inv.id}</span>
                            <span className={s.rowSub}>יתרה פתוחה {formatAgorot(inv.remainingAgorot)} ₪ מתוך {formatAgorot(inv.totalAgorot)} ₪</span>
                          </span>
                          <span className={s.rowEnd}>
                            <input
                              aria-label={`סכום לחשבונית ${inv.number ?? inv.id}`}
                              className={s.input}
                              inputMode="decimal"
                              placeholder="0.00"
                              disabled={busy}
                              value={form.allocations[inv.id] ?? ""}
                              onChange={(e) => edit({ ...form, allocations: { ...form.allocations, [inv.id]: e.target.value } })}
                            />
                            {problems[`alloc.${inv.id}`] ? <span className={s.problem} role="alert">{problems[`alloc.${inv.id}`]}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className={s.actions}>
                      <button type="button" className={s.button} disabled={busy || total === 0} onClick={() => edit({ ...form, allocations: autoAllocate(total, invoices) })}>שיוך אוטומטי (מהישנה לחדשה)</button>
                      <button type="button" className={s.button} disabled={busy} onClick={() => edit({ ...form, allocations: {} })}>ניקוי השיוך</button>
                    </div>
                    <p className={s.note}>שויך: {formatAgorot(allocated)} ₪ מתוך {formatAgorot(total)} ₪{isConsolidated(form.allocations) ? " · קבלה מרכזת" : ""}</p>
                    {problems.allocTotal ? <p className={s.problem} role="alert">{problems.allocTotal}</p> : null}
                  </>
                )}
              </>
            ) : null}

            {message ? <p className={s.error} role="alert">{message}</p> : null}

            {step === "edit" ? (
              <div className={s.actions}>
                <button type="submit" className={`${s.button} ${s.primary}`}>בדיקה לפני הפקה</button>
              </div>
            ) : (
              <div className={s.section} role="group" aria-label="אישור הפקה">
                <p className={s.note}>
                  להפיק קבלה ל{customerName || "לקוח"} על סך {formatAgorot(total)} ₪
                  {allocated > 0 ? `, משויכת ל־${Object.values(form.allocations).filter((v) => v.trim() !== "").length} חשבוניות` : ", ללא שיוך לחשבונית"}? אחרי ההפקה יוקצה מספר והקבלה לא תיערך.
                </p>
                <div className={s.actions}>
                  <button type="button" className={`${s.button} ${s.primary}`} disabled={busy} onClick={() => void issue()}>{busy ? "מפיק…" : "הפקת הקבלה"}</button>
                  <button type="button" className={s.button} disabled={busy} onClick={() => setStep("edit")}>חזרה לעריכה</button>
                </div>
              </div>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
