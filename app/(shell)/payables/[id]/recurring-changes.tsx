"use client";

/**
 * Changes to a RECURRING commitment that must never rewrite its history:
 *
 *   "מתאריך X הסכום הוא Y"  → occurrences before X keep their amounts; the
 *                              first occurrence on/after X and every later one
 *                              take Y. A paid occurrence refuses the change.
 *   "ההתחייבות מסתיימת ב-X" → the last day it is in effect. Unpaid occurrences
 *                              after X are cancelled; nothing before X changes.
 *
 * Each form lives in its own dialog (opened from the commitment's "עוד" menu).
 * Ending is destructive, so its dialog states what will be cancelled and its
 * submit is the danger button — the dialog is the confirmation.
 */

import { useState } from "react";
import { changeRecurringAmount, endCommitment } from "@/lib/payables/payables-client";
import { Button, Field, Notice, fieldInputClass, israelDayKey } from "@/components/finance-ui";

/** A civil date as the API expects it: Israel noon, so no zone can shift the day. */
function civilIso(date: string): string {
  return new Date(date + "T12:00:00+03:00").toISOString();
}

type Run = (action: () => Promise<unknown>, success: string) => Promise<boolean>;

export function RecurringAmountForm({ commitmentId, run, onDone, onCancel }: { commitmentId: number; run: Run; onDone: () => void; onCancel: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState(israelDayKey(new Date()));
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      style={{ display: "grid", gap: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await run(
          () => changeRecurringAmount(commitmentId, { effectiveFrom: civilIso(effectiveFrom), amount: amount.trim() }),
          "הסכום עודכן מהמועד שבתאריך שנבחר ואילך. מועדים קודמים לא השתנו.",
        );
        setBusy(false);
        if (ok) onDone();
      }}
    >
      <Notice tone="neutral">מועדים לפני התאריך שומרים על הסכום שלהם. אם כבר נרשם תשלום למועד שמשתנה, השינוי לא יתבצע.</Notice>
      <Field label="החל מתאריך" htmlFor="rc-from">
        <input id="rc-from" className={fieldInputClass} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
      </Field>
      <Field label="הסכום החדש" htmlFor="rc-amount">
        <input id="rc-amount" className={fieldInputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="9500.00" required />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="submit" variant="primary" busy={busy} busyLabel="מעדכן…">
          עדכון הסכום
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

export function EndCommitmentForm({ commitmentId, run, onDone, onCancel }: { commitmentId: number; run: Run; onDone: () => void; onCancel: () => void }) {
  const [endsOn, setEndsOn] = useState(israelDayKey(new Date()));
  const [busy, setBusy] = useState(false);
  return (
    <form
      style={{ display: "grid", gap: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await run(
          () => endCommitment(commitmentId, { endsOn: civilIso(endsOn) }),
          "ההתחייבות תסתיים בתאריך שנבחר. מועדים שלא שולמו אחריו בוטלו.",
        );
        setBusy(false);
        if (ok) onDone();
      }}
    >
      <Notice tone="warning">מועדים שלא שולמו אחרי התאריך הזה יבוטלו. מה שלפניו לא משתנה, ותשלומים שכבר נרשמו נשמרים.</Notice>
      <Field label="היום האחרון שבו ההתחייבות בתוקף" htmlFor="rc-end">
        <input id="rc-end" className={fieldInputClass} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="submit" variant="danger" busy={busy} busyLabel="מעדכן…">
          סיום ההתחייבות
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}
