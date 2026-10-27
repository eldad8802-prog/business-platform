"use client";

import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import {
  getSupplier,
  updateSupplier,
  type Supplier,
} from "@/lib/api/suppliers";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { NotesThread } from "@/components/crm/NotesThread";
import { AttachmentList } from "@/components/crm/AttachmentList";
import { ContactAction } from "@/components/customers/ContactAction";
import { customerInitials, mailHref, telHref } from "@/components/customers/customer-contact";
import {
  BuildingIcon,
  DocumentIcon,
  HandshakeIcon,
  MailIcon,
  NoteIcon,
  PaperclipIcon,
  PencilIcon,
  PhoneIcon,
  PinIcon,
  UserIcon,
} from "@/components/customers/customer-icons";
import { SupplierPurchaseHistorySection } from "@/components/inventory/SupplierPurchaseHistorySection";
import { SupplierForm } from "@/components/suppliers/SupplierForm";
import { SupplierDocumentsSection } from "@/components/suppliers/SupplierDocumentsSection";
import {
  formatSupplierPaymentTermsT,
  supplierCompleteness,
  supplierFormToPayload,
  supplierPaymentMethodLabelT,
  supplierTaxIdLabelT,
  supplierTaxIdTypeLabelT,
  supplierToFormState,
  validateSupplierForm,
  type SupplierFormState,
} from "@/components/suppliers/supplier-form-model";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";

