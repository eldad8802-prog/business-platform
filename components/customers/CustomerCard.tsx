"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  getCustomerCard,
  updateCustomer,
  setCustomerActiveStatus,
  type CustomerCard as CustomerCardData,
  type CustomerCardCustomer,
  type CustomerCardBillingDocument,
  type CustomerCardPaymentRequest,
  type CustomerCardConversation,
  type CustomerCardAppointment,
} from "@/lib/api/customers";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { NotesThread } from "@/components/crm/NotesThread";
import { AttachmentList } from "@/components/crm/AttachmentList";

/**
 * Customer card (detail). Extracted verbatim from the /customers/[id] page — the
 * SAME single representation renders as a full page on mobile/tablet and inside
 * the desktop Master–Detail panel (the layout owns the frame; the back link is
 * CSS-hidden at ≥ the two-pane breakpoint). Only the load logic was tidied into a
 * discriminated LoadState so state is never set synchronously inside the effect;
 * the card content, sections, Edit modal, NotesThread and AttachmentList are
 * unchanged. Navigation uses next/link so the stable list is never refetched.
 */

const TAX_ID_TYPE_LABEL: Record<string, string> = {
  AUTHORIZED_DEALER: "עוסק מורשה",
  EXEMPT_DEALER: "עוסק פטור",
  LTD_COMPANY: 'חברה בע"מ',
  PRIVATE_ID: "ת.ז.",
  OTHER: "אחר",
};

const DOC_TYPE_LABEL: Record<string, string> = {
  TAX_INVOICE: "חשבונית מס",
  QUOTE: "הצעת מחיר",
  CREDIT_NOTE: "חשבונית זיכוי",
  RECEIPT: "קבלה",
  TAX_INVOICE_RECEIPT: "חשבונית מס/קבלה",
};

const DOC_STATUS_LABEL: Record<string, string> = {
  DRAFT: "טיוטה",
  PENDING_REVIEW: "ממתין לאישור",
  ISSUED: "הופק",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: "ממתין לתשלום",
  PAID: "שולם",
  EXPIRED: "פג תוקף",
  CANCELLED: "בוטל",
  FAILED: "נכשל",
};

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: "וואטסאפ",
  INSTAGRAM: "אינסטגרם",
  FACEBOOK: "פייסבוק",
  EMAIL: "אימייל",
  PHONE: "טלפון",
  OTHER: "אחר",
};

const CONVERSATION_STATUS_LABEL: Record<string, string> = {
  OPEN: "פתוחה",
  CLOSED: "סגורה",
  ARCHIVED: "בארכיון",
};

const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  PROPOSED: "הוצע",
  CONFIRMED: "מאושר",
  CANCELLED: "בוטל",
  COMPLETED: "הושלם",
};

function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat("he-IL", {
      style: "currency",
      currency: currency || "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString("he-IL")} ${currency}`;
  }
}

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

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "notFound" }
  | { status: "ready"; card: CustomerCardData };

