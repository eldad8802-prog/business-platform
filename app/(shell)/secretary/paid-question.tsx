"use client";

/**
 * "שילמת?" — asked when the owner presses "טופל" on a ledger-backed item.
 *
 * handled ≠ paid. Pressing "טופל" never creates a payment by itself:
 *   - "כן, שילמתי"          → only the missing payment details are asked
 *                             (amount, date, method — prefilled), then the REAL
 *                             payables payment flow records it, then the
 *                             reminder closes.
 *   - "לא, רק לסמן שטופל"   → the reminder closes; no money is recorded.
 *   - "ביטול"               → nothing happens.
 *
 * Rendered in the shared finance-ui dialog (centered on wide screens, a bottom
 * sheet on phones; focus trap and Escape come with it).
 */

import { useState } from "react";
import type { ObligationApi } from "@/lib/obligations/secretary-client";
import { METHOD_LABEL } from "@/lib/payables/payables-client";
import {
  Button,
  DialogFrame,
  Field,
  Money,
  Notice,
  fieldInputClass,
  formErrorClass,
  hebrewErrorMessage,
  israelDayKey,
} from "@/components/finance-ui";

export type PaidDetails = { amount: string; paidAt: string; method: string };

// The order the owner is most likely to pick; labels are the payables wording.
const METHOD_ORDER = [
  "BANK_TRANSFER",
  "CREDIT_CARD",
  "STANDING_ORDER",
  "DIRECT_DEBIT",
  "CHECK",
  "CASH",
  "BIT",
  "PAYBOX",
  "OTHER",
] as const;

function displayName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length >= 2 ? trimmed : "התחייבות ללא שם";
}

export function PaidQuestionSheet({
  obligation,
  onPaid,
  onHandledOnly,
  onCancel,
  initialStep = "ask",
}: {
  obligation: ObligationApi;
  onPaid: (details: PaidDetails) => Promise<void>;
  onHandledOnly: () => Promise<void>;
  onCancel: () => void;
  /** "details" when the owner already said "שילמתי" (the row button). */
  initialStep?: "ask" | "details";
}) {
  const [step, setStep] = useState<"ask" | "details">(initialStep);
  const [amount, setAmount] = useState(obligation.ledger?.remaining ?? obligation.amount);
  const today = israelDayKey(new Date());
  const [paidAt, setPaidAt] = useState(today);
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [busy, setBusy] = useState<null | "paid" | "handled">(null);
  const [error, setError] = useState<string | null>(null);
  const name = displayName(obligation.obligeeName);

  async function run(kind: "paid" | "handled", fn: () => Promise<void>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(hebrewErrorMessage(e, "לא הצלחנו לשמור. שום דבר לא נרשם, ואפשר לנסות שוב."));
      setBusy(null);
    }
  }

  const close = () => {
    if (!busy) onCancel();
  };

  return (
    <DialogFrame
      open
      onClose={close}
      title={step === "ask" ? `שילמת ל${name}?` : "פרטי התשלום"}
      footer={
        step === "ask" ? (
          <>
            <Button variant="primary" disabled={Boolean(busy)} onClick={() => setStep("details")}>
              כן, שילמתי
            </Button>
            <Button variant="secondary" busy={busy === "handled"} disabled={Boolean(busy)} onClick={() => void run("handled", onHandledOnly)}>
              לא, רק לסמן שטופל
            </Button>
            <Button variant="quiet" disabled={Boolean(busy)} onClick={close}>
              ביטול
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" busy={busy === "paid"} disabled={Boolean(busy)} onClick={() => {
              const form = document.getElementById("paid-question-form") as HTMLFormElement | null;
              form?.requestSubmit();
            }}>
              רישום התשלום
            </Button>
            <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setStep("ask")}>
              חזרה
            </Button>
          </>
        )
      }
    >
      {step === "ask" ? (
        <>
          {obligation.ledger ? (
            <p style={{ margin: 0, fontSize: 15 }}>
              נותר לתשלום: <Money amount={obligation.ledger.remaining} currency={obligation.currency} />
            </p>
          ) : null}
          <Notice tone="neutral">
            אם הכסף כבר יצא, נרשום את התשלום בהתחייבויות. אם רק טיפלת בזה בלי לשלם, התזכורת תיסגר ולא יירשם תשלום.
          </Notice>
        </>
      ) : (
        <form
          id="paid-question-form"
          style={{ display: "grid", gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run("paid", () => onPaid({ amount: amount.trim(), paidAt, method }));
          }}
        >
          <Field label="סכום ששולם" htmlFor="paid-amount">
            <input id="paid-amount" className={fieldInputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <Field label="תאריך התשלום" htmlFor="paid-at">
            <input id="paid-at" className={fieldInputClass} type="date" value={paidAt} max={today} onChange={(e) => setPaidAt(e.target.value)} required />
          </Field>
          <Field label="איך שילמת" htmlFor="paid-method">
            <select id="paid-method" className={fieldInputClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHOD_ORDER.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>
          <Notice tone="neutral">התשלום נרשם בהתחייבויות, והתזכורת במזכירה תיסגר. רישום כאן לא מעביר כסף.</Notice>
        </form>
      )}
      {error ? (
        <p role="alert" className={formErrorClass}>
          {error}
        </p>
      ) : null}
    </DialogFrame>
  );
}