function formatDate(iso: string | null, locale: Locale): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(intlTag(locale), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export default function SupplierCardPage() {
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    const token = getClientAuthToken();
    if (!token) {
      setLoading(false);
      redirectToLogin();
      return;
    }
    if (!Number.isInteger(id) || id <= 0) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      setNotFound(false);
      const data = await getSupplier(id);
      setSupplier(data);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      if (err instanceof Error && err.message === "NOT_FOUND") {
        setNotFound(true);
        return;
      }
      setError(err instanceof Error ? err.message : t("customers.suppliers.card.errorLoad"));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="crm-page crm-reading">
      <div className="crm-hd__back">
        <BackButton />
      </div>

      {loading ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
        </div>
      ) : notFound ? (
        <div className="crm-panel">
          <p className="crm-panel__title">{t("customers.suppliers.card.notFoundTitle")}</p>
          <p className="crm-panel__body">{t("customers.suppliers.card.notFoundBody")}</p>
          <Link className="crm-btn crm-btn--ghost" href="/suppliers">
            {t("customers.suppliers.card.backToList")}
          </Link>
        </div>
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">{t("customers.suppliers.common.errorTitle")}</p>
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={() => void load()}>
            {t("customers.suppliers.common.retry")}
          </button>
        </div>
      ) : supplier ? (
        <SupplierCardView
          supplier={supplier}
          onEdit={() => setEditOpen(true)}
        />
      ) : null}

      {editOpen && supplier ? (
        <EditSupplierModal
          supplier={supplier}
          onClose={() => setEditOpen(false)}
          onSaved={(updated) => {
            setSupplier(updated);
            setEditOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The supplier file body — one continuous scroll, no tabs, in the approved
 * order: identity + contact (call · email) → supplier details → terms →
 * purchase history → notes → files. Each section is one white panel with its
 * head inside it.
 *
 * DISPLAY RULE (unchanged): a section shows only what is filled in. A section
 * with nothing filled in shows one short line with the existing edit action;
 * what is still missing across the card is surfaced once, as one compact line,
 * never as a half-blank form. No field becomes required.
 */
function SupplierCardView({
  supplier,
  onEdit,
}: {
  supplier: Supplier;
  onEdit: () => void;
}) {
  const { t, locale } = useI18n();
  const createdAt = formatDate(supplier.createdAt, locale);
  const completeness = supplierCompleteness(supplier, t);
  const phone = supplier.phone?.trim() ? supplier.phone : null;
  const email = supplier.email?.trim() ? supplier.email : null;

  const address = [supplier.addressStreet, supplier.addressCity, supplier.addressPostalCode]
    .filter((v) => v && v.trim())
    .join(", ");
  const contactPerson = [supplier.contactName, supplier.contactRole].filter(Boolean).join(" · ");

  // Contact lines: the supplier's own phone / email / address, then its contact
  // person. Lines that need a word to be understood keep a visible label.
  const contactLines: Array<{ key: string; tone: string; icon: ReactNode; label: string; showLabel?: boolean; value: string }> = [];
  if (phone) contactLines.push({ key: "phone", tone: "phone", icon: <PhoneIcon />, label: t("customers.suppliers.card.phone"), value: formatPhoneForDisplay(phone) });
  if (email) contactLines.push({ key: "email", tone: "mail", icon: <MailIcon />, label: t("customers.suppliers.card.email"), value: email });
  if (address) contactLines.push({ key: "address", tone: "file", icon: <PinIcon />, label: t("customers.suppliers.card.address"), value: address });
  if (contactPerson) contactLines.push({ key: "contact", tone: "file", icon: <UserIcon />, label: t("customers.suppliers.card.contact"), showLabel: true, value: contactPerson });
  if (supplier.contactPhone?.trim()) contactLines.push({ key: "directPhone", tone: "phone", icon: <PhoneIcon />, label: t("customers.suppliers.card.directPhone"), showLabel: true, value: formatPhoneForDisplay(supplier.contactPhone) });
  if (supplier.contactEmail?.trim()) contactLines.push({ key: "contactEmail", tone: "mail", icon: <MailIcon />, label: t("customers.suppliers.card.contactEmail"), showLabel: true, value: supplier.contactEmail });

  const identityFields: Array<{ label: string; value: string | null }> = [
    { label: t("customers.suppliers.card.legalName"), value: supplier.legalName },
    { label: supplierTaxIdLabelT(t, supplier.taxIdType), value: supplier.taxId },
    {
      label: t("customers.suppliers.card.entityType"),
      value: supplier.taxIdType ? supplierTaxIdTypeLabelT(t, supplier.taxIdType) : null,
    },
    { label: t("customers.suppliers.card.category"), value: supplier.category },
    { label: t("customers.suppliers.card.website"), value: supplier.website },
  ];

  const termsFields: Array<{ label: string; value: string | null }> = [
    {
      label: t("customers.suppliers.card.paymentTerms"),
      value: formatSupplierPaymentTermsT(t, supplier.paymentTermsDays),
    },
    {
      label: t("customers.suppliers.card.paymentMethod"),
      value: supplier.preferredPaymentMethod
        ? supplierPaymentMethodLabelT(t, supplier.preferredPaymentMethod)
        : null,
    },
    {
      label: t("customers.suppliers.card.defaultLeadTime"),
      value:
        supplier.defaultLeadTimeDays != null
          ? t("customers.suppliers.card.leadTimeDays", { days: supplier.defaultLeadTimeDays })
          : null,
    },
  ];

  return (
    <div className="cust-file sup-file">
      {/* 1 · Identity, contact and contact person, with call / email */}
      <div className="crm-id cust-hero">
        <div className="crm-id__head">
          <span className="cust-avatar cust-avatar--lg" aria-hidden>
            {customerInitials(supplier.name)}
          </span>
          <div className="cust-hero__title">
            <h1 className="crm-id__name">
              <bdi>{supplier.name}</bdi>
            </h1>
            <span className={supplier.isActive ? "crm-badge crm-badge--success" : "crm-badge"}>
              {supplier.isActive ? t("customers.suppliers.card.active") : t("customers.suppliers.card.inactive")}
            </span>
          </div>
          <div className="crm-id__actions">
            <button type="button" className="crm-btn crm-btn--ghost cust-btn-icon" onClick={onEdit}>
              <PencilIcon />
              {t("customers.suppliers.card.edit")}
            </button>
          </div>
        </div>

        {contactLines.length > 0 ? (
          <ul className="cust-lines cust-lines--hero">
            {contactLines.map((l) => (
              <li className={`cust-line cust-tone--${l.tone}`} key={l.key}>
                <span className="cust-line__icon" aria-hidden>
                  {l.icon}
                </span>
                {l.showLabel ? (
                  <span className="sup-line__label">{l.label}:</span>
                ) : (
                  <span className="cust-sr">{l.label}: </span>
                )}
                <bdi className="cust-line__value">{l.value}</bdi>
              </li>
            ))}
          </ul>
        ) : null}

        {supplier.category || createdAt ? (
          <div className="crm-chips">
            {supplier.category ? <span className="crm-chip">{supplier.category}</span> : null}
            {createdAt ? <span className="crm-chip">{t("customers.suppliers.card.createdAt", { date: createdAt })}</span> : null}
          </div>
        ) : null}

        <div className="cust-quick" role="group" aria-label={t("customers.customer.card.quickActions")}>
          <ContactAction
            layout="stack"
            href={telHref(phone)}
            tone="phone"
            icon={<PhoneIcon />}
            label={t("customers.customer.row.call")}
            ariaLabel={t("customers.customer.row.callAria", { name: supplier.name })}
            unavailableReason={t("customers.customer.row.noPhone")}
          />
          <ContactAction
            layout="stack"
            href={mailHref(email)}
            tone="mail"
            icon={<MailIcon />}
            label={t("customers.customer.card.quick.email")}
            ariaLabel={`${t("customers.customer.card.quick.email")} · ${email ?? ""}`}
            unavailableReason={t("customers.customer.card.quick.noEmail")}
          />
        </div>
      </div>

      {completeness.missing.length > 0 ? (
        <p className="sup-missing">
          <span>{t("customers.suppliers.card.completenessBody", { missing: completeness.missing.join(" · ") })}</span>
          <button type="button" className="sup-link" onClick={onEdit}>
            {t("customers.suppliers.card.completenessAction")}
          </button>
        </p>
      ) : null}

      <div className="cust-file__grid">
        {/* 2 · Supplier details */}
        <SupplierFieldPanel
          icon={<BuildingIcon />}
          tone="phone"
          title={t("customers.suppliers.card.sectionIdentity")}
          fields={identityFields}
          onEdit={completeness.missing.length > 0 ? null : onEdit}
        />

        {/* 3 · Terms */}
        <SupplierFieldPanel
          icon={<HandshakeIcon />}
          tone="terms"
          title={t("customers.suppliers.card.sectionTerms")}
          fields={termsFields}
          onEdit={completeness.missing.length > 0 ? null : onEdit}
        />

        {/* 4 · Purchase history (its own loader; "new order" once, in its head) */}
        <div className="sup-panel">
          <SupplierPurchaseHistorySection supplierId={supplier.id} supplierName={supplier.name} />
        </div>

        {/* 5 · Linked documents (document ↔ supplier link). It draws its own panel, and nothing at all while
            document_supplier_linking is OFF for the business — so no empty box is left behind. */}
        <SupplierDocumentsSection supplierId={supplier.id} className="sup-panel" icon={<DocumentIcon />} />

        {/* 6 · Notes — the general note sits under the same head as the thread. */}
        <div className="sup-panel">
          <NotesThread
            subjectType="SUPPLIER"
            subjectId={supplier.id}
            icon={<NoteIcon />}
            intro={
              supplier.notes && supplier.notes.trim() ? (
                <div className="crm-note cust-general-note">
                  <div className="cust-general-note__text">
                    <div className="crm-note__label">{t("customers.suppliers.card.generalNote")}</div>
                    <div className="crm-note__body">{supplier.notes}</div>
                  </div>
                  <button
                    type="button"
                    className="cust-icon-btn"
                    onClick={onEdit}
                    aria-label={t("customers.suppliers.card.edit")}
                    title={t("customers.suppliers.card.edit")}
                  >
                    <PencilIcon />
                  </button>
                </div>
              ) : null
            }
          />
        </div>

        {/* 7 · Files */}
        <div className="sup-panel">
          <AttachmentList subjectType="SUPPLIER" subjectId={supplier.id} icon={<PaperclipIcon />} />
        </div>
      </div>
    </div>
  );
}

/**
 * One label/value panel (supplier details, terms). Shows only filled fields;
 * when none is filled, one short line instead of hiding the section, so the
 * order of the file never changes. The edit action appears in that line only
 * when the card-level "still missing" line (which already carries it) is absent.
 */
function SupplierFieldPanel({
  icon,
  tone,
  title,
  fields,
  onEdit,
}: {
  icon: ReactNode;
  tone: string;
  title: string;
  fields: Array<{ label: string; value: string | null }>;
  onEdit: (() => void) | null;
}) {
  const { t } = useI18n();
  const shown = fields.filter((f) => f.value && String(f.value).trim());

  return (
    <section className="sup-panel crm-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">
          <span className={`crm-section__icon cust-tone--${tone}`} aria-hidden>
            {icon}
          </span>
          {title}
        </h2>
      </div>
      {shown.length > 0 ? (
        <dl className="sup-kv">
          {shown.map((f) => (
            <div className="sup-kv__row" key={f.label}>
              <dt className="sup-kv__label">{f.label}</dt>
              {/* `bdi` so a tax id / website keeps its own direction in the RTL card. */}
              <dd className="sup-kv__value">
                <bdi>{f.value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="sup-empty">
          {t("customers.suppliers.card.sectionEmpty")}
          {onEdit ? (
            <button type="button" className="sup-link" onClick={onEdit}>
              {t("customers.suppliers.card.completenessAction")}
            </button>
          ) : null}
        </p>
      )}
    </section>
  );
}

function EditSupplierModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSaved: (updated: Supplier) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<SupplierFormState>(() =>
    supplierToFormState(supplier)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback<
    <K extends keyof SupplierFormState>(k: K, v: SupplierFormState[K]) => void
  >((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  async function handleSubmit() {
    const invalid = validateSupplierForm(form, t);
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      // Renaming a supplier here changes the DISPLAY name only. Existing purchase
      // orders point at this row by id, so their history survives the rename —
      // that is the whole point of the Entity-FK.
      const updated = await updateSupplier(
        supplier.id,
        supplierFormToPayload(form)
      );
      onSaved(updated);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : t("customers.suppliers.edit.errorSave"));
      setSaving(false);
    }
  }

  return (
    <div
      className="crm-modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={t("customers.suppliers.edit.title")}>
        <h2 className="crm-modal__title">{t("customers.suppliers.edit.title")}</h2>

        <SupplierForm
          form={form}
          set={set}
          idPrefix="sup-edit"
          showActiveToggle
        />

        {error ? <div className="crm-modal__error">{error}</div> : null}

        <div className="crm-modal__actions">
          <button
            type="button"
            className="crm-btn crm-btn--primary crm-btn--full"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {saving ? t("customers.suppliers.common.saving") : t("customers.suppliers.common.save")}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("customers.suppliers.common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
