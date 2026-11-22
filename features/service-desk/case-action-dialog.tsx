"use client";

/**
 * Service Desk UI 1.3 — the small dialog an action asks before it is sent: a confirmation, the handover (optional
 * receiver name), the way the customer answered a quote, a cancel reason, or the owner's reason for handing over with
 * an open balance. Hebrew, RTL; a bottom sheet on the phone, a centred dialog from tablet up.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { CaseActionDef } from "./case-actions-model";
import s from "./cases.module.css";

export type DialogResult = { receiver?: string; reason?: string; debtReason?: string; method?: "PHONE" | "IN_PERSON" };

export function CaseActionDialog({ def, debtMode, busy, onCancel, onSubmit }: {
  def: CaseActionDef;
  /** The server asked for the owner's documented decision on an open balance. */
  debtMode: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (r: DialogResult) => void;
}) {
  const [receiver, setReceiver] = useState("");
  const [reason, setReason] = useState("");
  const [debtReason, setDebtReason] = useState("");
  const [method, setMethod] = useState<"PHONE" | "IN_PERSON" | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const input = def.input;
  const reasonMissing = input.kind === "reason" && input.required && !reason.trim();
  const debtMissing = debtMode && !debtReason.trim();
  const methodMissing = input.kind === "quoteMethod" && !method;
  const disabled = busy || reasonMissing || debtMissing || methodMissing;

  // Rendered on the page body: the shell's layers (its bottom bar among them) cannot cover it.
  return createPortal(
    <div className={s.backdrop} role="presentation" onClick={() => { if (!busy) onCancel(); }}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="sd-action-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="sd-action-title" className={s.dialogTitle}>{def.label}</h2>
        {input.kind === "confirm" ? <p className={s.dialogText}>{input.text}</p> : null}
        {input.kind === "receiver" ? (
          <>
            <p className={s.dialogText}>המסירה נרשמת עם התאריך והשעה ועם אישור בעל העסק. אין צורך בחתימת הלקוח.</p>
            <label className={s.label}>
              מי אסף (לא חובה)
              <input className={s.input} value={receiver} maxLength={200} onChange={(e) => setReceiver(e.target.value)} placeholder="שם המקבל" />
            </label>
          </>
        ) : null}
        {input.kind === "quoteMethod" ? (
          <>
            <p className={s.dialogText}>איך הלקוח מסר את התשובה?</p>
            <div className={s.choices} role="group" aria-label="אופן התשובה">
              <button type="button" className={s.choice} aria-pressed={method === "PHONE"} onClick={() => setMethod("PHONE")}>בטלפון</button>
              <button type="button" className={s.choice} aria-pressed={method === "IN_PERSON"} onClick={() => setMethod("IN_PERSON")}>פנים אל פנים</button>
            </div>
          </>
        ) : null}
        {input.kind === "reason" ? (
          <label className={s.label}>
            {input.label}
            <textarea className={s.textarea} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
        ) : null}
        {debtMode ? (
          <label className={s.label}>
            יש יתרה פתוחה. סיבת המסירה עם חוב (חובה, נשמרת בהיסטוריה)
            <textarea className={s.textarea} value={debtReason} maxLength={500} onChange={(e) => setDebtReason(e.target.value)} />
          </label>
        ) : null}
        <div className={s.dialogActions}>
          <button ref={first} type="button" className={s.primary} disabled={disabled}
            onClick={() => onSubmit({ receiver, reason, debtReason, ...(method ? { method } : {}) })}>
            {busy ? "שומר…" : def.input.kind === "receiver" ? "לאשר מסירה" : "לאשר"}
          </button>
          <button type="button" className={s.secondary} disabled={busy} onClick={onCancel}>ביטול</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A plain confirmation sheet for a panel step (send a quote, record a charge, link a document): what will happen, then
 * confirm / cancel. Same layer, tokens and focus rules as the action dialog; the body may hold the step's own fields.
 */
export function ConfirmDialog({ title, children, confirmLabel, confirmDisabled = false, busy, onCancel, onConfirm }: {
  title: string; children: ReactNode; confirmLabel: string; confirmDisabled?: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return createPortal(
    <div className={s.backdrop} role="presentation" onClick={() => { if (!busy) onCancel(); }}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="sd-confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="sd-confirm-title" className={s.dialogTitle}>{title}</h2>
        {children}
        <div className={s.dialogActions}>
          <button type="button" className={s.primary} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? "שומר…" : confirmLabel}</button>
          <button ref={first} type="button" className={s.secondary} disabled={busy} onClick={onCancel}>ביטול</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
