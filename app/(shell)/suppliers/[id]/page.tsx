"use client";

import Link from "next/link";
import BackButton from "@/components/ui/back-button";
import { useCallback, useEffect, useState } from "react";
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
import { SupplierPurchaseHistorySection } from "@/components/inventory/SupplierPurchaseHistorySection";
import { SupplierForm } from "@/components/suppliers/SupplierForm";
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
 * The supplier card body.
 *
 * DISPLAY RULE: sections render only what is actually filled in. A supplier with
 * a name and a phone shows two lines, not twenty empty labels — an empty field
 * is not information, and a wall of them makes the card unreadable. What IS
 * missing is surfaced once, calmly, as a single "השלמת פרטי ספק" nudge rather
 * than as a permanently half-blank form.
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

  const identityFields: Array<{ label: string; value: string | null }> = [
    { label: t("customers.suppliers.card.legalName"), value: supplier.legalName },
    {
      label: supplierTaxIdLabelT(t, supplier.taxIdType),
      value: supplier.taxId,
    },
    {
      label: t("customers.suppliers.card.entityType"),
      value: supplier.taxIdType
        ? supplierTaxIdTypeLabelT(t, supplier.taxIdType)
        : null,
    },
    { label: t("customers.suppliers.card.category"), value: supplier.category },
    { label: t("customers.suppliers.card.website"), value: supplier.website },
  ];

  const contactFields: Array<{ label: string; value: string | null }> = [
    {
      label: t("customers.suppliers.card.phone"),
      value: supplier.phone ? formatPhoneForDisplay(supplier.phone) : null,
    },
    { label: t("customers.suppliers.card.email"), value: supplier.email },
    {
      label: t("customers.suppliers.card.contact"),
      value: [supplier.contactName, supplier.contactRole]
        .filter(Boolean)
        .join(" · ") || null,
    },
    {
      label: t("customers.suppliers.card.directPhone"),
      value: supplier.contactPhone
        ? formatPhoneForDisplay(supplier.contactPhone)
        : null,
    },
    { label: t("customers.suppliers.card.contactEmail"), value: supplier.contactEmail },
    {
      label: t("customers.suppliers.card.address"),
      value: [
        supplier.addressStreet,
        supplier.addressCity,
        supplier.addressPostalCode,
      ]
        .filter((v) => v && v.trim())
        .join(", ") || null,
    },
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
    <>
      <div className="crm-id">
        <div className="crm-id__head">
          <h1 className="crm-id__name">
            <bdi>{supplier.name}</bdi>
          </h1>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onEdit}
            style={{ flexShrink: 0 }}
          >
            {t("customers.suppliers.card.edit")}
          </button>
        </div>

        <div className="crm-chips">
          <span
            className={
              supplier.isActive ? "crm-badge crm-badge--success" : "crm-badge"
            }
          >
            {supplier.isActive ? t("customers.suppliers.card.active") : t("customers.suppliers.card.inactive")}
          </span>
          {supplier.category ? (
            <span className="crm-chip">{supplier.category}</span>
          ) : null}
          {createdAt ? <span className="crm-chip">{t("customers.suppliers.card.createdAt", { date: createdAt })}</span> : null}
        </div>
      </div>

      <SupplierFieldSection title={t("customers.suppliers.card.sectionIdentity")} fields={identityFields} />
      <SupplierFieldSection title={t("customers.suppliers.card.sectionContact")} fields={contactFields} />
      <SupplierFieldSection title={t("customers.suppliers.card.sectionTerms")} fields={termsFields} />

      {completeness.missing.length > 0 ? (
        <div className="crm-panel">
          <p className="crm-panel__title">{t("customers.suppliers.card.completenessTitle")}</p>
          <p className="crm-panel__body">
            {t("customers.suppliers.card.completenessBody", {
              missing: completeness.missing.join(" · "),
            })}
          </p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={onEdit}>
            {t("customers.suppliers.card.completenessAction")}
          </button>
        </div>
      ) : null}

      {supplier.notes && supplier.notes.trim() ? (
        <div className="crm-note">
          <div className="crm-note__label">{t("customers.suppliers.card.generalNote")}</div>
          <div className="crm-note__body">{supplier.notes}</div>
        </div>
      ) : null}

      <SupplierPurchaseHistorySection
        supplierId={supplier.id}
        supplierName={supplier.name}
      />

      <NotesThread subjectType="SUPPLIER" subjectId={supplier.id} />

      <AttachmentList subjectType="SUPPLIER" subjectId={supplier.id} />
    </>
  );
}

/** Renders nothing at all when every field in the section is empty. */
function SupplierFieldSection({
  title,
  fields,
}: {
  title: string;
  fields: Array<{ label: string; value: string | null }>;
}) {
  const shown = fields.filter((f) => f.value && String(f.value).trim());
  if (shown.length === 0) return null;

  return (
    <div className="crm-id" style={{ marginTop: 12 }}>
      <div className="crm-seclabel" style={{ fontWeight: 600, marginBottom: 8 }}>
        {title}
      </div>
      <div className="crm-id__grid">
        {shown.map((f) => (
          <div className="crm-id__field" key={f.label}>
            <div className="crm-id__label">{f.label}</div>
            <div className="crm-id__value">
              <bdi>{f.value}</bdi>
            </div>
          </div>
        ))}
      </div>
    </div>
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
