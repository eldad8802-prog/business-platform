"use client";

/**
 * Signup step 2 (business details) and step 3 (review), shared by the password form and the Google completion
 * form. The fields follow the chosen business kind; validation is lib/auth/signup-legal-identity.ts — the same
 * rules the server applies — so an error shows under its field before anything is sent.
 *
 * The number check is a local FORMAT check. Nothing here says, or implies, that the number was verified.
 */

import { useI18n } from "@/components/i18n/I18nProvider";
import {
  legalIdentityFieldErrors,
  type LegalIdentityField,
  type LegalIdentityKind,
} from "@/lib/auth/signup-legal-identity";
import { SIGNUP_BUSINESS_KINDS } from "@/lib/auth/signup-identity";

import styles from "./register.module.css";

export type LegalIdentityValues = {
  businessKind: string;
  legalName: string;
  taxId: string;
  tradeName: string;
  address: string;
  phone: string;
  businessEmail: string;
};

export type LegalIdentityErrors = Partial<Record<LegalIdentityField | "businessKind", string>>;

export const LEGAL_IDENTITY_FIELDS: readonly (LegalIdentityField | "businessKind")[] = [
  "businessKind", "legalName", "taxId", "tradeName", "address", "phone", "businessEmail",
];

export function emptyLegalIdentity(businessEmail = ""): LegalIdentityValues {
  return { businessKind: "", legalName: "", taxId: "", tradeName: "", address: "", phone: "", businessEmail };
}

const isKind = (k: string): k is LegalIdentityKind => (SIGNUP_BUSINESS_KINDS as readonly string[]).includes(k);

/** Every error of step 2 at once. `kindRequired` is the localized "choose a kind" message. */
export function validateLegalIdentityStep(v: LegalIdentityValues, kindRequired: string): LegalIdentityErrors {
  if (!isKind(v.businessKind)) return { businessKind: kindRequired };
  return legalIdentityFieldErrors(v.businessKind, {
    legalName: v.legalName,
    taxId: v.taxId,
    tradeName: v.tradeName,
    address: v.address,
    phone: v.phone,
    businessEmail: v.businessEmail,
  });
}

/** The JSON the signup routes expect, from the form values (the server normalizes again). */
export function legalIdentityBody(v: LegalIdentityValues) {
  return {
    businessKind: v.businessKind,
    legalName: v.legalName.trim(),
    taxId: v.taxId.trim(),
    tradeName: v.tradeName.trim() === "" ? null : v.tradeName.trim(),
    address: v.address.trim(),
    phone: v.phone.trim(),
    businessEmail: v.businessEmail.trim(),
  };
}

function useLabels(kind: string) {
  const { t } = useI18n();
  const company = kind === "LTD_COMPANY";
  return {
    t,
    legalName: t(company ? "account.auth.register.legal.legalNameCompany" : "account.auth.register.legal.legalNameDealer"),
    taxId: t(company ? "account.auth.register.legal.taxIdCompany" : "account.auth.register.legal.taxIdDealer"),
    address: t(company ? "account.auth.register.legal.addressCompany" : "account.auth.register.legal.addressDealer"),
  };
}

