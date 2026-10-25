"use client";

/**
 * Changes to a RECURRING commitment that must never rewrite its history:
 *
 *   "מתאריך X הסכום הוא Y"  → occurrences before X keep their amounts; the
 *                              first occurrence on/after X and every later one
 *                              take Y. A paid occurrence refuses the change.
 *   "ההתחייבות מסתיימת ב-X" → the last day it is in effect. Unpaid occurrences
 *                              after X are cancelled; nothing before X changes.
 */

import { useState } from "react";
import { changeRecurringAmount, endCommitment, formatDate } from "@/lib/payables/payables-client";
import { useI18n } from "@/components/i18n/I18nProvider";
import styles from "../payables.module.css";
import cd from "./commitment-detail.module.css";

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** A civil date as the API expects it: Israel noon, so no zone can shift the day. */
function civilIso(date: string): string {
  return new Date(date + "T12:00:00+03:00").toISOString();
}

export function RecurringChanges({
  commitmentId,
  endAt,
  run,
}: {
  commitmentId: number;
  endAt: string | null;
  run: (action: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<"none" | "amount" | "end">("none");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [amount, setAmount] = useState("");
  const [endsOn, setEndsOn] = useState(todayIso());
  const [busy, setBusy] = useState(false);

  async function submit(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await run(action, success);
      setMode("none");
    } finally {
      setBusy(false);
    }
  }

  // Two separate action rows; each opens its existing form right below it.
  // Ending is a warning-toned row, never a primary (green) button.
  return (
    <div className={cd.actionList}>
      {endAt ? <div className={styles.notice}>{t("money.payables.recurring.endsNotice", { date: formatDate(endAt, locale) })}</div> : null}

      <button
        type="button"
        className={cd.actionRow}
        disabled={busy}
        aria-expanded={mode === "amount"}
        onClick={() => setMode(mode === "amount" ? "none" : "amount")}
        data-testid="recurring-amount"
      >
        <span className={cd.actionIcon} aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
            <path d="M13.5 6.5l4 4" />
          </svg>
        </span>
        <span className={cd.actionText}>
          <b>{t("money.payables.recurring.changeAmount")}</b>
          <span>תשלומים לפני התאריך שתבחר לא משתנים</span>
        </span>
        <span className={cd.actionChev} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={mode === "amount" ? "M6 9l6 6 6-6" : "M15 6l-6 6 6 6"} />
          </svg>
        </span>
      </button>

      {mode === "amount" ? (
        <form
          className={cd.actionForm}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () => changeRecurringAmount(commitmentId, { effectiveFrom: civilIso(effectiveFrom), amount: amount.trim() }),
              t("money.payables.recurring.amountChanged"),
            );
          }}
        >
          <div className={styles.formRow2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rc-from">
                {t("money.payables.recurring.from")}
              </label>
              <input id="rc-from" className={styles.input} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rc-amount">
                {t("money.payables.recurring.newAmount")}
              </label>
              <input id="rc-amount" className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="9500.00" required />
            </div>
          </div>
          <button type="submit" className={styles.buttonPrimary} disabled={busy}>
            {busy ? t("money.common.updating") : t("money.payables.recurring.updateAmount")}
          </button>
        </form>
      ) : null}

      <button
        type="button"
        className={`${cd.actionRow} ${cd.actionRowWarn}`}
        disabled={busy}
        aria-expanded={mode === "end"}
        onClick={() => setMode(mode === "end" ? "none" : "end")}
        data-testid="recurring-end"
      >
        <span className={`${cd.actionIcon} ${cd.actionIconWarn}`} aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
            <path d="M3.5 10h17M8 3v4M16 3v4M9.5 13.5l5 5M14.5 13.5l-5 5" />
          </svg>
        </span>
        <span className={cd.actionText}>
          <b>{t("money.payables.recurring.end")}</b>
          <span>תשלומים שלא שולמו אחרי התאריך שתבחר יבוטלו</span>
        </span>
        <span className={cd.actionChev} aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={mode === "end" ? "M6 9l6 6 6-6" : "M15 6l-6 6 6 6"} />
          </svg>
        </span>
      </button>

      {mode === "end" ? (
        <form
          className={cd.actionForm}
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () => endCommitment(commitmentId, { endsOn: civilIso(endsOn) }),
              t("money.payables.recurring.ended"),
            );
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor="rc-end">
              {t("money.payables.recurring.lastDay")}
            </label>
            <input id="rc-end" className={styles.input} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required />
          </div>
          <button type="submit" className={cd.btnWarn} disabled={busy}>
            {busy ? t("money.common.updating") : t("money.payables.recurring.endSubmit")}
          </button>
        </form>
      ) : null}
    </div>
  );
}
