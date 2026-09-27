"use client";

/**
 * "שילמת?" — asked when the owner presses "טופל" on a ledger-backed item.
 *
 * handled ≠ paid. Pressing "טופל" never creates a payment by itself:
 *   - "כן, שילמתי"   → only the missing payment details are asked (amount,
 *                      date, method — prefilled), then the REAL payables
 *                      payment flow records it, then the reminder closes.
 *   - "לא, רק טופל"  → the reminder closes; no money is recorded.
 *   - "ביטול"        → nothing happens.
 */

import { useState } from "react";
import type { ObligationApi } from "@/lib/obligations/secretary-client";

export type PaidDetails = { amount: string; paidAt: string; method: string };

const METHODS: Array<{ value: string; label: string }> = [
  { value: "BANK_TRANSFER", label: "העברה בנקאית" },
  { value: "CREDIT_CARD", label: "כרטיס אשראי" },
  { value: "STANDING_ORDER", label: "הוראת קבע" },
  { value: "DIRECT_DEBIT", label: "חיוב ישיר" },
  { value: "CHECK", label: "צ'ק" },
  { value: "CASH", label: "מזומן" },
  { value: "BIT", label: "ביט" },
  { value: "PAYBOX", label: "פייבוקס" },
  { value: "OTHER", label: "אחר" },
];

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function PaidQuestionSheet({
  obligation,
  onPaid,
  onHandledOnly,
  onCancel,
}: {
  obligation: ObligationApi;
  onPaid: (details: PaidDetails) => Promise<void>;
  onHandledOnly: () => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"ask" | "details">("ask");
  const [amount, setAmount] = useState(obligation.ledger?.remaining ?? obligation.amount);
  const [paidAt, setPaidAt] = useState(todayIso());
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "משהו השתבש, נסה שוב");
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paid-question-title" dir="rtl" style={backdrop}>
      <div style={sheet}>
        <h2 id="paid-question-title" style={title}>
          {step === "ask" ? `שילמת ל${obligation.obligeeName}?` : "פרטי התשלום"}
        </h2>

        {step === "ask" ? (
          <>
            <p style={body}>סימון &quot;טופל&quot; סוגר את התזכורת. אם הכסף כבר יצא — אספר אותו כתשלום.</p>
            <button type="button" style={primary} disabled={busy} onClick={() => setStep("details")}>
              כן, שילמתי
            </button>
            <button type="button" style={secondary} disabled={busy} onClick={() => void run(onHandledOnly)}>
              לא, רק לסמן שטופל
            </button>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => onPaid({ amount: amount.trim(), paidAt, method }));
            }}
          >
            <label style={label}>
              סכום ששולם
              <input style={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </label>
            <label style={label}>
              תאריך התשלום
              <input style={input} type="date" value={paidAt} max={todayIso()} onChange={(e) => setPaidAt(e.target.value)} required />
            </label>
            <label style={label}>
              איך שילמת
              <select style={input} value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" style={primary} disabled={busy}>
              רשום תשלום וסמן שטופל
            </button>
          </form>
        )}

        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
        <button type="button" style={ghost} disabled={busy} onClick={onCancel}>
          ביטול
        </button>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.45)",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  zIndex: 1000,
};
const sheet: React.CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "var(--surface, #fff)",
  color: "var(--text, #0f172a)",
  borderRadius: "20px 20px 0 0",
  padding: "20px 16px 28px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const title: React.CSSProperties = { fontSize: 20, fontWeight: 700, margin: 0 };
const body: React.CSSProperties = { fontSize: 15, margin: "0 0 6px", opacity: 0.8 };
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 14, marginBottom: 10 };
const input: React.CSSProperties = { fontSize: 16, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1" };
const primary: React.CSSProperties = {
  width: "100%",
  padding: "14px 16px",
  borderRadius: 12,
  border: "none",
  background: "#0f172a",
  color: "#fff",
  fontSize: 16,
  fontWeight: 600,
};
const secondary: React.CSSProperties = { ...primary, background: "#e2e8f0", color: "#0f172a" };
const ghost: React.CSSProperties = { ...primary, background: "transparent", color: "#475569", fontWeight: 500 };
const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: 14, margin: 0 };
