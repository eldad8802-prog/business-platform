"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/ui/page-header";
import { TOKEN } from "@/lib/design/tokens";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";
import {
  BusinessIdentitySetupForm,
  emptyInvoiceIdentityForm,
  type InvoiceProfileFormState,
} from "@/components/billing/BusinessIdentitySetupForm";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

type FullProfile = InvoiceProfileFormState & {
  billingVatNumber: string | null;
  billingPaymentNote: string | null;
  billingFooterNote: string | null;
};

const emptyFull: FullProfile = {
  ...emptyInvoiceIdentityForm,
  billingVatNumber: null,
  billingPaymentNote: null,
  billingFooterNote: null,
};

function Field({
  label,
  value,
  onChange,
  ltr,
  multiline,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  ltr?: boolean;
  multiline?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
        {label}
      </span>
      {multiline ? (
        <textarea
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          rows={3}
          dir={ltr ? "ltr" : undefined}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            fontSize: 13,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
      ) : (
        <input
          type="text"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          dir={ltr ? "ltr" : undefined}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            fontSize: 13,
            fontFamily: "inherit",
          }}
        />
      )}
    </label>
  );
}

export default function BusinessProfilePage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [form, setForm] = useState<FullProfile>(emptyFull);
  const [identityComplete, setIdentityComplete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/invoice-profile", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const p = data?.profile ?? {};
      setForm({
        billingLegalName: p.billingLegalName ?? null,
        billingBusinessKind: p.billingBusinessKind ?? null,
        billingTaxId: p.billingTaxId ?? null,
        billingPhone: p.billingPhone ?? null,
        billingEmail: p.billingEmail ?? null,
        billingAddress: p.billingAddress ?? null,
        billingPdfTemplateStyle: parseBillingPdfTemplateStyle(
          typeof p.billingPdfTemplateStyle === "string"
            ? p.billingPdfTemplateStyle
            : undefined
        ),
        billingVatNumber: p.billingVatNumber ?? null,
        billingPaymentNote: p.billingPaymentNote ?? null,
        billingFooterNote: p.billingFooterNote ?? null,
      });
      setIdentityComplete(!!data?.identityComplete);
    } catch {
      setError("לא ניתן לטעון את הפרופיל");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/invoice-profile", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        let msg = "שמירה נכשלה";
        try {
          const j = await res.json();
          if (j?.error) msg = j.error;
        } catch {}
        setError(msg);
        return;
      }
      const data = await res.json();
      setIdentityComplete(!!data?.identityComplete);
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2500);
    } catch {
      setError("שגיאת רשת");
    } finally {
      setSaving(false);
    }
  }

  const identitySlice: InvoiceProfileFormState = {
    billingLegalName: form.billingLegalName,
    billingBusinessKind: form.billingBusinessKind,
    billingTaxId: form.billingTaxId,
    billingPhone: form.billingPhone,
    billingEmail: form.billingEmail,
    billingAddress: form.billingAddress,
    billingPdfTemplateStyle: form.billingPdfTemplateStyle,
  };

  return (
    <div dir="rtl" style={{ minHeight: "100dvh", background: "#f8fafc" }}>
      <PageHeader
        title="העסק שלי"
        backHref="/tools"
        backLabel="חזרה"
        showBack
      />
      <main
        style={{
          maxWidth: 560,
          margin: "0 auto",
          padding: "16px 16px 80px",
          boxSizing: "border-box",
        }}
      >
        <p style={{ fontSize: 14, color: "#64748b", marginTop: 0 }}>
          כאן מגדירים את <strong>זהות העסק</strong> שמופיעה במסמכים (חשבוניות,
          הצעות מחיר וכו׳). עריכה כאן לא דרך מסמך בודד.
        </p>

        <div
          style={{
            marginTop: 12,
            padding: "12px 14px",
            borderRadius: 12,
            background: "#fffbeb",
            border: "1px solid #fde68a",
            fontSize: 13,
            color: "#92400e",
            lineHeight: 1.5,
          }}
        >
          <strong>לוגו העסק:</strong> מוגדר מדף הבית — תמונה עגולה בראש המסך,
          לחיצה להעלאה. הלוגו יופיע במסמכים לאחר ההגדרה.
        </div>

        {loading ? (
          <div style={{ marginTop: 24, color: "#94a3b8" }}>טוען…</div>
        ) : (
          <div style={{ display: "grid", gap: 20, marginTop: 20 }}>
            <section
              style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: 15,
                  fontWeight: 800,
                  color: "#0f172a",
                }}
              >
                זהות עסקית
              </h2>
              {!identityComplete ? (
                <p
                  style={{
                    margin: "0 0 12px",
                    fontSize: 13,
                    color: "#b45309",
                    fontWeight: 600,
                  }}
                >
                  חסרים פרטים להפקת חשבונית מס — השלימו את השדות למטה.
                </p>
              ) : null}
              <BusinessIdentitySetupForm
                form={identitySlice}
                onChange={(next) =>
                  setForm((prev) => ({
                    ...prev,
                    ...next,
                  }))
                }
              />
            </section>

            <section
              style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: 15,
                  fontWeight: 800,
                  color: "#0f172a",
                }}
              >
                פרטים נוספים במסמך (אופציונלי)
              </h2>
              <div style={{ display: "grid", gap: 12 }}>
                <Field
                  label='מספר עוסק מורשה (אם רלוונטי)'
                  value={form.billingVatNumber}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, billingVatNumber: v }))
                  }
                  ltr
                />
                <Field
                  label="פרטי תשלום (בנק / Bit / הוראות)"
                  value={form.billingPaymentNote}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, billingPaymentNote: v }))
                  }
                  multiline
                />
                <Field
                  label="שורת פוטר (אופציונלי)"
                  value={form.billingFooterNote}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, billingFooterNote: v }))
                  }
                  multiline
                />
              </div>
            </section>

            {error ? (
              <div
                role="alert"
                style={{
                  background: "#fef2f2",
                  color: "#991b1b",
                  padding: "10px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            ) : null}

            <div style={{ display: "grid", gap: 10 }}>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                style={{
                  padding: "12px 18px",
                  borderRadius: 10,
                  border: "none",
                  background: saving
                    ? "#94a3b8"
                    : savedOk
                      ? "#166534"
                      : TOKEN.action.primary.background,
                  color: "#fff",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: saving ? "not-allowed" : "pointer",
                  transition: "background 0.2s ease",
                }}
              >
                {saving ? "שומר…" : savedOk ? "נשמר ✓" : "שמור שינויים"}
              </button>
              {savedOk ? (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    background: "#ecfdf5",
                    border: "1px solid #bbf7d0",
                    color: "#166534",
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 14,
                    fontWeight: 600,
                    textAlign: "center",
                  }}
                >
                  השינויים נשמרו בהצלחה
                </div>
              ) : null}
            </div>

            <Link
              href="/billing"
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "#2563eb",
                textDecoration: "none",
              }}
            >
              ← חזרה לחשבוניות
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
