"use client";

import {
  BILLING_BUSINESS_KIND_LABELS,
  BILLING_BUSINESS_KIND_VALUES,
  type BillingBusinessKind,
} from "@/lib/billing/business-identity";
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
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  ltr?: boolean;
  multiline?: boolean;
  hint?: string;
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
          style={{
            padding: "7px 10px",
            borderRadius: 8,
            border: `1px solid ${TOKEN.border.hover}`,
            fontSize: 13,
            fontFamily: "inherit",
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
}: {
  form: InvoiceProfileFormState;
  onChange: (next: InvoiceProfileFormState) => void;
}) {
  function patch<K extends keyof InvoiceProfileFormState>(
    key: K,
    v: InvoiceProfileFormState[K]
  ) {
    onChange({ ...form, [key]: v });
  }

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ gridColumn: "1 / -1" }}>
        <Field
          label="שם העסק במסמך"
          value={form.billingLegalName}
          onChange={(v) => patch("billingLegalName", v)}
        />
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: TOKEN.ink.secondary }}>
          סוג עסק
        </span>
        <select
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
          <option value="">בחרו…</option>
          {BILLING_BUSINESS_KIND_VALUES.map((k) => (
            <option key={k} value={k}>
              {BILLING_BUSINESS_KIND_LABELS[k as BillingBusinessKind]}
            </option>
          ))}
        </select>
      </label>

      <Field
        label="ע.מ. / ח.פ."
        value={form.billingTaxId}
        onChange={(v) => patch("billingTaxId", v)}
        ltr
      />

      <div style={{ gridColumn: "1 / -1" }}>
        <Field
          label="כתובת"
          value={form.billingAddress}
          onChange={(v) => patch("billingAddress", v)}
          multiline
        />
      </div>

      <Field
        label="טלפון"
        value={form.billingPhone}
        onChange={(v) => patch("billingPhone", v)}
        ltr
      />
      <Field
        label='דוא"ל'
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
            מראה המסמך (אפשר לדייק בהמשך)
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
