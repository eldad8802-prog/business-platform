"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Payment-provider connection UI (P1.3 + I4).
 *
 * Connects a clearing provider (Tranzila or CardCom) from Settings → Connections
 * using the existing payments API:
 *   GET  /api/payments/connections           → connected state (no secrets)
 *   POST /api/payments/connections/tranzila  → save/update Tranzila
 *   POST /api/payments/connections/cardcom   → save/update CardCom
 *
 * All secret fields are write-only: sent on submit, never read back. The
 * server's public connection shape carries no credential material. No live
 * provider calls, no disconnect.
 */

type ProviderKey = "TRANZILA" | "CARDCOM";

type PublicConnection = {
  provider: string;
  merchantId: string | null;
  isActive: boolean;
  hasCredential: boolean;
};

const PROVIDER_LABEL: Record<ProviderKey, string> = {
  TRANZILA: "Tranzila",
  CARDCOM: "CardCom",
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
  const [provider, setProvider] = useState<ProviderKey>("TRANZILA");
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
    if (provider === "TRANZILA") {
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

  return (
    <section className="rounded-[24px] bg-white p-4 shadow-sm" dir="rtl">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-gray-900">סליקה</h2>
        {anyConnected ? (
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
            מחובר
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-bold text-gray-500">
            לא מחובר
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-5 text-gray-500">
        חיבור ספק סליקה חיצוני. דוביז אינה שומרת פרטי כרטיס — התשלום מתבצע אצל
        הספק.
      </p>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700"
        >
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          role="status"
          className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700"
        >
          {notice}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-4 text-xs text-gray-400">טוען…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          {anyConnected ? (
            <div className="flex flex-col gap-2">
              {activeConnections.map((c) => (
                <div
                  key={c.provider}
                  className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3"
                >
                  <div className="text-sm font-bold text-gray-900">
                    {PROVIDER_LABEL[c.provider as ProviderKey] ?? c.provider}{" "}
                    מחובר
                  </div>
                  <div className="mt-1 text-xs text-gray-600">
                    מספר מסוף: {c.merchantId ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-gray-500">
              {anyConnected ? "הוסף / עדכן חיבור" : "חבר ספק סליקה"}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-gray-700">ספק</span>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as ProviderKey);
                  resetSecrets();
                  setError(null);
                }}
                className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
              >
                <option value="TRANZILA">Tranzila</option>
                <option value="CARDCOM">CardCom</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-gray-700">
                {provider === "CARDCOM"
                  ? "מספר מסוף (Terminal Number)"
                  : "מזהה מסוף (Merchant ID)"}
              </span>
              <input
                type="text"
                value={merchantId}
                onChange={(e) => setMerchantId(e.target.value)}
                autoComplete="off"
                className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
                placeholder={provider === "CARDCOM" ? "terminal number" : "terminal / merchant id"}
              />
            </label>

            {provider === "TRANZILA" ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold text-gray-700">
                  מפתח / Secret
                </span>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="new-password"
                  className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
                  placeholder="לא יוצג לאחר השמירה"
                />
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-gray-700">
                    API Name
                  </span>
                  <input
                    type="text"
                    value={apiName}
                    onChange={(e) => setApiName(e.target.value)}
                    autoComplete="off"
                    className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
                    placeholder="api name"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-gray-700">
                    API Password
                  </span>
                  <input
                    type="password"
                    value={apiPassword}
                    onChange={(e) => setApiPassword(e.target.value)}
                    autoComplete="new-password"
                    className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
                    placeholder="לא יוצג לאחר השמירה"
                  />
                </label>
              </>
            )}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="min-h-11 rounded-2xl bg-gray-900 px-4 text-sm font-bold text-white disabled:opacity-50"
            >
              {submitting ? "שומר…" : "חבר ספק"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
