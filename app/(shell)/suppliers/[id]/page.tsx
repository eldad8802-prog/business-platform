"use client";

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
  supplierCompleteness,
  supplierFormToPayload,
  supplierToFormState,
  validateSupplierForm,
  type SupplierFormState,
} from "@/components/suppliers/supplier-form-model";
import {
  formatSupplierPaymentTerms,
  SUPPLIER_PAYMENT_METHOD_LABELS,
  SUPPLIER_TAX_ID_TYPE_LABELS,
  supplierTaxIdLabel,
} from "@/lib/services/inventory/supplier-profile";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export default function SupplierCardPage() {
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
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את הספק");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="crm-page crm-reading">
      <a className="crm-hd__back" href="/suppliers">
        › חזרה לספקים
      </a>

      {loading ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
        </div>
      ) : notFound ? (
        <div className="crm-panel">
          <p className="crm-panel__title">הספק לא נמצא</p>
          <p className="crm-panel__body">ייתכן שהספק הוסר או שאין לך גישה אליו.</p>
          <a className="crm-btn crm-btn--ghost" href="/suppliers">
            חזרה לספקים
          </a>
        </div>
      ) : error ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">משהו השתבש</p>
          <p className="crm-panel__body">{error}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={() => void load()}>
            נסו שוב
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
  const createdAt = formatDate(supplier.createdAt);
  const completeness = supplierCompleteness(supplier);

  const identityFields: Array<{ label: string; value: string | null }> = [
    { label: "שם רשום", value: supplier.legalName },
    {
      label: supplierTaxIdLabel(supplier.taxIdType),
      value: supplier.taxId,
    },
    {
      label: "סוג ישות",
      value: supplier.taxIdType
        ? SUPPLIER_TAX_ID_TYPE_LABELS[supplier.taxIdType]
        : null,
    },
    { label: "קטגוריה", value: supplier.category },
    { label: "אתר", value: supplier.website },
  ];

  const contactFields: Array<{ label: string; value: string | null }> = [
    {
      label: "טלפון",
      value: supplier.phone ? formatPhoneForDisplay(supplier.phone) : null,
    },
    { label: "אימייל", value: supplier.email },
    {
      label: "איש קשר",
      value: [supplier.contactName, supplier.contactRole]
        .filter(Boolean)
        .join(" · ") || null,
    },
    {
      label: "טלפון ישיר",
      value: supplier.contactPhone
        ? formatPhoneForDisplay(supplier.contactPhone)
        : null,
    },
    { label: "אימייל איש קשר", value: supplier.contactEmail },
    {
      label: "כתובת",
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
      label: "תנאי תשלום",
      value: formatSupplierPaymentTerms(supplier.paymentTermsDays),
    },
    {
      label: "צורת תשלום",
      value: supplier.preferredPaymentMethod
        ? SUPPLIER_PAYMENT_METHOD_LABELS[supplier.preferredPaymentMethod]
        : null,
    },
    {
      label: "זמן אספקה ברירת מחדל",
      value:
        supplier.defaultLeadTimeDays != null
          ? `${supplier.defaultLeadTimeDays} ימים`
          : null,
    },
  ];

  return (
    <>
      <div className="crm-id">
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <h1 className="crm-id__name">{supplier.name}</h1>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onEdit}
            style={{ flexShrink: 0 }}
          >
            עריכה
          </button>
        </div>

        <div className="crm-chips">
          <span
            className={
              supplier.isActive ? "crm-badge crm-badge--success" : "crm-badge"
            }
          >
            {supplier.isActive ? "פעיל" : "לא פעיל"}
          </span>
          {supplier.category ? (
            <span className="crm-chip">{supplier.category}</span>
          ) : null}
          {createdAt ? <span className="crm-chip">נוצר · {createdAt}</span> : null}
        </div>
      </div>

      <SupplierFieldSection title="פרטי ספק" fields={identityFields} />
      <SupplierFieldSection title="פרטי קשר" fields={contactFields} />
      <SupplierFieldSection title="תנאי התקשרות" fields={termsFields} />

      {completeness.missing.length > 0 ? (
        <div className="crm-panel">
          <p className="crm-panel__title">השלמת פרטי ספק</p>
          <p className="crm-panel__body">
            חסרים עדיין: {completeness.missing.join(" · ")}. השלמה עכשיו תחסוך
            חיפוש בהמשך.
          </p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={onEdit}>
            השלמת פרטים
          </button>
        </div>
      ) : null}

      {supplier.notes && supplier.notes.trim() ? (
        <div className="crm-note">
          <div className="crm-note__label">הערה כללית</div>
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
    const invalid = validateSupplierForm(form);
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
      setError(err instanceof Error ? err.message : "לא הצלחנו לשמור את הספק");
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label="עריכת ספק">
        <h2 className="crm-modal__title">עריכת ספק</h2>

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
            {saving ? "שומר…" : "שמירה"}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
