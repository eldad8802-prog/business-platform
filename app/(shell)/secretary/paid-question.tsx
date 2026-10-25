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
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n/translate";
import { obligationTitle, type ObligationApi } from "@/lib/obligations/secretary-client";

export type PaidDetails = { amount: string; paidAt: string; method: string };

const METHODS: Array<{ value: string; label: MessageKey }> = [
  { value: "BANK_TRANSFER", label: "tasks.secretary.paid.methods.bankTransfer" },
  { value: "CREDIT_CARD", label: "tasks.secretary.paid.methods.creditCard" },
  { value: "STANDING_ORDER", label: "tasks.secretary.paid.methods.standingOrder" },
  { value: "DIRECT_DEBIT", label: "tasks.secretary.paid.methods.directDebit" },
  { value: "CHECK", label: "tasks.secretary.paid.methods.check" },
  { value: "CASH", label: "tasks.secretary.paid.methods.cash" },
  { value: "BIT", label: "tasks.secretary.paid.methods.bit" },
  { value: "PAYBOX", label: "tasks.secretary.paid.methods.paybox" },
  { value: "OTHER", label: "tasks.secretary.paid.methods.other" },
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
  const { t } = useI18n();
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
      setError(e instanceof Error ? e.message : t("tasks.secretary.paid.error"));
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="paid-question-title" style={backdrop}>
      <div style={sheet}>
        <h2 id="paid-question-title" style={title}>
          {step === "ask" ? t("tasks.secretary.paid.question", { name: obligationTitle(obligation) }) : t("tasks.secretary.paid.detailsTitle")}
        </h2>

        {step === "ask" ? (
          <>
            <p style={body}>{t("tasks.secretary.paid.body")}</p>
            <button type="button" style={primary} disabled={busy} onClick={() => setStep("details")}>
              {t("tasks.secretary.paid.yes")}
            </button>
            <button type="button" style={secondary} disabled={busy} onClick={() => void run(onHandledOnly)}>
              {t("tasks.secretary.paid.handledOnly")}
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
              {t("tasks.secretary.paid.amount")}
              <input style={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </label>
            <label style={label}>
              {t("tasks.secretary.paid.date")}
              <input style={input} type="date" value={paidAt} max={todayIso()} onChange={(e) => setPaidAt(e.target.value)} required />
            </label>
            <label style={label}>
              {t("tasks.secretary.paid.method")}
              <select style={input} value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {t(m.label)}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" style={primary} disabled={busy}>
              {t("tasks.secretary.paid.submit")}
            </button>
          </form>
        )}

        {error ? (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        ) : null}
        <button type="button" style={ghost} disabled={busy} onClick={onCancel}>
          {t("tasks.secretary.paid.cancel")}
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
