"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/components/i18n/I18nProvider";
import PageHeader from "@/components/ui/page-header";
import { TOKEN } from "@/lib/design/tokens";
import { parseBillingPdfTemplateStyle } from "@/lib/billing/billing-pdf-template-style";
import {
  BusinessIdentitySetupForm,
  emptyInvoiceIdentityForm,
  type InvoiceProfileFormState,
} from "@/components/billing/BusinessIdentitySetupForm";
import { BillingSignatureField } from "@/components/billing/BillingSignatureField";
import { BusinessNameEditor } from "@/components/business/BusinessNameEditor";
import desk from "./business-desk.module.css";

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
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--dz-text-secondary)" }}>
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
            border: "1px solid var(--dz-border-strong)",
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
            border: "1px solid var(--dz-border-strong)",
            fontSize: 13,
            fontFamily: "inherit",
          }}
        />
      )}
    </label>
  );
}

export default function BusinessProfilePage() {
  const { t } = useI18n();
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
      setError(t("content.identity.profile.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
        let msg = t("content.identity.profile.saveFailed");
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
      setError(t("content.identity.profile.networkError"));
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
    <div style={{ minHeight: "100dvh", background: "var(--dz-surface-muted)" }}>
      <PageHeader
        title={t("content.identity.profile.title")}
        showBack
      />
      <main className={desk.main}>
        <p className={desk.lead} style={{ fontSize: 14, color: "var(--dz-text-muted)", marginTop: 0 }}>
          {t("content.identity.profile.leadBefore")}
          <strong>{t("content.identity.profile.leadStrong")}</strong>
          {t("content.identity.profile.leadAfter")}
        </p>

        <div
          style={{
            marginTop: 12,
            padding: "12px 14px",
            borderRadius: 12,
            background: "var(--dz-warning-bg-soft)",
            border: "1px solid var(--dz-warning-border)",
            fontSize: 13,
            color: "var(--dz-warning)",
            lineHeight: 1.5,
          }}
        >
          <strong>{t("content.identity.profile.logoStrong")}</strong>
          {t("content.identity.profile.logoBefore")}{" "}
          <Link href="/profile" style={{ color: "inherit", fontWeight: 700 }}>
            {t("content.identity.profile.logoLink")}
          </Link>{" "}
          {t("content.identity.profile.logoAfter")}
        </div>

        {loading ? (
          <div style={{ marginTop: 24, color: "var(--dz-text-muted)" }}>{t("content.identity.profile.loading")}</div>
        ) : (
          <div className={desk.stack}>
            <BusinessNameEditor />
            <section
              style={{
                background: "var(--dz-surface)",
                border: "1px solid var(--dz-border)",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: 15,
                  fontWeight: 800,
                  color: "var(--dz-text-primary)",
                }}
              >
                {t("content.identity.profile.identityTitle")}
              </h2>
              {!identityComplete ? (
                <p
                  style={{
                    margin: "0 0 12px",
                    fontSize: 13,
                    color: "var(--dz-warning)",
                    fontWeight: 600,
                  }}
                >
                  {t("content.identity.profile.identityIncomplete")}
                </p>
              ) : null}
              <div className={desk.identity}>
                <BusinessIdentitySetupForm
                  form={identitySlice}
                  onChange={(next) =>
                    setForm((prev) => ({
                      ...prev,
                      ...next,
                    }))
                  }
                />
              </div>
              <div style={{ marginTop: 16 }}>
                <BillingSignatureField />
              </div>
            </section>

            <div className={desk.side}>
            <section
              style={{
                background: "var(--dz-surface)",
                border: "1px solid var(--dz-border)",
                borderRadius: 14,
                padding: 16,
              }}
            >
              <h2
                style={{
                  margin: "0 0 12px",
                  fontSize: 15,
                  fontWeight: 800,
                  color: "var(--dz-text-primary)",
                }}
              >
                {t("content.identity.profile.extraTitle")}
              </h2>
              <div style={{ display: "grid", gap: 12 }}>
                <Field
                  label={t("content.identity.profile.vatNumber")}
                  value={form.billingVatNumber}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, billingVatNumber: v }))
                  }
                  ltr
                />
                <Field
                  label={t("content.identity.profile.paymentNote")}
                  value={form.billingPaymentNote}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, billingPaymentNote: v }))
                  }
                  multiline
                />
                <Field
                  label={t("content.identity.profile.footerNote")}
                  value={form.billingFooterNote}
                  onChange={(v) =>
                    setForm((p) => ({ ...p, billingFooterNote: v }))
                  }
                  multiline
                />
              </div>
            </section>

            {/* Desktop only: the other places the owner shapes this business,
                each at its canonical screen. Nothing is edited from here. */}
            <nav className={`${desk.manage} ${desk.desktopOnly}`} aria-label={t("content.identity.profile.manageAria")}>
              <h2>{t("content.identity.profile.manageTitle")}</h2>
              <p>{t("content.identity.profile.manageSub")}</p>
              <Link href="/business/identity">{t("content.identity.profile.manageIdentity")} <span>{t("content.identity.profile.manageIdentityHint")}</span></Link>
              <Link href="/business/bot">{t("content.identity.profile.manageBot")} <span>{t("content.identity.profile.manageBotHint")}</span></Link>
              <Link href="/revenue">{t("content.identity.profile.manageCoupons")} <span>{t("content.identity.profile.manageCouponsHint")}</span></Link>
              <Link href="/settings/connections">{t("content.identity.profile.manageConnections")} <span>{t("content.identity.profile.manageConnectionsHint")}</span></Link>
            </nav>
            </div>

            {error ? (
              <div
                className={desk.span}
                role="alert"
                style={{
                  background: "var(--dz-danger-bg-soft)",
                  color: "var(--dz-danger)",
                  padding: "10px 12px",
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            ) : null}

            <div className={desk.span} style={{ display: "grid", gap: 10, maxWidth: 420 }}>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                style={{
                  padding: "12px 18px",
                  borderRadius: 10,
                  border: "none",
                  background: saving
                    ? "var(--dz-text-muted)"
                    : savedOk
                      ? "var(--dz-success-accent)"
                      : TOKEN.action.primary.background,
                  color: "var(--dz-text-on-brand)",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor: saving ? "not-allowed" : "pointer",
                  transition: "background 0.2s ease",
                }}
              >
                {saving ? t("content.identity.profile.saving") : savedOk ? t("content.identity.profile.saved") : t("content.identity.profile.save")}
              </button>
              {savedOk ? (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    background: "var(--dz-success-bg-soft)",
                    border: "1px solid var(--dz-success-border)",
                    color: "var(--dz-success)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    fontSize: 14,
                    fontWeight: 600,
                    textAlign: "center",
                  }}
                >
                  {t("content.identity.profile.savedOk")}
                </div>
              ) : null}
            </div>

            <Link
              className={desk.span}
              href="/billing"
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--dz-info)",
                textDecoration: "none",
              }}
            >
              {t("content.identity.profile.toBilling")}
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
