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
import { primaryActionStyle, TOKEN } from "@/lib/design/billing-theme";

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
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
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
      setError("לא הצלחנו להתחבר כדי לשמור. נסו שוב בעוד רגע.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div
        style={{
          borderRadius: 14,
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.card,
          padding: "14px 16px",
          fontSize: 13,
          color: TOKEN.ink.meta,
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
          border: `1px solid ${TOKEN.border.DEFAULT}`,
          background: TOKEN.surface.card,
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
            background: hasLogo ? TOKEN.surface.inset : TOKEN.ink.primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `1px solid ${TOKEN.border.DEFAULT}`,
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
                fontWeight: 600,
                color: TOKEN.ink.inverse,
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
              fontWeight: 600,
              fontSize: 14,
              color: TOKEN.ink.primary,
              marginBottom: 2,
            }}
          >
            {mini.billingLegalName || "שם העסק"}
          </div>
          <div
            style={{
              fontSize: 12,
              color: TOKEN.ink.muted,
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
              <span style={{ color: TOKEN.semantic.attention.ink, fontWeight: 600 }}>
                חסר מזהה מס
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: TOKEN.ink.meta, marginTop: 4 }}>
            פרטי העסק נשמרים כדי שהמסמכים ללקוחות ייראו אמינים ועקביים.
          </div>
        </div>
        <Link
          href="/business"
          style={{
            padding: "7px 14px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
            background: TOKEN.surface.card,
            fontSize: 13,
            fontWeight: 600,
            color: TOKEN.ink.primary,
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
        border: `1px solid ${TOKEN.semantic.info.border}`,
        background: `linear-gradient(135deg, ${TOKEN.semantic.info.bg} 0%, ${TOKEN.surface.card} 55%)`,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          borderBottom: `1px solid ${TOKEN.semantic.info.border}`,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: TOKEN.semantic.info.ink }}>
          כדי להתחיל צריך רק את פרטי העסק שיופיעו במסמך
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 13, color: TOKEN.semantic.info.ink }}>
          מלאו את הפרטים הבסיסיים עכשיו. מראה המסמך והעדפות נוספות אפשר לדייק
          בהמשך דרך{" "}
          <Link href="/business" style={{ fontWeight: 600, color: TOKEN.semantic.info.ink }}>
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
              background: TOKEN.semantic.urgent.bg,
              color: TOKEN.semantic.urgent.ink,
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
              ...primaryActionStyle({ disabled: saving, height: 40 }),
              padding: "9px 20px",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {saving ? "שומר…" : "שמור והמשך למסמכים"}
          </button>
        </div>
        {savedOk ? (
          <div style={{ fontSize: 13, color: TOKEN.semantic.success.ink, fontWeight: 600 }}>
            נשמר. אפשר להמשיך ליצירת מסמכים.
          </div>
        ) : null}
      </div>
    </section>
  );
}
