"use client";

/**
 * Standalone Payments (סליקה) — create a payment request WITHOUT any invoice,
 * tax document, receipt, or fiscal numbering.
 *
 * The form collects only amount / currency / description and POSTs to the
 * generic /api/payments/requests endpoint WITHOUT a billingDocumentId — the
 * backend already treats a request with no billingDocumentId as standalone.
 * On success we redirect the browser to the provider's hosted checkout URL.
 *
 * Deliberately no BillingDocument, no Tax Authority flow, no customer capture.
 * Provider is chosen by the business's single active connection (same as the
 * existing invoice→payment flow); this screen sends no provider hint.
 *
 * NOTE: relocated verbatim from /payments to /payments/new when /payments
 * became the Collection Workspace. Logic unchanged (real V1 standalone create).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TOKEN } from "@/lib/design/tokens";

const BRAND = TOKEN.warm.tealDeep;
const CURRENCIES = ["ILS", "USD", "EUR"] as const;
type Currency = (typeof CURRENCIES)[number];

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "redirecting" }
  | { status: "error"; message: string };

export default function StandalonePaymentsPage() {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("ILS");
  const [description, setDescription] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  useEffect(() => {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) router.replace("/login");
  }, [router]);

  const amountValue = Number(amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0;
  const busy = submit.status === "submitting" || submit.status === "redirecting";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!amountValid || busy) return;

    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) {
      router.replace("/login");
      return;
    }

    setSubmit({ status: "submitting" });
    try {
      const res = await fetch("/api/payments/requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        // No billingDocumentId — this is a standalone request.
        body: JSON.stringify({
          amount,
          currency,
          description: description.trim() ? description.trim() : undefined,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        paymentUrl?: string | null;
        error?: string;
        message?: string;
      };

      if (!res.ok) {
        throw new Error(
          data.error || data.message || "לא הצלחתי ליצור קישור תשלום"
        );
      }
      if (!data.paymentUrl) {
        throw new Error("הבקשה נוצרה אך לא התקבל קישור תשלום");
      }

      setSubmit({ status: "redirecting" });
      window.location.href = data.paymentUrl;
    } catch (error) {
      setSubmit({
        status: "error",
        message:
          error instanceof Error ? error.message : "אירעה שגיאה בלתי צפויה",
      });
    }
  }

  return (
    <div
      dir="rtl"
      style={{
        minHeight: "100%",
        background: "#ffffff",
        padding: "24px 18px 40px",
      }}
    >
      <div style={{ maxWidth: 440, margin: "0 auto" }}>
        <header style={{ marginBottom: 20 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              fontWeight: 600,
              color: TOKEN.warm.ink,
              letterSpacing: "-0.02em",
            }}
          >
            גבייה
          </h1>
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 14,
              lineHeight: 1.5,
              color: "#64748b",
            }}
          >
            קבלת תשלום מהירה — ללא חשבונית וללא מסמך מס.
          </p>
        </header>

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={labelStyle}>סכום</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
              style={inputStyle}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={labelStyle}>מטבע</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as Currency)}
              style={inputStyle}
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={labelStyle}>תיאור (אופציונלי)</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="למשל: תשלום עבור שירות"
              maxLength={200}
              style={inputStyle}
            />
          </label>

          {submit.status === "error" ? (
            <p
              role="alert"
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 600,
                color: "#b91c1c",
                background: "rgba(185, 28, 28, 0.07)",
                borderRadius: 12,
                padding: "10px 12px",
              }}
            >
              {submit.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!amountValid || busy}
            style={{
              minHeight: 52,
              borderRadius: 14,
              border: "none",
              background: !amountValid || busy ? "#9db4d4" : BRAND,
              color: "#ffffff",
              fontSize: 16,
              fontWeight: 800,
              cursor: !amountValid || busy ? "default" : "pointer",
              transition: "background 0.15s ease",
              touchAction: "manipulation",
            }}
          >
            {submit.status === "submitting"
              ? "יוצר בקשה…"
              : submit.status === "redirecting"
                ? "מעביר לתשלום…"
                : "צור קישור תשלום"}
          </button>

          <p
            style={{
              margin: 0,
              fontSize: 12,
              lineHeight: 1.5,
              color: "#94a3b8",
              textAlign: "center",
            }}
          >
            לאחר היצירה תועבר לעמוד הסליקה המאובטח של ספק הסליקה שלך.
          </p>
        </form>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#334155",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 48,
  borderRadius: 12,
  border: "1px solid rgba(148, 163, 184, 0.5)",
  background: "#ffffff",
  padding: "0 14px",
  fontSize: 16,
  color: "#0f172a",
  outline: "none",
  boxSizing: "border-box",
};
