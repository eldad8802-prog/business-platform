"use client";

/**
 * ר2 — "מכתב חדש": write a letter on the business's letterhead, preview it, download
 * the PDF or share it manually. No accounting meaning, no legal number, nothing is
 * sent by Dubiz. The draft is kept only on this device until saving letters in the
 * system is approved. Behind business_documents (off by default).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useFeatureState } from "@/lib/ui/use-feature-enabled";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { letterPdf, LetterRequestError, listCustomerOptions, listSupplierOptions, previewLetter, type PickOption } from "./business-documents-client";
import { DRAFT_STORAGE_KEY, FIELD_LABEL, letterErrorText, missingFields, restoreDraft, toRequestBody, type LetterForm } from "./letter-model";
import { FeatureOff, Loading, ScreenHead } from "./ui";
import s from "./docs.module.css";

type Busy = null | "preview" | "pdf" | "share";

export function LetterScreen() {
  const on = useFeatureState("business_documents");
  const today = jerusalemDayKey(new Date());
  const [form, setForm] = useState<LetterForm>(() => (typeof window === "undefined" ? restoreDraft(null, today) : restoreDraft(window.localStorage.getItem(DRAFT_STORAGE_KEY), today)));
  const [customers, setCustomers] = useState<PickOption[]>([]);
  const [suppliers, setSuppliers] = useState<PickOption[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(form));
    } catch {
      /* storage full or blocked — the form still works */
    }
  }, [form]);

  useEffect(() => {
    if (on !== true) return;
    listCustomerOptions().then(setCustomers).catch(() => setCustomers([]));
    listSupplierOptions().then(setSuppliers).catch(() => setSuppliers([]));
  }, [on]);

  const set = <K extends keyof LetterForm>(key: K, value: LetterForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setPreviewHtml(null);
  };

  const run = useCallback(
    async (kind: Exclude<Busy, null>) => {
      if (busy) return; // one request at a time: a second tap does nothing
      const missing = missingFields(form);
      if (missing.length) {
        setProblems(Object.fromEntries(missing.map((k) => [k, "שדה חובה"])));
        setMessage("יש שדות שצריך למלא.");
        return;
      }
      inFlight.current?.abort();
      const ctl = new AbortController();
      inFlight.current = ctl;
      setBusy(kind);
      setMessage(null);
      setProblems({});
      try {
        const body = toRequestBody(form);
        if (kind === "preview") {
          setPreviewHtml(await previewLetter(body, ctl.signal));
          return;
        }
        const blob = await letterPdf(body, ctl.signal);
        const file = new File([blob], `letter-${form.date}.pdf`, { type: "application/pdf" });
        if (kind === "share" && typeof navigator !== "undefined" && navigator.share && navigator.canShare?.({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: form.subject });
            setMessage("נפתח חלון השיתוף. Dubiz לא יודעת אם המכתב נשלח בפועל.");
          } catch (e) {
            if (!(e instanceof DOMException && e.name === "AbortError")) setMessage("השיתוף לא הצליח. אפשר להוריד את הקובץ.");
          }
          return;
        }
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        if (kind === "share") setMessage("המכשיר לא תומך בשיתוף קבצים — הקובץ ירד במקום.");
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        const status = e instanceof LetterRequestError ? e.status : null;
        if (e instanceof LetterRequestError && e.problems.length) setProblems(Object.fromEntries(e.problems.map((p) => [p.field, p.message])));
        setMessage(letterErrorText(status));
      } finally {
        if (inFlight.current === ctl) inFlight.current = null;
        setBusy(null);
      }
    },
    [busy, form]
  );

  const clear = () => {
    setForm(restoreDraft(null, today));
    setPreviewHtml(null);
    setProblems({});
    setMessage(null);
  };

  const field = (key: keyof LetterForm, label: string, control: React.ReactNode, hint?: string) => (
    <div className={s.field}>
      <label className={s.label} htmlFor={`letter-${key}`}>{label}</label>
      {control}
      {hint ? <span className={s.hint}>{hint}</span> : null}
      {problems[key] ? <span className={s.problem} role="alert">{problems[key]}</span> : null}
    </div>
  );

  return (
    <main className={s.screen} data-page-intent="content">
      <div className={s.narrow}>
        <ScreenHead title="מכתב חדש" subtitle="על נייר המכתבים של העסק" fallback="/business-documents" fallbackLabel="למסמכים נוספים" />
        {on === false ? (
          <FeatureOff />
        ) : on === null ? (
          <Loading />
        ) : (
          <form className={s.section} onSubmit={(e) => { e.preventDefault(); void run("preview"); }} noValidate>
            <p className={s.note}>למכתב אין משמעות חשבונאית ואין לו מספור. הטיוטה נשמרת רק במכשיר הזה.</p>

            {field("recipientKind", "נמען", (
              <select id="letter-recipientKind" className={s.select} value={form.recipientKind} onChange={(e) => set("recipientKind", e.target.value as LetterForm["recipientKind"])}>
                <option value="free">אחר (הקלדה חופשית)</option>
                <option value="customer">לקוח</option>
                <option value="supplier">ספק</option>
              </select>
            ))}
            {form.recipientKind === "customer"
              ? field("customerId", FIELD_LABEL.customerId, (
                  <select id="letter-customerId" className={s.select} value={form.customerId} onChange={(e) => set("customerId", e.target.value)}>
                    <option value="">בחירת לקוח</option>
                    {customers.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  </select>
                ))
              : null}
            {form.recipientKind === "supplier"
              ? field("supplierId", FIELD_LABEL.supplierId, (
                  <select id="letter-supplierId" className={s.select} value={form.supplierId} onChange={(e) => set("supplierId", e.target.value)}>
                    <option value="">בחירת ספק</option>
                    {suppliers.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  </select>
                ))
              : null}
            {field("recipientName", FIELD_LABEL.recipientName, (
              <input id="letter-recipientName" className={s.input} value={form.recipientName} maxLength={200} onChange={(e) => set("recipientName", e.target.value)} />
            ), form.recipientKind === "free" ? undefined : "ריק = השם מהכרטיס")}
            {field("recipientAddress", FIELD_LABEL.recipientAddress, (
              <textarea id="letter-recipientAddress" className={s.input} rows={2} value={form.recipientAddress} maxLength={500} onChange={(e) => set("recipientAddress", e.target.value)} />
            ), form.recipientKind === "free" ? undefined : "ריק = הכתובת מהכרטיס, אם יש")}
            {field("date", FIELD_LABEL.date, (
              <input id="letter-date" type="date" className={s.input} value={form.date} onChange={(e) => set("date", e.target.value)} />
            ))}
            {field("reference", FIELD_LABEL.reference, (
              <input id="letter-reference" className={s.input} value={form.reference} maxLength={60} onChange={(e) => set("reference", e.target.value)} />
            ), "לא חובה. טקסט חופשי, לא מספור.")}
            {field("subject", FIELD_LABEL.subject, (
              <input id="letter-subject" className={s.input} value={form.subject} maxLength={200} onChange={(e) => set("subject", e.target.value)} />
            ))}
            {field("body", FIELD_LABEL.body, (
              <textarea id="letter-body" className={s.textarea} value={form.body} maxLength={10000} onChange={(e) => set("body", e.target.value)} />
            ), "שורה ריקה מתחילה פסקה חדשה.")}
            {field("signerName", FIELD_LABEL.signerName, (
              <input id="letter-signerName" className={s.input} value={form.signerName} maxLength={120} onChange={(e) => set("signerName", e.target.value)} />
            ))}
            {field("signerTitle", FIELD_LABEL.signerTitle, (
              <input id="letter-signerTitle" className={s.input} value={form.signerTitle} maxLength={120} onChange={(e) => set("signerTitle", e.target.value)} />
            ))}
            <label className={s.note} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={form.includeSignatureImage} onChange={(e) => set("includeSignatureImage", e.target.checked)} />
              להוסיף את תמונת החתימה מפרטי העסק (אם הוגדרה)
            </label>

            {message ? <p className={s.note} role="status">{message}</p> : null}

            <div className={s.actions}>
              <button type="submit" className={`${s.button} ${s.primary}`} disabled={busy !== null}>{busy === "preview" ? "מכין…" : "תצוגה מקדימה"}</button>
              <button type="button" className={s.button} disabled={busy !== null} onClick={() => void run("pdf")}>{busy === "pdf" ? "מכין…" : "הורדת PDF"}</button>
              <button type="button" className={s.button} disabled={busy !== null} onClick={() => void run("share")}>{busy === "share" ? "מכין…" : "שיתוף"}</button>
              <button type="button" className={s.button} disabled={busy !== null} onClick={clear}>טיוטה חדשה</button>
            </div>

            {previewHtml ? (
              <div className={s.preview}>
                {/* sandbox with no permissions: the preview runs no script and can navigate nowhere */}
                <iframe className={s.previewFrame} title="תצוגה מקדימה של המכתב" sandbox="" srcDoc={previewHtml} />
              </div>
            ) : null}
          </form>
        )}
      </div>
    </main>
  );
}
