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
import styles from "../payables.module.css";

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

  return (
    <div className={styles.form}>
      {endAt ? <div className={styles.notice}>ההתחייבות בתוקף עד {formatDate(endAt)} (כולל).</div> : null}
      <div className={styles.formRow2}>
        <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={() => setMode(mode === "amount" ? "none" : "amount")}>
          שינוי סכום מתאריך
        </button>
        <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={() => setMode(mode === "end" ? "none" : "end")}>
          סיום ההתחייבות
        </button>
      </div>

      {mode === "amount" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () => changeRecurringAmount(commitmentId, { effectiveFrom: civilIso(effectiveFrom), amount: amount.trim() }),
              "הסכום עודכן מהתשלום שבתאריך שנבחר ואילך. תשלומים קודמים לא השתנו.",
            );
          }}
        >
          <div className={styles.formRow2}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rc-from">
                החל מתאריך
              </label>
              <input id="rc-from" className={styles.input} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="rc-amount">
                הסכום החדש
              </label>
              <input id="rc-amount" className={styles.input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="9500.00" required />
            </div>
          </div>
          <button type="submit" className={styles.buttonPrimary} disabled={busy}>
            {busy ? "מעדכן…" : "עדכן סכום"}
          </button>
        </form>
      ) : null}

      {mode === "end" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(
              () => endCommitment(commitmentId, { endsOn: civilIso(endsOn) }),
              "ההתחייבות תסתיים בתאריך שנבחר. תשלומים שלא שולמו אחריו בוטלו.",
            );
          }}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor="rc-end">
              היום האחרון שבו ההתחייבות בתוקף
            </label>
            <input id="rc-end" className={styles.input} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required />
          </div>
          <button type="submit" className={styles.buttonPrimary} disabled={busy}>
            {busy ? "מעדכן…" : "סיים התחייבות"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
