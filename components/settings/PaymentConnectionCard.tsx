"use client";

import { useCallback, useEffect, useState } from "react";
import { TOKEN } from "@/lib/design/tokens";
import {
  WarmButton,
  WarmCard,
  WarmField,
  WarmPill,
  warmInputStyle,
} from "@/components/ui/warm/warm-primitives";

/**
 * Payment-provider connection UI (P1.3 + I4) — warm design language.
 *
 * Connects a clearing provider (Tranzila or CardCom) from Settings → Connections
 * using the existing payments API:
 *   GET  /api/payments/connections           → connected state (no secrets)
 *   POST /api/payments/connections/tranzila  → save/update Tranzila
 *   POST /api/payments/connections/cardcom   → save/update CardCom
 *
 * This is the TECHNICAL settings screen — both providers stay visible here
 * (Tranzila is not hidden). The business-facing warm surfaces are CardCom-first
 * elsewhere. All secret fields are write-only; no live provider calls.
 *
 * States: connected · not-connected · error (error CTA doubles as reconnect).
 * Styling only — logic unchanged.
 */

const W = TOKEN.warm;

type ProviderKey = "TRANZILA" | "CARDCOM" | "PAYPAL";

type PublicConnection = {
  provider: string;
  merchantId: string | null;
  isActive: boolean;
  hasCredential: boolean;
};

/**
 * Providers a business may CONNECT. Deliberately narrower than ProviderKey:
 * Tranzila and PayPal remain in the union so an existing connection still
 * renders with its real name, but neither can be selected — their webhook
 * consumers were disabled in CASA Wave E, and offering a provider whose
 * callback is switched off would let a business take a payment that could
 * never be confirmed.
 *
 * Guarded by lib/services/payments/dormant-provider-closure.test.ts: this list
 * must equal the server's enabled set, so re-adding an option here without
 * re-enabling the capability fails CI.
 */
const SELECTABLE_PROVIDERS: readonly ProviderKey[] = ["CARDCOM"] as const;

