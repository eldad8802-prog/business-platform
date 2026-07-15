"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getCustomerCard,
  type CustomerCard,
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

export default function CustomerCardPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params?.id);
  const [card, setCard] = useState<CustomerCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

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
      const data = await getCustomerCard(id);
      setCard(data);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      if (err instanceof Error && err.message === "NOT_FOUND") {
        setNotFound(true);
        return;
      }
      setError(err instanceof Error ? err.message : "לא הצלחנו לטעון את הלקוח");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="crm-page">
      <a className="crm-hd__back" href="/customers">
        › חזרה ללקוחות
      </a>

      {loading ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : notFound ? (
        <div className="crm-panel">
          <p className="crm-panel__title">הלקוח לא נמצא</p>
          <p className="crm-panel__body">ייתכן שהלקוח נמחק או שאין לך גישה אליו.</p>
          <a className="crm-btn crm-btn--ghost" href="/customers">
            חזרה ללקוחות
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
      ) : card ? (
        <CustomerCardView card={card} />
      ) : null}
    </div>
  );
}

function CustomerCardView({ card }: { card: CustomerCard }) {
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
        <h1 className="crm-id__name">{customer.name}</h1>

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