export function CustomerCard() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [lifecycleSaving, setLifecycleSaving] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  // Returns the next state; never sets it — the effect updates state only after
  // the request resolves. Depends only on `id` (no router) so a soft navigation
  // fetches the card exactly once.
  const fetchCard = useCallback(async (): Promise<LoadState> => {
    if (!Number.isInteger(id) || id <= 0) return { status: "notFound" };
    try {
      const data = await getCustomerCard(id);
      return { status: "ready", card: data };
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return { status: "loading" };
      }
      if (err instanceof Error && err.message === "NOT_FOUND") {
        return { status: "notFound" };
      }
      return {
        status: "error",
        message: err instanceof Error ? err.message : "לא הצלחנו לטעון את הלקוח",
      };
    }
  }, [id]);

  useEffect(() => {
    if (!getClientAuthToken()) {
      redirectToLogin();
      return;
    }
    let cancelled = false;
    void fetchCard().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchCard]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void fetchCard().then(setState);
  }, [fetchCard]);

  // Lifecycle (C2) — flips isActive only, merges into the loaded card, and never
  // reloads the card or its related sections. Guarded against double-submit.
  const applyActive = useCallback(
    async (next: boolean) => {
      if (lifecycleSaving) return;
      try {
        setLifecycleSaving(true);
        setLifecycleError(null);
        const updated = await setCustomerActiveStatus(id, next);
        setState((prev) =>
          prev.status === "ready"
            ? { status: "ready", card: { ...prev.card, customer: updated } }
            : prev,
        );
        setConfirmDeactivate(false);
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        setLifecycleError(
          err instanceof Error ? err.message : "לא הצלחנו לעדכן את סטטוס הלקוח",
        );
      } finally {
        setLifecycleSaving(false);
      }
    },
    [id, lifecycleSaving],
  );

  return (
    <div className="crm-page crm-reading">
      <Link className="crm-hd__back" href="/customers">
        › חזרה ללקוחות
      </Link>

      {state.status === "loading" ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : state.status === "notFound" ? (
        <div className="crm-panel">
          <p className="crm-panel__title">הלקוח לא נמצא</p>
          <p className="crm-panel__body">ייתכן שהלקוח נמחק או שאין לך גישה אליו.</p>
          <Link className="crm-btn crm-btn--ghost" href="/customers">
            חזרה ללקוחות
          </Link>
        </div>
      ) : state.status === "error" ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">משהו השתבש</p>
          <p className="crm-panel__body">{state.message}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            נסו שוב
          </button>
        </div>
      ) : (
        <CustomerCardView
          card={state.card}
          onEdit={() => setEditOpen(true)}
          lifecycleSaving={lifecycleSaving}
          onDeactivate={() => {
            setLifecycleError(null);
            setConfirmDeactivate(true);
          }}
          onReactivate={() => void applyActive(true)}
        />
      )}

      {editOpen && state.status === "ready" ? (
        <EditCustomerModal
          customer={state.card.customer}
          onClose={() => setEditOpen(false)}
          onSaved={(updated) => {
            setState((prev) =>
              prev.status === "ready"
                ? { status: "ready", card: { ...prev.card, customer: updated } }
                : prev,
            );
            setEditOpen(false);
          }}
        />
      ) : null}

      {confirmDeactivate && state.status === "ready" ? (
        <ConfirmDeactivateModal
          customerName={state.card.customer.name}
          saving={lifecycleSaving}
          error={lifecycleError}
          onCancel={() => {
            if (!lifecycleSaving) setConfirmDeactivate(false);
          }}
          onConfirm={() => void applyActive(false)}
        />
      ) : null}
    </div>
  );
}

