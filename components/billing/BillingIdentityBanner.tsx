"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BusinessIdentitySetupForm,
  emptyInvoiceIdentityForm,
  type InvoiceProfileFormState,
} from "@/components/billing/BusinessIdentitySetupForm";
import {
  BILLING_BUSINESS_KIND_LABELS,
  type BillingBusinessKind,
} from "@/lib/billing/business-identity";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";

function getAuthToken(): string {
  if (typeof window === "undefined") return "1";
  return localStorage.getItem("token") || "1";
}

function getInitials(name: string | null): string {
  if (!name) return "?";
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2);
  return words[0][0] + words[1][0];
}

function isValidLogo(v: string | null): boolean {
  return (
    typeof v === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v)
  );
}

type ProfileRow = InvoiceProfileFormState & {
  billingVatNumber?: string | null;
  billingPaymentNote?: string | null;
  billingFooterNote?: string | null;
  billingLogoDataUrl?: string | null;
  billingPdfTemplateStyle?: string | null;
};

function rowToForm(p: Partial<ProfileRow>): InvoiceProfileFormState {
  return {
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
  };
}

export function BillingIdentityBanner({
  onIdentityResolved,
}: {
  onIdentityResolved?: (complete: boolean) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [identityComplete, setIdentityComplete] = useState(false);
  const [form, setForm] = useState<InvoiceProfileFormState>(
    emptyInvoiceIdentityForm
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [mini, setMini] = useState<{
    billingLegalName: string | null;
    billingTaxId: string | null;
    billingLogoDataUrl: string | null;
    billingBusinessKind: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const token = getAuthToken();
      const res = await fetch("/api/billing/invoice-profile", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const p = data?.profile ?? {};
      const complete = !!data?.identityComplete;
      setForm(rowToForm(p));
      setIdentityComplete(complete);
      setMini({
        billingLegalName: p.billingLegalName ?? null,
        billingTaxId: p.billingTaxId ?? null,
        billingLogoDataUrl: p.billingLogoDataUrl ?? null,
        billingBusinessKind: p.billingBusinessKind ?? null,
      });
      onIdentityResolved?.(complete);
    } catch {
      setIdentityComplete(false);
      onIdentityResolved?.(false);
    } finally {
      setLoading(false);
    }
  }, [onIdentityResolved]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
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
      const complete = !!data?.identityComplete;
      setIdentityComplete(complete);
      const p = data?.profile ?? {};
      setForm(rowToForm(p));
      setMini({
        billingLegalName: p.billingLegalName ?? null,
        billingTaxId: p.billingTaxId ?? null,
        billingLogoDataUrl: p.billingLogoDataUrl ?? null,
        billingBusinessKind: p.billingBusinessKind ?? null,
      });
      onIdentityResolved?.(complete);
      setSavedOk(true);
      window.setTimeout(() => setSavedOk(false), 2200);
    } catch {
      setError("שגיאת רשת");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div
        style={{
          borderRadius: 14,
          border: "1px solid #e2e8f0",
          background: "#fff",
          padding: "14px 16px",
          fontSize: 13,
          color: "#94a3b8",
        }}
      >
        טוען פרטי עסק…
      </div>
    );
  }

  if (identityComplete && mini) {
    const hasLogo = isValidLogo(mini.billingLogoDataUrl);
    const initials = getInitials(mini.billingLegalName);
    const kindLabel =
      mini.billingBusinessKind &&
      BILLING_BUSINESS_KIND_LABELS[
        mini.billingBusinessKind as BillingBusinessKind
      ]
        ? BILLING_BUSINESS_KIND_LABELS[
            mini.billingBusinessKind as BillingBusinessKind
          ]
        : null;

    return (
      <section
        style={{
          borderRadius: 14,
          border: "1px solid #e2e8f0",
          background: "#fff",
          padding: "12px 16px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            overflow: "hidden",
            flexShrink: 0,
            background: hasLogo ? "#f8fafc" : "#0f172a",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid #e2e8f0",
          }}
        >
          {hasLogo ? (
            <img
              src={mini.billingLogoDataUrl!}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#fff",
                letterSpacing: 0.5,
              }}
            >
              {initials}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#0f172a",
              marginBottom: 2,
            }}
          >
            {mini.billingLegalName || "שם העסק"}
          </div>
          <div
            style={{
              fontSize: 12,
              color: "#64748b",
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
            }}
          >
            {kindLabel ? <span>{kindLabel}</span> : null}
            {mini.billingTaxId ? (
              <span style={{ direction: "ltr" }}>ע.מ./ח.פ. {mini.billingTaxId}</span>
            ) : (
              <span style={{ color: "#b45309", fontWeight: 600 }}>
                חסר מזהה מס
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
            זהות המנפיק מנוהלת בהגדרות העסק — לא בעריכת מסמך.
          </div>
        </div>
        <Link
          href="/business"
          style={{
            padding: "7px 14px",
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            background: "#fff",
            fontSize: 13,
            fontWeight: 600,
            color: "#0f172a",
            textDecoration: "none",
            flexShrink: 0,
          }}
        >
          עריכת פרטי עסק
        </Link>
      </section>
    );
  }

  return (
    <section
      style={{
        borderRadius: 14,
        border: "1px solid #bae6fd",
        background: "linear-gradient(135deg, #f0f9ff 0%, #ffffff 55%)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid #e0f2fe",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, color: "#0c4a6e" }}>
          לפני שמתחילים צריך להגדיר את פרטי העסק שיופיעו על המסמכים שלך
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 13, color: "#0369a1" }}>
          לאחר השמירה ניתן יהיה ליצור חשבונית מס וטיוטות — הפרטים ניתנים לעדכון
          בכל עת דרך{" "}
          <Link href="/business" style={{ fontWeight: 700, color: "#0c4a6e" }}>
            העסק שלי
          </Link>
          .
        </p>
      </div>

      <div style={{ padding: 16, display: "grid", gap: 14 }}>
        <BusinessIdentitySetupForm form={form} onChange={setForm} />

        {error ? (
          <div
            role="alert"
            style={{
              background: "#fef2f2",
              color: "#991b1b",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            style={{
              padding: "9px 20px",
              borderRadius: 8,
              border: "none",
              background: saving ? "#94a3b8" : "#0f172a",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "שומר…" : "שמור פרטי עסק"}
          </button>
        </div>
        {savedOk ? (
          <div style={{ fontSize: 13, color: "#166534", fontWeight: 600 }}>
            נשמר. אפשר להמשיך ליצירת מסמכים.
          </div>
        ) : null}
      </div>
    </section>
  );
}
