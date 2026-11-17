"use client";

import {
  BILLING_BUSINESS_KIND_VALUES,
  type BillingBusinessKind,
} from "@/lib/billing/business-identity";
import { useI18n } from "@/components/i18n/I18nProvider";
import {
  DEFAULT_BILLING_PDF_TEMPLATE_STYLE,
  type BillingPdfTemplateStyle,
} from "@/lib/billing/billing-pdf-template-style";
import { BillingDocumentStylePicker } from "@/components/billing/BillingDocumentStylePicker";
import { TOKEN } from "@/lib/design/billing-theme";

export type InvoiceProfileFormState = {
  billingLegalName: string | null;
  billingBusinessKind: string | null;
  billingTaxId: string | null;
  billingPhone: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  billingPdfTemplateStyle: BillingPdfTemplateStyle;
};

export const emptyInvoiceIdentityForm: InvoiceProfileFormState = {
  billingLegalName: null,
  billingBusinessKind: null,
  billingTaxId: null,
  billingPhone: null,
  billingEmail: null,
  billingAddress: null,
  billingPdfTemplateStyle: DEFAULT_BILLING_PDF_TEMPLATE_STYLE,
};

function Field({
  label,
  value,
  onChange,
  ltr,
  multiline,
  hint,
  readOnly,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  ltr?: boolean;
  multiline?: boolean;
  hint?: string;
  /** A confirmed legal-identity field: shown, not editable (the server refuses a change anyway). */
  readOnly?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.secondary }}>
        {label}
      </span>
      {multiline ? (
        <textarea
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          rows={2}
          dir={ltr ? "ltr" : undefined}
          style={{
            padding: "7px 10px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
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
          readOnly={readOnly}
          aria-readonly={readOnly || undefined}
          style={{
            padding: "7px 10px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
            fontSize: 13,
            fontFamily: "inherit",
            ...(readOnly ? { background: TOKEN.surface.inset, color: TOKEN.ink.secondary } : {}),
          }}
        />
      )}
      {hint ? (
        <span style={{ fontSize: 11, color: TOKEN.ink.meta }}>{hint}</span>
      ) : null}
    </label>
  );
}

export function BusinessIdentitySetupForm({
  form,
  onChange,
  legalIdentityLocked = false,
}: {
  form: InvoiceProfileFormState;
  onChange: (next: InvoiceProfileFormState) => void;
  /** From GET /api/billing/invoice-profile: kind, legal name and tax id are confirmed and read-only. */
  legalIdentityLocked?: boolean;
}) {
  function patch<K extends keyof InvoiceProfileFormState>(
    key: K,
    v: InvoiceProfileFormState[K]
  ) {
    onChange({ ...form, [key]: v });
  }
  const { t } = useI18n();

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
      }}
    >
      {legalIdentityLocked ? (
        <p
          data-testid="legal-identity-locked-note"
          style={{ gridColumn: "1 / -1", margin: 0, fontSize: 12, color: TOKEN.ink.meta }}
        >
          {t("billing.identity.lockedNote")}
        </p>
      ) : null}
      <div style={{ gridColumn: "1 / -1" }}>
        <Field
          label={t("billing.identity.legalNameLabel")}
          value={form.billingLegalName}
          onChange={(v) => patch("billingLegalName", v)}
          readOnly={legalIdentityLocked}
        />
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.secondary }}>
          {t("billing.identity.kindLabel")}
        </span>
        <select
          disabled={legalIdentityLocked}
          value={form.billingBusinessKind ?? ""}
          onChange={(e) =>
            patch(
              "billingBusinessKind",
              e.target.value ? e.target.value : null
            )
          }
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
            fontSize: 13,
            fontFamily: "inherit",
            background: TOKEN.surface.card,
          }}
        >
          <option value="">{t("billing.identity.choose")}</option>
          {BILLING_BUSINESS_KIND_VALUES.map((k) => (
            <option key={k} value={k}>
              {t(`billing.identity.kind.${k as BillingBusinessKind}`)}
            </option>
          ))}
        </select>
      </label>

      <Field
        label={t("billing.identity.taxIdLabel")}
        value={form.billingTaxId}
        onChange={(v) => patch("billingTaxId", v)}
        ltr
        readOnly={legalIdentityLocked}
      />

      <div style={{ gridColumn: "1 / -1" }}>
        <Field
          label={t("billing.identity.addressLabel")}
          value={form.billingAddress}
          onChange={(v) => patch("billingAddress", v)}
          multiline
        />
      </div>

      <Field
        label={t("billing.identity.phoneLabel")}
        value={form.billingPhone}
        onChange={(v) => patch("billingPhone", v)}
        ltr
      />
      <Field
        label={t("billing.identity.emailLabel")}
        value={form.billingEmail}
        onChange={(v) => patch("billingEmail", v)}
        ltr
      />

      <div style={{ gridColumn: "1 / -1" }}>
        <details
          style={{
            border: `1px solid ${TOKEN.border.DEFAULT}`,
            borderRadius: 10,
            padding: "10px 12px",
            background: TOKEN.surface.inset,
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              color: TOKEN.ink.secondary,
            }}
          >
            {t("billing.identity.appearanceSummary")}
          </summary>
          <div style={{ marginTop: 12 }}>
            <BillingDocumentStylePicker
              value={form.billingPdfTemplateStyle}
              onChange={(billingPdfTemplateStyle) =>
                onChange({ ...form, billingPdfTemplateStyle })
              }
            />
          </div>
        </details>
      </div>
    </div>
  );
}
