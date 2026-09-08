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
 *
 * Provider: with one active connection the screen sends it explicitly and shows
 * no choice, which is the same outcome the server would have reached on its own.
 * With several, the server refuses to pick one, so a selector appears and the
 * merchant says which acquirer takes the payment.
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

/** One of the business's payment connections. Never carries any secret. */
type ConnectedProvider = { provider: string; isActive: boolean };

/** Provider display names. A key with no entry falls back to the key itself. */
const PROVIDER_LABEL: Record<string, string> = {
  CARDCOM: "CardCom",
  TRANZILA: "Tranzila",
  PAYPAL: "PayPal",
};

export default function StandalonePaymentsPage() {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("ILS");
  const [description, setDescription] = useState("");
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });
  /**
   * The business's ACTIVE providers. Normally exactly one, and then no choice
   * is offered — asking someone to pick from a list of one is a question with
   * no information in it. The selector appears only when the answer is
   * genuinely ambiguous, which is the case a second acquirer creates.
   */
  const [providers, setProviders] = useState<ConnectedProvider[]>([]);
  const [provider, setProvider] = useState<string>("");

  useEffect(() => {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) router.replace("/login");
  }, [router]);

  useEffect(() => {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("token") : null;
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/payments/connections", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { connections?: ConnectedProvider[] };
        if (cancelled) return;
        const active = (data.connections ?? []).filter((c) => c.isActive);
        setProviders(active);
        // Preselect when there is exactly one, so the body is explicit either
        // way and the server never has to infer anything.
        if (active.length === 1) setProvider(active[0]!.provider);
      } catch {
        // Soft-fail. The server still resolves a single active provider by
        // itself, so a failed catalogue read must not block creating a charge.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const amountValue = Number(amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0;
  const busy = submit.status === "submitting" || submit.status === "redirecting";
  // With several active providers the choice is REQUIRED: submitting without
  // one would be refused by the server, so the button stays disabled until the
  // merchant has actually answered the question.
  const providerChosen = providers.length <= 1 || provider !== "";
  const canSubmit = amountValid && providerChosen;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || busy) return;

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
        // No billingDocumentId — this is a standalone request. `provider` is
        // omitted unless one is known, which keeps the single-connection body
        // byte-for-byte what it was.
        body: JSON.stringify({
          amount,
          currency,
          description: description.trim() ? description.trim() : undefined,
          ...(provider ? { provider } : {}),
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
        background: "var(--dz-surface)",
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
              color: "var(--dz-text-muted)",
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

          {/*
            Shown only when the business has more than one active provider.
            With one, the answer is already known and the field would be noise;
            with several, the server refuses to choose and this is where the
            merchant says which acquirer takes the payment.
          */}
          {providers.length > 1 ? (
            <label style={{ display: "grid", gap: 6 }}>
              <span style={labelStyle}>ספק סליקה</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={inputStyle}
                required
              >
                <option value="">בחר ספק</option>
                {providers.map((c) => (
                  <option key={c.provider} value={c.provider}>
                    {PROVIDER_LABEL[c.provider] ?? c.provider}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

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
                color: "var(--dz-danger)",
                background: "rgba(155, 70, 52, 0.07)",
                borderRadius: 12,
                padding: "10px 12px",
              }}
            >
              {submit.message}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit || busy}
            style={{
              minHeight: 52,
              borderRadius: 14,
              border: "none",
              background: !canSubmit || busy ? "var(--dz-info-border)" : BRAND,
              color: "var(--dz-text-on-brand)",
              fontSize: 16,
              fontWeight: 800,
              cursor: !canSubmit || busy ? "default" : "pointer",
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
              color: "var(--dz-text-muted)",
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
  color: "var(--dz-text-secondary)",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: 48,
  borderRadius: 12,
  border: "1px solid rgba(102, 111, 101, 0.5)",
  background: "var(--dz-surface)",
  padding: "0 14px",
  fontSize: 16,
  color: "var(--dz-text-primary)",
  outline: "none",
  boxSizing: "border-box",
};