function CustomerCardView({
  card,
  onEdit,
  lifecycleSaving,
  onDeactivate,
  onReactivate,
}: {
  card: CustomerCardData;
  onEdit: () => void;
  lifecycleSaving: boolean;
  onDeactivate: () => void;
  onReactivate: () => void;
}) {
  const { customer } = card;
  const lastActivity = formatDate(card.activity.lastActivityAt);

  const identityFields: Array<{ label: string; value: string | null }> = [
    { label: "טלפון", value: customer.phone ? formatPhoneForDisplay(customer.phone) : null },
    { label: "אימייל", value: customer.email },
    { label: "עיר", value: customer.city },
    { label: "שם משפטי", value: customer.legalName },
    { label: "מספר עוסק / ח.פ.", value: customer.taxId },
  ];
  const shownFields = identityFields.filter((f) => f.value && f.value.trim());

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
          <h1 className="crm-id__name">{customer.name}</h1>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button type="button" className="crm-btn crm-btn--ghost" onClick={onEdit}>
              עריכה
            </button>
            {customer.isActive ? (
              <button
                type="button"
                className="crm-btn crm-btn--ghost"
                onClick={onDeactivate}
                disabled={lifecycleSaving}
              >
                השבת לקוח
              </button>
            ) : (
              <button
                type="button"
                className="crm-btn crm-btn--ghost"
                onClick={onReactivate}
                disabled={lifecycleSaving}
              >
                {lifecycleSaving ? "מעדכן…" : "החזר לפעילות"}
              </button>
            )}
          </div>
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
            className={customer.isActive ? "crm-badge crm-badge--success" : "crm-badge"}
          >
            {customer.isActive ? "פעיל" : "לא פעיל"}
          </span>
          {customer.taxIdType ? (
            <span className="crm-chip">{label(TAX_ID_TYPE_LABEL, customer.taxIdType)}</span>
          ) : null}
          {lastActivity ? (
            <span className="crm-chip">פעילות אחרונה · {lastActivity}</span>
          ) : null}
        </div>
      </div>

      {customer.notes && customer.notes.trim() ? (
        <div className="crm-note">
          <div className="crm-note__label">הערה כללית</div>
          <div className="crm-note__body">{customer.notes}</div>
        </div>
      ) : null}

      <NotesThread subjectType="CUSTOMER" subjectId={customer.id} />

      <AttachmentList subjectType="CUSTOMER" subjectId={customer.id} />

      {card.billingDocuments.total > 0 ? (
        <BillingDocumentsSection section={card.billingDocuments} />
      ) : null}

      {card.paymentRequests.total > 0 ? (
        <PaymentRequestsSection section={card.paymentRequests} />
      ) : null}

      {card.conversations.total > 0 ? (
        <ConversationsSection section={card.conversations} />
      ) : null}

      {card.appointments.total > 0 ? (
        <AppointmentsSection section={card.appointments} />
      ) : null}

      {!card.activity.hasAnyActivity ? (
        <div className="crm-panel">
          <p className="crm-panel__title">אין עדיין פעילות</p>
          <p className="crm-panel__body">
            מסמכים, תשלומים ושיחות שמשויכים ללקוח יופיעו כאן.
          </p>
        </div>
      ) : null}
    </>
  );
}

function SectionHead({ title, count }: { title: string; count: number }) {
  return (
    <div className="crm-section__head">
      <h2 className="crm-section__title">{title}</h2>
      <span className="crm-section__count">{count}</span>
    </div>
  );
}

