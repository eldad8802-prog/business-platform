"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Minimal payment-provider connection UI (P1.3).
 *
 * Connects a clearing provider (Tranzila) from Settings → Connections using the
 * existing payments API:
 *   GET  /api/payments/connections          → connected state (no secrets)
 *   POST /api/payments/connections/tranzila → save/update connection
 *
 * The credential field is write-only: it is sent on submit and never read back.
 * The server's public connection shape carries no credential material at all.
 * No Tranzila-live, no disconnect, no adapter changes.
 */

type PublicConnection = {
  provider: string;
  merchantId: string | null;
  isActive: boolean;
  hasCredential: boolean;
};

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

export function PaymentConnectionCard() {
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<PublicConnection | null>(null);
  const [editing, setEditing] = useState(false);
  const [merchantId, setMerchantId] = useState("");
  const [credential, setCredential] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        const tranzila = list.find((c) => c.provider === "TRANZILA") ?? null;
        setConnection(tranzila);
      }
    } catch {
      // Soft-fail: show the not-connected form.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isConnected = connection != null && connection.isActive;
  const showForm = !isConnected || editing;

  async function handleSubmit() {
    if (submitting) return;
    if (!merchantId.trim()) {
      setError("יש להזין מזהה מסוף (Merchant ID).");
      return;
    }
    if (!credential) {
      setError("יש להזין מפתח / Secret.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/payments/connections/tranzila", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          merchantId: merchantId.trim(),
          credential,
        }),
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
      const saved: PublicConnection | null = data?.connection ?? null;
      setConnection(saved);
      setEditing(false);
      setCredential(""); // never retain the secret in memory longer than needed
      setNotice("Tranzila מחובר.");
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
        {isConnected ? (
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
      ) : isConnected && !editing ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3">
            <div className="text-sm font-bold text-gray-900">Tranzila מחובר</div>
            <div className="mt-1 text-xs text-gray-600">
              מזהה מסוף: {connection?.merchantId ?? "—"}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setMerchantId(connection?.merchantId ?? "");
              setCredential("");
              setError(null);
              setNotice(null);
            }}
            className="min-h-11 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-bold text-gray-700"
          >
            עדכן חיבור
          </button>
        </div>
      ) : showForm ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="text-xs font-semibold text-gray-500">ספק: Tranzila</div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-gray-700">
              מזהה מסוף (Merchant ID)
            </span>
            <input
              type="text"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              autoComplete="off"
              className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
              placeholder="terminal / merchant id"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-gray-700">
              מפתח / Secret
            </span>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="new-password"
              className="min-h-11 rounded-xl border border-gray-300 px-3 text-sm text-gray-900"
              placeholder="לא יוצג לאחר השמירה"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className="min-h-11 flex-1 rounded-2xl bg-gray-900 px-4 text-sm font-bold text-white disabled:opacity-50"
            >
              {submitting
                ? "שומר…"
                : editing
                ? "שמור עדכון"
                : "חבר ספק"}
            </button>
            {editing ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setCredential("");
                  setError(null);
                }}
                disabled={submitting}
                className="min-h-11 rounded-2xl border border-gray-300 bg-white px-4 text-sm font-bold text-gray-700 disabled:opacity-50"
              >
                ביטול
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