export function LegalIdentityFields({
  idPrefix,
  values,
  onChange,
  errors,
  touched,
  onBlurField,
}: {
  idPrefix: string;
  values: LegalIdentityValues;
  onChange: (next: LegalIdentityValues) => void;
  errors: LegalIdentityErrors;
  touched: Record<string, boolean>;
  onBlurField: (field: LegalIdentityField | "businessKind") => void;
}) {
  const L = useLabels(values.businessKind);
  const { t } = L;
  const err = (f: LegalIdentityField | "businessKind") => (touched[f] ? errors[f] : undefined);
  const set = (f: keyof LegalIdentityValues) => (e: { target: { value: string } }) => onChange({ ...values, [f]: e.target.value });

  const field = (
    f: LegalIdentityField,
    label: string,
    opts: { hint?: string; ltr?: boolean; type?: string; inputMode?: "numeric" | "tel" | "email"; autoComplete?: string } = {}
  ) => {
    const id = `${idPrefix}-${f}`;
    const e = err(f);
    const describedBy = [opts.hint ? `${id}-hint` : null, e ? `${id}-msg` : null].filter(Boolean).join(" ") || undefined;
    return (
      <div className={styles.field} key={f}>
        <label className={styles.label} htmlFor={id}>{label}</label>
        <input
          id={id}
          name={f}
          type={opts.type ?? "text"}
          dir={opts.ltr ? "ltr" : undefined}
          inputMode={opts.inputMode}
          autoComplete={opts.autoComplete ?? "off"}
          className={`${styles.input} ${opts.ltr ? styles.ltr : ""} ${e ? styles.invalid : ""}`}
          value={values[f]}
          onChange={set(f)}
          onBlur={() => onBlurField(f)}
          aria-invalid={!!e}
          aria-describedby={describedBy}
          data-testid={`signup-${f}`}
        />
        {opts.hint ? <p id={`${id}-hint`} className={styles.hint}>{opts.hint}</p> : null}
        {e ? <p id={`${id}-msg`} role="alert" className={styles.error}>{e}</p> : null}
      </div>
    );
  };

  const kindErr = err("businessKind");
  return (
    <div className={styles.grid}>
      <div className={`${styles.field} ${styles.gridWide}`}>
        <label className={styles.label} htmlFor={`${idPrefix}-kind`}>{t("account.auth.register.businessKind.label")}</label>
        <select
          id={`${idPrefix}-kind`}
          name="businessKind"
          className={`${styles.input} ${kindErr ? styles.invalid : ""}`}
          value={values.businessKind}
          onChange={set("businessKind")}
          onBlur={() => onBlurField("businessKind")}
          aria-invalid={!!kindErr}
          aria-describedby={kindErr ? `${idPrefix}-kind-msg` : `${idPrefix}-kind-hint`}
          data-testid="signup-business-kind"
        >
          <option value="" disabled>{t("account.auth.register.businessKind.placeholder")}</option>
          <option value="EXEMPT_DEALER">{t("account.auth.register.businessKind.EXEMPT_DEALER")}</option>
          <option value="AUTHORIZED_DEALER">{t("account.auth.register.businessKind.AUTHORIZED_DEALER")}</option>
          <option value="LTD_COMPANY">{t("account.auth.register.businessKind.LTD_COMPANY")}</option>
        </select>
        {kindErr ? (
          <p id={`${idPrefix}-kind-msg`} role="alert" className={styles.error}>{kindErr}</p>
        ) : (
          <p id={`${idPrefix}-kind-hint`} className={styles.hint}>{t("account.auth.register.legal.kindHint")}</p>
        )}
      </div>

      {isKind(values.businessKind) ? (
        <>
          {field("legalName", L.legalName, { autoComplete: values.businessKind === "LTD_COMPANY" ? "organization" : "name" })}
          {field("taxId", L.taxId, { ltr: true, inputMode: "numeric", hint: t("account.auth.register.legal.taxIdHint") })}
          {field("tradeName", t("account.auth.register.legal.tradeName"), { hint: t("account.auth.register.legal.tradeNameHint"), autoComplete: "organization" })}
          {field("address", L.address, { autoComplete: "street-address" })}
          {field("phone", t("account.auth.register.legal.phone"), { ltr: true, type: "tel", inputMode: "tel", autoComplete: "tel" })}
          {field("businessEmail", t("account.auth.register.legal.businessEmail"), {
            ltr: true, type: "email", inputMode: "email", autoComplete: "email",
            hint: t("account.auth.register.legal.businessEmailHint"),
          })}
        </>
      ) : null}
    </div>
  );
}

export function LegalIdentityReview({
  values,
  account,
  onEdit,
}: {
  values: LegalIdentityValues;
  /** Step-1 rows (name, sign-in address), shown first. */
  account: { label: string; value: string }[];
  onEdit: () => void;
}) {
  const L = useLabels(values.businessKind);
  const { t } = L;
  const kindLabel = isKind(values.businessKind) ? t(`account.auth.register.businessKind.${values.businessKind}`) : "";
  const rows: { label: string; value: string; ltr?: boolean }[] = [
    ...account,
    { label: t("account.auth.register.businessKind.label"), value: kindLabel },
    { label: L.legalName, value: values.legalName.trim() },
    { label: L.taxId, value: values.taxId.trim(), ltr: true },
    { label: t("account.auth.register.legal.tradeName"), value: values.tradeName.trim() || t("account.auth.register.legal.none") },
    { label: L.address, value: values.address.trim() },
    { label: t("account.auth.register.legal.phone"), value: values.phone.trim(), ltr: true },
    { label: t("account.auth.register.legal.businessEmail"), value: values.businessEmail.trim(), ltr: true },
  ];
  return (
    <>
      <div className={styles.reviewHead}>
        <h2 className={styles.reviewTitle}>{t("account.auth.register.legal.reviewTitle")}</h2>
        <button type="button" className={styles.link} onClick={onEdit}>{t("account.auth.register.legal.edit")}</button>
      </div>
      <dl className={styles.review} data-testid="signup-review">
        {rows.map((r) => (
          <div className={styles.reviewRow} key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.ltr ? <span dir="ltr">{r.value}</span> : r.value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.lockNotice} data-testid="signup-lock-notice">{t("account.auth.register.legal.lockNotice")}</p>
    </>
  );
}