function BillingDocumentsSection({
  section,
}: {
  section: { items: CustomerCardBillingDocument[]; total: number };
}) {
  return (
    <div className="crm-section">
      <SectionHead title="מסמכי חיוב" count={section.total} />
      <div className="crm-list">
        {section.items.map((d) => {
          const dateStr = formatDate(d.issuedAt ?? d.createdAt);
          const badgeClass =
            d.status === "ISSUED"
              ? "crm-badge crm-badge--success"
              : d.status === "PENDING_REVIEW"
                ? "crm-badge crm-badge--warning"
                : "crm-badge";
          return (
            <div className="crm-item" key={d.id}>
              <div className="crm-item__main">
                <div className="crm-item__title">
                  {label(DOC_TYPE_LABEL, d.documentType)}
                  {d.documentNumberFormatted ? ` · ${d.documentNumberFormatted}` : ""}
                </div>
                <div className="crm-item__meta">
                  <span className={badgeClass}>{label(DOC_STATUS_LABEL, d.status)}</span>
                  {dateStr ? <span> · {dateStr}</span> : null}
                </div>
              </div>
              <div className="crm-item__amount">{formatMoney(d.totalAmount, d.currency)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PaymentRequestsSection({
  section,
}: {
  section: { items: CustomerCardPaymentRequest[]; total: number };
}) {
  return (
    <div className="crm-section">
      <SectionHead title="בקשות תשלום" count={section.total} />
      <div className="crm-list">
        {section.items.map((p) => {
          const dateStr = formatDate(p.paidAt ?? p.createdAt);
          const badgeClass =
            p.status === "PAID"
              ? "crm-badge crm-badge--success"
              : p.status === "PENDING"
                ? "crm-badge crm-badge--warning"
                : "crm-badge";
          return (
            <div className="crm-item" key={p.id}>
              <div className="crm-item__main">
                <div className="crm-item__title">בקשת תשלום</div>
                <div className="crm-item__meta">
                  <span className={badgeClass}>{label(PAYMENT_STATUS_LABEL, p.status)}</span>
                  {dateStr ? <span> · {dateStr}</span> : null}
                </div>
              </div>
              <div className="crm-item__amount">{formatMoney(p.amount, p.currency)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConversationsSection({
  section,
}: {
  section: { items: CustomerCardConversation[]; total: number };
}) {
  return (
    <div className="crm-section">
      <SectionHead title="שיחות" count={section.total} />
      <div className="crm-list">
        {section.items.map((c) => {
          const dateStr = formatDate(c.lastMessageAt ?? c.startedAt);
          return (
            <div className="crm-item" key={c.id}>
              <div className="crm-item__main">
                <div className="crm-item__title">{label(CHANNEL_LABEL, c.channel)}</div>
                <div className="crm-item__meta">
                  <span className="crm-badge">{label(CONVERSATION_STATUS_LABEL, c.status)}</span>
                  {dateStr ? <span> · {dateStr}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AppointmentsSection({
  section,
}: {
  section: { items: CustomerCardAppointment[]; total: number };
}) {
  return (
    <div className="crm-section">
      <SectionHead title="פגישות" count={section.total} />
      <div className="crm-list">
        {section.items.map((a) => {
          const dateStr = formatDate(a.startsAt ?? a.createdAt);
          return (
            <div className="crm-item" key={a.id}>
              <div className="crm-item__main">
                <div className="crm-item__title">{a.title?.trim() || "פגישה"}</div>
                <div className="crm-item__meta">
                  <span className="crm-badge">{label(APPOINTMENT_STATUS_LABEL, a.status)}</span>
                  {dateStr ? <span> · {dateStr}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EditCustomerModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: CustomerCardCustomer;
  onClose: () => void;
  onSaved: (updated: CustomerCardCustomer) => void;
}) {
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [city, setCity] = useState(customer.city ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError("יש להזין שם לקוח");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const updated = await updateCustomer(customer.id, {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        city: city.trim() || null,
        notes: notes.trim() || null,
      });
      onSaved(updated);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו לשמור את הלקוח");
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label="עריכת לקוח">
        <h2 className="crm-modal__title">עריכת לקוח</h2>

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="cust-edit-name">
            שם *
          </label>
          <input
            id="cust-edit-name"
            className="crm-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="cust-edit-phone">
            טלפון
          </label>
          <input
            id="cust-edit-phone"
            className="crm-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="cust-edit-email">
            אימייל
          </label>
          <input
            id="cust-edit-email"
            className="crm-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="cust-edit-city">
            עיר
          </label>
          <input
            id="cust-edit-city"
            className="crm-input"
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
        </div>
        <div className="crm-field">
          <label className="crm-field__label" htmlFor="cust-edit-notes">
            הערה כללית
          </label>
          <textarea
            id="cust-edit-notes"
            className="crm-note-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
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

function ConfirmDeactivateModal({
  customerName,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  customerName: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="crm-modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label="השבתת לקוח">
        <h2 className="crm-modal__title">להשבית את {customerName}?</h2>
        <p className="crm-panel__body" style={{ marginBottom: 8 }}>
          הלקוח יסומן כלא פעיל ולא יופיע ברשימת הפעילים. שום דבר לא נמחק — המסמכים,
          התשלומים, השיחות, הפגישות, ההערות והקבצים נשמרים, והכרטיס יישאר נגיש.
        </p>

        {error ? <div className="crm-modal__error">{error}</div> : null}

        <div className="crm-modal__actions">
          <button
            type="button"
            className="crm-btn crm-btn--primary crm-btn--full"
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? "משבית…" : "השבת לקוח"}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onCancel}
            disabled={saving}
          >
            ביטול
          </button>
        </div>
      </div>
    </div>
  );
}
