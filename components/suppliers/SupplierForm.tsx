"use client";

/**
 * Supplier create/edit form — one component, both flows.
 *
 * UX CONTRACT (why it is built this way):
 *  - The head of the form is name + phone + email. A supplier can be opened in
 *    seconds with a name and nothing else; nothing below is ever required.
 *  - Every optional area is a collapsed <details> section, so the fields exist
 *    without turning supplier creation into a bookkeeping form. A section that
 *    already holds data opens itself, so an edit never hides a stored value
 *    behind a twisty the owner did not know to open.
 *  - The identifier gets ONE field whose LABEL follows the entity type
 *    (חברה → ח.פ., עוסק → מספר עוסק). The owner is never shown two competing
 *    identifier fields for what is, in reality, one number.
 *
 * Built entirely on the existing `crm-*` classes — no new design primitives and
 * no new stylesheet, so it inherits the supplier card's RTL and theming as-is.
 */

import { useState, type ReactNode } from "react";
import {
  SUPPLIER_PAYMENT_METHOD_LABELS,
  SUPPLIER_PAYMENT_METHOD_VALUES,
  SUPPLIER_PAYMENT_TERMS_PRESETS,
  SUPPLIER_TAX_ID_TYPE_LABELS,
  SUPPLIER_TAX_ID_TYPE_VALUES,
  supplierTaxIdLabel,
  type SupplierTaxIdType,
} from "@/lib/services/inventory/supplier-profile";
import type { SupplierFormState } from "@/components/suppliers/supplier-form-model";

type Setter = <K extends keyof SupplierFormState>(
  key: K,
  value: SupplierFormState[K]
) => void;

function Field({
  id,
  label,
  children,
  help,
}: {
  id: string;
  label: string;
  children: ReactNode;
  help?: string;
}) {
  return (
    <div className="crm-field">
      <label className="crm-field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help ? (
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{help}</div>
      ) : null}
    </div>
  );
}

function Text({
  id,
  value,
  onChange,
  inputMode,
  autoFocus,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  inputMode?: "tel" | "email" | "numeric" | "url" | "text";
  autoFocus?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      id={id}
      className="crm-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode={inputMode}
      autoFocus={autoFocus}
      placeholder={placeholder}
    />
  );
}

function Section({
  title,
  summary,
  defaultOpen,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      style={{
        borderTop: "1px solid var(--crm-line)",
        paddingTop: 12,
        marginTop: 12,
      }}
    >
      <summary style={{ cursor: "pointer", fontWeight: 600, marginBottom: 8 }}>
        {title}
        {summary ? (
          <span style={{ fontWeight: 400, opacity: 0.65 }}> · {summary}</span>
        ) : null}
      </summary>
      {children}
    </details>
  );
}