const PROVIDER_LABEL: Record<ProviderKey, string> = {
  TRANZILA: "Tranzila",
  CARDCOM: "CardCom",
  PAYPAL: "PayPal",
};

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function PaymentConnectionCard() {
  const [loading, setLoading] = useState(true);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Form state
  const [provider, setProvider] = useState<ProviderKey>("CARDCOM");
  const [merchantId, setMerchantId] = useState("");
  const [secret, setSecret] = useState(""); // Tranzila credential (write-only)
  const [apiName, setApiName] = useState(""); // CardCom
  const [apiPassword, setApiPassword] = useState(""); // CardCom (write-only)

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/payments/connections", {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        const list: PublicConnection[] = Array.isArray(data?.connections)
          ? data.connections
          : [];
        setConnections(list);
      }
    } catch {
      // Soft-fail: show the form.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeConnections = connections.filter((c) => c.isActive);
  const anyConnected = activeConnections.length > 0;

  function resetSecrets() {
    setSecret("");
    setApiPassword("");
  }

  async function handleSubmit() {
    if (submitting) return;
    setError(null);
    setNotice(null);

    if (!merchantId.trim()) {
      setError("יש להזין מספר מסוף (Terminal / Merchant ID).");
      return;
    }

    let path: string;
    let payload: Record<string, unknown>;
    if (provider === "PAYPAL") {
      // Sandbox: PayPal credentials come from server env; the connection is an
      // activation flag. Uses the generic descriptor-driven connection route.
      path = "/api/payments/connections";
      payload = { provider: "PAYPAL", merchantId: merchantId.trim() };
    } else if (provider === "TRANZILA") {
      if (!secret) {
        setError("יש להזין מפתח / Secret.");
        return;
      }
      path = "/api/payments/connections/tranzila";
      payload = { merchantId: merchantId.trim(), credential: secret };
    } else {
      if (!apiName.trim()) {
        setError("יש להזין API Name.");
        return;
      }
      if (!apiPassword) {
        setError("יש להזין API Password.");
        return;
      }
      path = "/api/payments/connections/cardcom";
      payload = {
        terminalNumber: merchantId.trim(),
        apiName: apiName.trim(),
        apiPassword,
      };
    }

    setSubmitting(true);
    try {
      const token = getAuthToken();
      const res = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          data && typeof data.error === "string"
            ? data.error
            : "לא הצלחנו לשמור את החיבור."
        );
        return;
      }
      resetSecrets(); // never retain secrets in memory longer than needed
      setNotice(`${PROVIDER_LABEL[provider]} מחובר.`);
      await load();
    } catch {
      setError("לא הצלחנו לשמור את החיבור.");
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = submitting
    ? "שומר…"
    : error
      ? "התחבר מחדש"
      : anyConnected
        ? "עדכן חיבור"
        : "חבר ספק";

  return (
    <WarmCard style={{ direction: "rtl" } as React.CSSProperties}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 15, fontWeight: TOKEN.weight.semibold, color: W.ink }}>
          גבייה
        </h2>
        {anyConnected ? (
          <WarmPill tone="verified">מחובר</WarmPill>
        ) : (
          <WarmPill tone="waiting">לא מחובר</WarmPill>
        )}
      </div>
      <p style={{ marginTop: 4, fontSize: 12, lineHeight: 1.55, color: W.muted }}>
        חיבור ספק סליקה חיצוני. דוביז אינה שומרת פרטי כרטיס — התשלום מתבצע אצל
        הספק.
      </p>

      {error ? (
        <div
          role="alert"
          style={{
            marginTop: 12,
            borderRadius: W.radius.control,
            background: W.status.late.bg,
            color: W.status.late.ink,
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          style={{
            marginTop: 12,
            borderRadius: W.radius.control,
            background: W.status.verified.bg,
            color: W.status.verified.ink,
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {notice}
        </div>
      ) : null}

      {loading ? (
        <p style={{ marginTop: 16, fontSize: 12, color: W.muted2 }}>טוען…</p>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {anyConnected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {activeConnections.map((c) => (
                <div
                  key={c.provider}
                  style={{
                    borderRadius: W.radius.control,
                    border: `1px solid ${W.line}`,
                    background: W.surface2,
                    padding: "12px 14px",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: TOKEN.weight.semibold, color: W.ink }}>
                    {PROVIDER_LABEL[c.provider as ProviderKey] ?? c.provider} מחובר
                  </div>
                  <div style={{ marginTop: 2, fontSize: 12, color: W.muted }}>
                    מספר מסוף: {c.merchantId ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: TOKEN.weight.semibold,
                color: W.muted,
                marginBottom: 12,
              }}
            >
              {anyConnected ? "הוסף / עדכן חיבור" : "חבר ספק סליקה"}
            </div>

            <WarmField label="ספק">
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as ProviderKey);
                  resetSecrets();
                  setError(null);
                }}
                style={warmInputStyle()}
              >
                {SELECTABLE_PROVIDERS.map((key) => (
                  <option key={key} value={key}>
                    {PROVIDER_LABEL[key]}
                  </option>
                ))}
              </select>
            </WarmField>

            <WarmField
              label={
                provider === "CARDCOM"
                  ? "מספר מסוף (Terminal Number)"
                  : provider === "PAYPAL"
                    ? "תווית הפעלה (sandbox)"
                    : "מזהה מסוף (Merchant ID)"
              }
            >
              <input
                type="text"
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
                autoComplete="off"
                style={warmInputStyle()}
                placeholder={
                  provider === "CARDCOM"
                    ? "terminal number"
                    : provider === "PAYPAL"
                      ? "למשל: sandbox"
                      : "terminal / merchant id"
                }
              />
            </WarmField>

            {provider === "PAYPAL" ? (
              <p style={{ fontSize: 12, color: W.muted, lineHeight: 1.55, margin: "0 2px 4px" }}>
                אישורי-הסליקה של PayPal מגיעים מהשרת (sandbox env). כאן רק מפעילים
                את PayPal כספק פעיל לבדיקות.
              </p>
            ) : provider === "TRANZILA" ? (
              <WarmField label="מפתח / Secret">
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="new-password"
                  style={warmInputStyle()}
                  placeholder="לא יוצג לאחר השמירה"
                />
              </WarmField>
            ) : (
              <>
                <WarmField label="API Name">
                  <input
                    type="text"
                    value={apiName}
                    onChange={(e) => setApiName(e.target.value)}
                    autoComplete="off"
                    style={warmInputStyle()}
                    placeholder="api name"
                  />
                </WarmField>
                <WarmField label="API Password">
                  <input
                    type="password"
                    value={apiPassword}
                    onChange={(e) => setApiPassword(e.target.value)}
                    autoComplete="new-password"
                    style={warmInputStyle()}
                    placeholder="לא יוצג לאחר השמירה"
                  />
                </WarmField>
              </>
            )}

            <WarmButton
              variant="primary"
              fullWidth
              height={48}
              onClick={() => void handleSubmit()}
              disabled={submitting}
            >
              {submitLabel}
            </WarmButton>
          </div>
        </div>
      )}
    </WarmCard>
  );
}
