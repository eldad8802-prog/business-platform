"use client";

/**
 * #9 — Open receivables (read-only). Lists issued tax invoices the customer
 * still owes (no verified PAID payment yet), derived live from Billing data.
 * NOT a new source of truth: it reads /api/billing/receivables, which derives
 * from BillingDocument + PaymentRequest state. A collection is opened from the
 * invoice screen (#10); this screen only surfaces what is still owed.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import SmartBackButton from "@/components/ui/smart-back-button";
import { TOKEN } from "@/lib/design/billing-theme";

type ReceivableItem = {
  documentId: number;
  documentNumber: string | null;
  customerName: string | null;
  amount: string;
  currency: string;
  issuedAt: string | null;
  openDays: number | null;
};
type ReceivablesTotal = { currency: string; amount: string; count: number };
type ReceivablesResult = {
  items: ReceivableItem[];
  totals: ReceivablesTotal[];
  count: number;
};

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
}

export default function BillingReceivablesPage() {
  const [data, setData] = useState<ReceivablesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/billing/receivables", {
          headers: { Authorization: `Bearer ${getAuthToken()}` },
          cache: "no-store",
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(json?.error || "שגיאה בטעינת החובות הפתוחים");
        }
        if (!cancelled) setData(json as ReceivablesResult);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "שגיאה בטעינת החובות הפתוחים");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: TOKEN.surface.card }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          background: TOKEN.surface.card,
          borderBottom: `1px solid ${TOKEN.border.DEFAULT}`,
          position: "sticky",
          top: 0,
          zIndex: 2,
        }}
      >
        <SmartBackButton fallbackHref="/billing" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: TOKEN.ink.primary }}>חובות פתוחים</div>
          <div style={{ fontSize: 13, color: TOKEN.ink.muted, marginTop: 2 }}>
            חשבוניות שהופקו וטרם נגבו
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 720, margin: "0 auto", padding: "16px", display: "grid", gap: 14 }}>
        {loading ? (
          <div style={{ fontSize: 14, color: TOKEN.ink.muted }}>טוען…</div>
        ) : error ? (
          <div
            role="alert"
            style={{
              background: TOKEN.semantic.urgent.bg,
              border: `1px solid ${TOKEN.semantic.urgent.border}`,
              color: TOKEN.semantic.urgent.ink,
              borderRadius: 12,
              padding: "10px 12px",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        ) : !data || data.count === 0 ? (
          <div
            style={{
              background: TOKEN.surface.card,
              border: `1px solid ${TOKEN.border.DEFAULT}`,
              borderRadius: 14,
              padding: 20,
              textAlign: "center",
              color: TOKEN.ink.muted,
              fontSize: 14,
            }}
          >
            אין חובות פתוחים — כל החשבוניות שהופקו נגבו.
          </div>
        ) : (
          <>
            {data.totals.map((t) => (
              <div
                key={t.currency}
                style={{
                  background: TOKEN.surface.inset,
                  border: `1px solid ${TOKEN.border.DEFAULT}`,
                  borderRadius: 14,
                  padding: "14px 16px",
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: TOKEN.ink.muted }}>
                  סה״כ פתוח ({t.count} חשבוניות)
                </span>
                <strong style={{ fontSize: 20, fontWeight: 700, color: TOKEN.ink.primary }}>
                  {formatMoney(t.amount, t.currency)}
                </strong>
              </div>
            ))}

            <div style={{ display: "grid", gap: 10 }}>
              {data.items.map((item) => (
                <Link
                  key={item.documentId}
                  href={`/billing/${item.documentId}`}
                  style={{
                    display: "grid",
                    gap: 4,
                    background: TOKEN.surface.card,
                    border: `1px solid ${TOKEN.border.DEFAULT}`,
                    borderRadius: 14,
                    padding: "12px 14px",
                    textDecoration: "none",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: TOKEN.ink.primary }} dir="auto">
                      {item.customerName || "ללא לקוח"}
                    </span>
                    <strong style={{ fontSize: 16, fontWeight: 700, color: TOKEN.ink.primary }}>
                      {formatMoney(item.amount, item.currency)}
                    </strong>
                  </div>
                  <div style={{ fontSize: 12, color: TOKEN.ink.muted }}>
                    {item.documentNumber ? `חשבונית ${item.documentNumber} · ` : ""}
                    הופקה {formatDate(item.issuedAt)}
                    {item.openDays != null ? ` · פתוחה ${item.openDays} ימים` : ""}
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