export function SupplierForm({
  form,
  set,
  idPrefix,
  showActiveToggle,
}: {
  form: SupplierFormState;
  set: Setter;
  idPrefix: string;
  showActiveToggle?: boolean;
}) {
  const p = (k: string) => idPrefix + "-" + k;
  const taxIdType = (form.taxIdType || null) as SupplierTaxIdType | null;

  // The presets are a shortcut onto the stored number of days, never a separate
  // vocabulary: "custom" is simply any other integer typed into the same field.
  const [termsMode, setTermsMode] = useState<"preset" | "custom">(() => {
    const v = form.paymentTermsDays.trim();
    if (!v) return "preset";
    return SUPPLIER_PAYMENT_TERMS_PRESETS.some((x) => String(x.days) === v)
      ? "preset"
      : "custom";
  });

  const hasBusiness = Boolean(form.taxId || form.legalName || form.category || form.website);
  const hasContact = Boolean(
    form.contactName || form.contactRole || form.contactPhone || form.contactEmail
  );
  const hasAddress = Boolean(
    form.addressStreet || form.addressCity || form.addressPostalCode
  );
  const hasTerms = Boolean(form.paymentTermsDays || form.preferredPaymentMethod);
  const hasPurchasing = Boolean(form.defaultLeadTimeDays);
  const hasNotes = Boolean(form.notes);

  return (
    <>
      <Field id={p("name")} label="שם הספק *">
        <Text
          id={p("name")}
          value={form.name}
          onChange={(v) => set("name", v)}
          autoFocus
        />
      </Field>

      <Field id={p("phone")} label="טלפון">
        <Text
          id={p("phone")}
          value={form.phone}
          onChange={(v) => set("phone", v)}
          inputMode="tel"
        />
      </Field>

      <Field id={p("email")} label="אימייל">
        <Text
          id={p("email")}
          value={form.email}
          onChange={(v) => set("email", v)}
          inputMode="email"
        />
      </Field>

      <Section
        title="פרטי העסק"
        summary="מזהה עסקי, סוג ישות, קטגוריה"
        defaultOpen={hasBusiness}
      >
        <Field id={p("taxIdType")} label="סוג ישות">
          <select
            id={p("taxIdType")}
            className="crm-input"
            value={form.taxIdType}
            onChange={(e) => set("taxIdType", e.target.value)}
          >
            <option value="">לא צוין</option>
            {SUPPLIER_TAX_ID_TYPE_VALUES.map((v) => (
              <option key={v} value={v}>
                {SUPPLIER_TAX_ID_TYPE_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={p("taxId")}
          label={supplierTaxIdLabel(taxIdType)}
          help="8 או 9 ספרות. משמש גם כדי לזהות ספק שכבר קיים."
        >
          <Text
            id={p("taxId")}
            value={form.taxId}
            onChange={(v) => set("taxId", v)}
            inputMode="numeric"
          />
        </Field>

        <Field id={p("legalName")} label="שם רשום / מסחרי (אם שונה)">
          <Text
            id={p("legalName")}
            value={form.legalName}
            onChange={(v) => set("legalName", v)}
          />
        </Field>

        <Field id={p("category")} label="קטגוריית ספק">
          <Text
            id={p("category")}
            value={form.category}
            onChange={(v) => set("category", v)}
            placeholder="למשל: מזון, אריזות, שירותים"
          />
        </Field>

        <Field id={p("website")} label="אתר אינטרנט">
          <Text
            id={p("website")}
            value={form.website}
            onChange={(v) => set("website", v)}
            inputMode="url"
          />
        </Field>
      </Section>

      <Section title="איש קשר" defaultOpen={hasContact}>
        <Field id={p("contactName")} label="שם איש קשר">
          <Text
            id={p("contactName")}
            value={form.contactName}
            onChange={(v) => set("contactName", v)}
          />
        </Field>
        <Field id={p("contactRole")} label="תפקיד">
          <Text
            id={p("contactRole")}
            value={form.contactRole}
            onChange={(v) => set("contactRole", v)}
          />
        </Field>
        <Field id={p("contactPhone")} label="טלפון ישיר">
          <Text
            id={p("contactPhone")}
            value={form.contactPhone}
            onChange={(v) => set("contactPhone", v)}
            inputMode="tel"
          />
        </Field>
        <Field id={p("contactEmail")} label="אימייל איש קשר">
          <Text
            id={p("contactEmail")}
            value={form.contactEmail}
            onChange={(v) => set("contactEmail", v)}
            inputMode="email"
          />
        </Field>
      </Section>

      <Section title="כתובת" defaultOpen={hasAddress}>
        <Field id={p("addressStreet")} label="רחוב ומספר">
          <Text
            id={p("addressStreet")}
            value={form.addressStreet}
            onChange={(v) => set("addressStreet", v)}
          />
        </Field>
        <Field id={p("addressCity")} label="עיר">
          <Text
            id={p("addressCity")}
            value={form.addressCity}
            onChange={(v) => set("addressCity", v)}
          />
        </Field>
        <Field id={p("addressPostalCode")} label="מיקוד">
          <Text
            id={p("addressPostalCode")}
            value={form.addressPostalCode}
            onChange={(v) => set("addressPostalCode", v)}
            inputMode="numeric"
          />
        </Field>
      </Section>

      <Section
        title="תנאי התקשרות"
        summary="תנאי תשלום וצורת תשלום"
        defaultOpen={hasTerms}
      >
        <Field
          id={p("paymentTerms")}
          label="תנאי תשלום"
          help="נשמר כמספר ימים, כדי שבהמשך אפשר יהיה לדעת מתי תשלום צפוי."
        >
          {termsMode === "preset" ? (
            <select
              id={p("paymentTerms")}
              className="crm-input"
              value={form.paymentTermsDays}
              onChange={(e) => {
                if (e.target.value === "__custom") {
                  setTermsMode("custom");
                  set("paymentTermsDays", "");
                  return;
                }
                set("paymentTermsDays", e.target.value);
              }}
            >
              <option value="">לא צוין</option>
              {SUPPLIER_PAYMENT_TERMS_PRESETS.map((preset) => (
                <option key={preset.days} value={String(preset.days)}>
                  {preset.label}
                </option>
              ))}
              <option value="__custom">מספר ימים אחר…</option>
            </select>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                id={p("paymentTerms")}
                className="crm-input"
                value={form.paymentTermsDays}
                onChange={(e) => set("paymentTermsDays", e.target.value)}
                inputMode="numeric"
                placeholder="ימים"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="crm-btn crm-btn--ghost"
                onClick={() => {
                  setTermsMode("preset");
                  set("paymentTermsDays", "");
                }}
              >
                בחירה מרשימה
              </button>
            </div>
          )}
        </Field>

        <Field id={p("payMethod")} label="צורת תשלום מועדפת">
          <select
            id={p("payMethod")}
            className="crm-input"
            value={form.preferredPaymentMethod}
            onChange={(e) => set("preferredPaymentMethod", e.target.value)}
          >
            <option value="">לא צוין</option>
            {SUPPLIER_PAYMENT_METHOD_VALUES.map((v) => (
              <option key={v} value={v}>
                {SUPPLIER_PAYMENT_METHOD_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="הגדרות רכש" defaultOpen={hasPurchasing}>
        <Field id={p("lead")} label="זמן אספקה ברירת מחדל (ימים)">
          <Text
            id={p("lead")}
            value={form.defaultLeadTimeDays}
            onChange={(v) => set("defaultLeadTimeDays", v)}
            inputMode="numeric"
          />
        </Field>
      </Section>

      <Section title="הערות" defaultOpen={hasNotes}>
        <Field id={p("notes")} label="הערה פנימית">
          <textarea
            id={p("notes")}
            className="crm-note-input"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
          />
        </Field>
      </Section>

      {showActiveToggle ? (
        <div className="crm-field" style={{ marginTop: 12 }}>
          <label
            className="crm-field__label"
            htmlFor={p("active")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
            }}
          >
            <input
              id={p("active")}
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => set("isActive", e.target.checked)}
            />
            ספק פעיל
          </label>
        </div>
      ) : null}
    </>
  );
}
