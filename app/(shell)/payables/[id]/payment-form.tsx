"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  formatDate,
  formatMoney,
  methodLabel,
  recordPayment,
  type CommitmentDetailApi,
} from "@/lib/payables/payables-client";
import styles from "../payables.module.css";

const METHODS = [
  "BANK_TRANSFER",
  "CASH",
  "CREDIT_CARD",
  "CHECK",
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;

/* ───────────────────────────── record a payment ──────────────────────────── */

/**
 * The payment form, unchanged from the detail page it used to live in. The one
 * difference is where the preselected installment comes from: the page reads
 * `?pay=<installmentId>` (a Dubiz recommendation) or the installment the owner
 * tapped, and passes it as `preselect`.
 */
export function PaymentForm({
  detail,
  preselect,
  onDone,
}: {
  detail: CommitmentDetailApi;
  preselect?: number | null;
  onDone: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const open = useMemo(
    () =>
      detail.installments.filter(
        (i) => Number(i.remaining) > 0 && i.status === "SCHEDULED",
      ),
    [detail.installments],
  );

  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  // Only the selection is preset; the amount and date are what the owner actually paid.
  const [selected, setSelected] = useState<number[]>(() =>
    preselect != null && open.some((i) => i.id === preselect) ? [preselect] : [],
  );
  const [arrivedToPay] = useState(() => selected.length > 0);
  useEffect(() => {
    if (arrivedToPay) document.getElementById("pm-amount")?.scrollIntoView({ block: "center" });
  }, [arrivedToPay]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh key per mounted form. A double submit — the classic impatient
  // second tap — is then a retry of the SAME logical payment rather than a
  // second economic event.
  const [idempotencyKey] = useState(
    () => `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  if (open.length === 0) {
    return (
      <div className={styles.empty}>
        {t("money.payables.detail.noOpenInstallments")}
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await recordPayment({
        commitmentId: detail.id,
        amount,
        paidAt: new Date(paidAt).toISOString(),
        method,
        externalReference: reference.trim() || null,
        installmentIds: selected.length > 0 ? selected : null,
        idempotencyKey,
      });

      if (result.replayed) {
        onDone(t("money.payables.detail.replayed"));
        return;
      }
      const surplus = Number(result.unallocated ?? "0");
      onDone(
        surplus > 0
          ? t("money.payables.detail.recordedUnallocated", { amount: formatMoney(String(surplus), detail.currency, locale) })
          : t("money.payables.detail.recordedFull"),
      );
      setAmount("");
      setSelected([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("money.payables.detail.recordFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-amount">
            {t("money.payables.detail.amountPaid")}
          </label>
          <input
            id="pm-amount"
            className={styles.input}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1200.00"
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-date">
            {t("money.payables.detail.paidAt")}
          </label>
          <input
            id="pm-date"
            className={styles.input}
            type="date"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            required
          />
        </div>
      </div>

      <div className={styles.formRow2}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-method">
            {t("money.payables.prepare.form.method")}
          </label>
          <select
            id="pm-method"
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {methodLabel(t, m) ?? m}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pm-ref">
            {t("money.payables.detail.referenceOptional")}
          </label>
          <input
            id="pm-ref"
            className={styles.input}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend className={styles.label}>
          {t("money.payables.detail.allocateLegend")}
        </legend>
        {open.map((inst) => (
          <label key={inst.id} className={styles.checkboxRow}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={selected.includes(inst.id)}
              onChange={(e) =>
                setSelected((prev) =>
                  e.target.checked
                    ? [...prev, inst.id]
                    : prev.filter((x) => x !== inst.id),
                )
              }
            />
            <span>
              {t("money.payables.cheques.form.installmentOption", {
                sequence: inst.sequence,
                date: formatDate(inst.dueAt, locale),
                amount: formatMoney(inst.remaining, detail.currency, locale),
              })}
            </span>
          </label>
        ))}
      </fieldset>

      <div className={styles.notice}>
        {t("money.payables.detail.overpayNotice")}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button type="submit" className={styles.buttonPrimary} disabled={busy}>
          {busy ? t("money.common.recording") : t("money.payables.detail.submit")}
        </button>
      </div>
    </form>
  );
}
