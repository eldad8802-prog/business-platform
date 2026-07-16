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
    <div className="crm-page">
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

function SupplierCardView({
  supplier,
  onEdit,
}: {
  supplier: Supplier;
  onEdit: () => void;
}) {
  const createdAt = formatDate(supplier.createdAt);

  const fields: Array<{ label: string; value: string | null }> = [
    { label: "טלפון", value: supplier.phone ? formatPhoneForDisplay(supplier.phone) : null },
    { label: "אימייל", value: supplier.email },
    {
      label: "זמן אספקה ברירת מחדל",
      value:
        supplier.defaultLeadTimeDays != null
          ? `${supplier.defaultLeadTimeDays} ימים`
          : null,
    },
  ];
  const shownFields = fields.filter((f) => f.value && f.value.trim());

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

        {shownFields.length > 0 ? (
          <div className="crm-id__grid">
            {shownFields.map((f) => (
              <div className="crm-id__field" key={f.label}>
                <div className="crm-id__label">{f.label}</div>
                <div className="crm-id__value">{f.value}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="crm-chips">
          <span
            className={
              supplier.isActive ? "crm-badge crm-badge--success" : "crm-badge"
            }
          >
            {supplier.isActive ? "פעיל" : "לא פעיל"}
          </span>
          {createdAt ? <span className="crm-chip">נוצר · {createdAt}</span> : null}
        </div>
      </div>

      {supplier.notes && supplier.notes.trim() ? (
        <div className="crm-note">
          <div className="crm-note__label">הערה כללית</div>
          <div className="crm-note__body">{supplier.notes}</div>
        </div>
      ) : null}
    </>
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
  const [name, setName] = useState(supplier.name);
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [email, setEmail] = useState(supplier.email ?? "");
  const [leadTime, setLeadTime] = useState(
    supplier.defaultLeadTimeDays != null ? String(supplier.defaultLeadTimeDays) : ""
  );
  const [notes, setNotes] = useState(supplier.notes ?? "");
  const [isActive, setIsActive] = useState(supplier.isActive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("יש להזין שם ספק");
      return;
    }
    let leadTimeValue: number | null = null;
    const trimmedLead = leadTime.trim();
    if (trimmedLead) {
      const parsed = Number(trimmedLead);
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError("זמן אספקה חייב להיות מספר שלם ואי-שלילי");
        return;
      }
      leadTimeValue = parsed;
    }
    try {
      setSaving(true);
      setError(null);
      const updated = await updateSupplier(supplier.id, {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
        defaultLeadTimeDays: leadTimeValue,
        isActive,
      });
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

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-edit-name">
            שם *
          </label>
          <input
            id="sup-edit-name"
            className="crm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-edit-phone">
            טלפון
          </label>
          <input
            id="sup-edit-phone"
            className="crm-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-edit-email">
            אימייל
          </label>
          <input
            id="sup-edit-email"
            className="crm-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-edit-lead">
            זמן אספקה ברירת מחדל (ימים)
          </label>
          <input
            id="sup-edit-lead"
            className="crm-input"
            value={leadTime}
            onChange={(e) => setLeadTime(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="sup-edit-notes">
            הערה כללית
          </label>
          <textarea
            id="sup-edit-notes"
            className="crm-note-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </div>
        <div className="crm-field">
          <label
            className="crm-field__label"
            htmlFor="sup-edit-active"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
            }}
          >
            <input
              id="sup-edit-active"
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            ספק פעיל
          </label>
        </div>

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
