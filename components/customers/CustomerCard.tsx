"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import BackButton from "@/components/ui/back-button";
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
  type CustomerCardOrder,
  type CustomerCardCall,
} from "@/lib/api/customers";
import {
  getClientAuthToken,
  isUnauthorizedError,
  redirectToLogin,
} from "@/lib/client-session";
import { formatPhoneForDisplay } from "@/lib/format/phone-display";
import { NotesThread } from "@/components/crm/NotesThread";
import { AttachmentList } from "@/components/crm/AttachmentList";
import { ContactAction } from "@/components/customers/ContactAction";
import { customerInitials, mailHref, telHref, whatsAppChatHref } from "@/components/customers/customer-contact";
import {
  BagIcon,
  CalendarIcon,
  CardIcon,
  ChatIcon,
  ChevronIcon,
  DocumentIcon,
  MailIcon,
  NoteIcon,
  PaperclipIcon,
  PencilIcon,
  PhoneIcon,
  PinIcon,
  WhatsappIcon,
} from "@/components/customers/customer-icons";
import { useI18n } from "@/components/i18n/I18nProvider";
import { intlTag, type Locale } from "@/lib/i18n/config";
import type { MessageKey, Translator } from "@/lib/i18n/translate";

/**
 * Customer file (detail) — one continuous scroll, no tabs: identity + contact,
 * quick actions (call / WhatsApp / email), recent documents, recent payments,
 * notes, then everything else the card already held (files, conversations,
 * appointments, orders, calls). There is deliberately no financial summary:
 * the read-model has no verified per-customer balance and amounts in different
 * currencies are never added together.
 *
 * Originally extracted verbatim from the /customers/[id] page — the
 * SAME single representation renders as a full page on mobile/tablet and inside
 * the desktop Master–Detail panel (the layout owns the frame; the back link is
 * CSS-hidden at ≥ the two-pane breakpoint). Only the load logic was tidied into a
 * discriminated LoadState so state is never set synchronously inside the effect;
 * the card content, sections, Edit modal, NotesThread and AttachmentList are
 * unchanged. Navigation uses next/link so the stable list is never refetched.
 */

const TAX_ID_TYPE_LABEL: Record<string, MessageKey> = {
  AUTHORIZED_DEALER: "customers.customer.taxIdType.authorizedDealer",
  EXEMPT_DEALER: "customers.customer.taxIdType.exemptDealer",
  LTD_COMPANY: "customers.customer.taxIdType.ltdCompany",
  PRIVATE_ID: "customers.customer.taxIdType.privateId",
  OTHER: "customers.customer.taxIdType.other",
};

const DOC_TYPE_LABEL: Record<string, MessageKey> = {
  TAX_INVOICE: "customers.customer.docType.taxInvoice",
  QUOTE: "customers.customer.docType.quote",
  CREDIT_NOTE: "customers.customer.docType.creditNote",
  RECEIPT: "customers.customer.docType.receipt",
  TAX_INVOICE_RECEIPT: "customers.customer.docType.taxInvoiceReceipt",
};

const DOC_STATUS_LABEL: Record<string, MessageKey> = {
  DRAFT: "customers.customer.docStatus.draft",
  PENDING_REVIEW: "customers.customer.docStatus.pendingReview",
  ISSUED: "customers.customer.docStatus.issued",
};

const PAYMENT_STATUS_LABEL: Record<string, MessageKey> = {
  PENDING: "customers.customer.paymentStatus.pending",
  PAID: "customers.customer.paymentStatus.paid",
  EXPIRED: "customers.customer.paymentStatus.expired",
  CANCELLED: "customers.customer.paymentStatus.cancelled",
  FAILED: "customers.customer.paymentStatus.failed",
};

const CHANNEL_LABEL: Record<string, MessageKey> = {
  WHATSAPP: "customers.customer.channel.whatsapp",
  INSTAGRAM: "customers.customer.channel.instagram",
  FACEBOOK: "customers.customer.channel.facebook",
  EMAIL: "customers.customer.channel.email",
  PHONE: "customers.customer.channel.phone",
  OTHER: "customers.customer.channel.other",
};

const CONVERSATION_STATUS_LABEL: Record<string, MessageKey> = {
  OPEN: "customers.customer.conversationStatus.open",
  CLOSED: "customers.customer.conversationStatus.closed",
  ARCHIVED: "customers.customer.conversationStatus.archived",
};

const APPOINTMENT_STATUS_LABEL: Record<string, MessageKey> = {
  PROPOSED: "customers.customer.appointmentStatus.proposed",
  CONFIRMED: "customers.customer.appointmentStatus.confirmed",
  CANCELLED: "customers.customer.appointmentStatus.cancelled",
  COMPLETED: "customers.customer.appointmentStatus.completed",
};

const ORDER_SOURCE_LABEL: Record<string, string> = {
  "commerce.woocommerce": "WooCommerce",
  "commerce.wix": "Wix",
};

const ORDER_STATUS_LABEL: Record<string, MessageKey> = {
  placed: "customers.customer.orderStatus.placed",
  paid: "customers.customer.orderStatus.paid",
  fulfilled: "customers.customer.orderStatus.fulfilled",
  cancelled: "customers.customer.orderStatus.cancelled",
  refunded: "customers.customer.orderStatus.refunded",
  partially_refunded: "customers.customer.orderStatus.partiallyRefunded",
};

const CALL_OUTCOME_LABEL: Record<string, MessageKey> = {
  answered: "customers.customer.callOutcome.answered",
  missed: "customers.customer.callOutcome.missed",
  voicemail: "customers.customer.callOutcome.voicemail",
  busy: "customers.customer.callOutcome.busy",
  failed: "customers.customer.callOutcome.failed",
  rejected: "customers.customer.callOutcome.rejected",
};

function formatMinor(minor: number, currency: string, locale: Locale): string {
  const exp = ["JPY", "KRW", "VND", "CLP", "ISK"].includes(currency) ? 0 : ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"].includes(currency) ? 3 : 2;
  try {
    return new Intl.NumberFormat(intlTag(locale), { style: "currency", currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp);
  } catch {
    return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`;
  }
}

function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/** Same as `label`, for maps of dictionary keys: unknown values pass through untranslated. */
function labelT(t: Translator, map: Record<string, MessageKey>, key: string): string {
  const k = map[key];
  return k ? t(k) : key;
}

function formatMoney(amount: string, currency: string, locale: Locale): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(intlTag(locale), {
      style: "currency",
      currency: currency || "ILS",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString(intlTag(locale))} ${currency}`;
  }
}

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

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "notFound" }
  | { status: "ready"; card: CustomerCardData };

export function CustomerCard() {
  const { t } = useI18n();
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
        message: err instanceof Error ? err.message : t("customers.customer.card.loadError"),
      };
    }
  }, [id, t]);

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
          err instanceof Error ? err.message : t("customers.customer.card.statusError"),
        );
      } finally {
        setLifecycleSaving(false);
      }
    },
    [id, lifecycleSaving, t],
  );

  return (
    <div className="crm-page crm-reading">
      <div className="crm-hd__back">
        <BackButton />
      </div>

      {state.status === "loading" ? (
        <div>
          <div className="crm-skel" style={{ height: 120 }} />
          <div className="crm-skel" />
          <div className="crm-skel" />
        </div>
      ) : state.status === "notFound" ? (
        <div className="crm-panel">
          <p className="crm-panel__title">{t("customers.customer.card.notFoundTitle")}</p>
          <p className="crm-panel__body">{t("customers.customer.card.notFoundBody")}</p>
          <Link className="crm-btn crm-btn--ghost" href="/customers">
            {t("customers.customer.card.backToList")}
          </Link>
        </div>
      ) : state.status === "error" ? (
        <div className="crm-panel crm-panel--error">
          <p className="crm-panel__title">{t("customers.customer.common.errorTitle")}</p>
          <p className="crm-panel__body">{state.message}</p>
          <button type="button" className="crm-btn crm-btn--ghost" onClick={retry}>
            {t("customers.customer.common.retry")}
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

/** Items shown per history section before "show more". */
const PREVIEW_COUNT = 3;

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
  const { t, locale } = useI18n();
  const { customer } = card;
  const lastActivity = formatDate(card.activity.lastActivityAt, locale);
  const phone = customer.phone?.trim() ? customer.phone : null;

  const contactLines: Array<{ key: string; tone: string; icon: ReactNode; label: string; value: string }> = [];
  if (phone) contactLines.push({ key: "phone", tone: "phone", icon: <PhoneIcon />, label: t("customers.customer.card.fields.phone"), value: formatPhoneForDisplay(phone) });
  if (customer.email?.trim()) contactLines.push({ key: "email", tone: "mail", icon: <MailIcon />, label: t("customers.customer.card.fields.email"), value: customer.email });
  if (customer.city?.trim()) contactLines.push({ key: "city", tone: "file", icon: <PinIcon />, label: t("customers.customer.card.fields.city"), value: customer.city });

  // Tax identity is shown as before (owned by Billing, read-only here).
  const taxFields = [
    { label: t("customers.customer.card.fields.legalName"), value: customer.legalName },
    { label: t("customers.customer.card.fields.taxId"), value: customer.taxId },
  ].filter((f) => f.value && f.value.trim());

  return (
    <div className="cust-file">
      {/* 1–2 · Identity, contact details and quick actions */}
      <div className="crm-id cust-hero">
        <div className="crm-id__head">
          <span className="cust-avatar cust-avatar--lg" aria-hidden>
            {customerInitials(customer.name)}
          </span>
          <div className="cust-hero__title">
            <h1 className="crm-id__name">
              <bdi>{customer.name}</bdi>
            </h1>
            <span className={customer.isActive ? "crm-badge crm-badge--success" : "crm-badge"}>
              {customer.isActive ? t("customers.customer.card.active") : t("customers.customer.card.inactive")}
            </span>
          </div>
          <div className="crm-id__actions">
            <button type="button" className="crm-btn crm-btn--ghost cust-btn-icon" onClick={onEdit}>
              <PencilIcon />
              {t("customers.customer.card.edit")}
            </button>
            {customer.isActive ? (
              <button
                type="button"
                className="crm-btn crm-btn--ghost"
                onClick={onDeactivate}
                disabled={lifecycleSaving}
              >
                {t("customers.customer.card.deactivate")}
              </button>
            ) : (
              <button
                type="button"
                className="crm-btn crm-btn--ghost"
                onClick={onReactivate}
                disabled={lifecycleSaving}
              >
                {lifecycleSaving ? t("customers.customer.card.updating") : t("customers.customer.card.reactivate")}
              </button>
            )}
          </div>
        </div>

        {contactLines.length > 0 ? (
          <ul className="cust-lines cust-lines--hero">
            {contactLines.map((l) => (
              <li className={`cust-line cust-tone--${l.tone}`} key={l.key}>
                <span className="cust-line__icon" aria-hidden>
                  {l.icon}
                </span>
                <span className="cust-sr">{l.label}: </span>
                <bdi className="cust-line__value">{l.value}</bdi>
              </li>
            ))}
          </ul>
        ) : null}

        {taxFields.length > 0 ? (
          <div className="crm-id__grid cust-hero__tax">
            {taxFields.map((f) => (
              <div className="crm-id__field" key={f.label}>
                <div className="crm-id__label">{f.label}</div>
                {/* `bdi` so a tax id keeps its own direction inside the RTL card. */}
                <div className="crm-id__value">
                  <bdi>{f.value}</bdi>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {customer.taxIdType || lastActivity ? (
          <div className="crm-chips">
            {customer.taxIdType ? (
              <span className="crm-chip">{labelT(t, TAX_ID_TYPE_LABEL, customer.taxIdType)}</span>
            ) : null}
            {lastActivity ? (
              <span className="crm-chip">{t("customers.customer.card.lastActivity", { date: lastActivity })}</span>
            ) : null}
          </div>
        ) : null}

        <div className="cust-quick" role="group" aria-label={t("customers.customer.card.quickActions")}>
          <ContactAction
            layout="stack"
            href={telHref(phone)}
            tone="phone"
            icon={<PhoneIcon />}
            label={t("customers.customer.row.call")}
            ariaLabel={t("customers.customer.row.callAria", { name: customer.name })}
            unavailableReason={t("customers.customer.row.noPhone")}
          />
          <ContactAction
            layout="stack"
            href={whatsAppChatHref(phone)}
            tone="whatsapp"
            icon={<WhatsappIcon />}
            label="WhatsApp"
            ariaLabel={t("customers.customer.row.whatsappAria", { name: customer.name })}
            unavailableReason={phone ? t("customers.customer.row.noWhatsapp") : t("customers.customer.row.noPhone")}
          />
          <ContactAction
            layout="stack"
            href={mailHref(customer.email)}
            tone="mail"
            icon={<MailIcon />}
            label={t("customers.customer.card.quick.email")}
            ariaLabel={`${t("customers.customer.card.quick.email")} · ${customer.email ?? ""}`}
            unavailableReason={t("customers.customer.card.quick.noEmail")}
          />
        </div>
      </div>

      {/* 3 · Financial summary — intentionally absent: the card read-model has no
          verified per-customer balance, and amounts are never summed here. */}

      <div className="cust-file__grid">
        {/* 4 · Recent documents */}
        <BillingDocumentsSection section={card.billingDocuments} />

        {/* 5 · Recent payments */}
        <PaymentRequestsSection section={card.paymentRequests} customerId={customer.id} />

        {/* 6 · Notes — the general note sits under the same head as the thread. */}
        <NotesThread
          subjectType="CUSTOMER"
          subjectId={customer.id}
          icon={<NoteIcon />}
          intro={
            customer.notes && customer.notes.trim() ? (
              <div className="crm-note cust-general-note">
                <div className="cust-general-note__text">
                  <div className="crm-note__label">{t("customers.customer.card.generalNote")}</div>
                  <div className="crm-note__body">{customer.notes}</div>
                </div>
                <button
                  type="button"
                  className="cust-icon-btn"
                  onClick={onEdit}
                  aria-label={t("customers.customer.card.edit")}
                  title={t("customers.customer.card.edit")}
                >
                  <PencilIcon />
                </button>
              </div>
            ) : null
          }
        />

        {/* Everything else the card already held stays, in the same column. */}
        <AttachmentList subjectType="CUSTOMER" subjectId={customer.id} icon={<PaperclipIcon />} />

        {card.conversations.total > 0 ? (
          <ConversationsSection section={card.conversations} />
        ) : null}

        {card.appointments.total > 0 ? (
          <AppointmentsSection section={card.appointments} />
        ) : null}

        {card.orders.total > 0 ? <OrdersSection section={card.orders} /> : null}

        {card.calls.total > 0 ? <CallsSection section={card.calls} /> : null}
      </div>
    </div>
  );
}

/**
 * One history section of the file: icon + title + count, the first few items
 * in a single grouped surface, and "show more" that expands IN PLACE over the
 * items already loaded (the read-model caps each relation, so this never loads
 * unbounded history). When the customer has more than was loaded, the footer
 * says so instead of pretending the list is complete.
 */
function HistorySection<T>({
  icon,
  tone,
  title,
  section,
  emptyText,
  renderItem,
}: {
  icon: ReactNode;
  tone: string;
  title: string;
  section: { items: T[]; total: number };
  emptyText?: string;
  renderItem: (item: T) => ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const { items, total } = section;
  const shown = expanded ? items : items.slice(0, PREVIEW_COUNT);
  const hidden = items.length - shown.length;

  return (
    <section className="crm-section cust-section">
      <div className="crm-section__head">
        <h2 className="crm-section__title">
          <span className={`crm-section__icon cust-tone--${tone}`} aria-hidden>
            {icon}
          </span>
          {title}
        </h2>
        <span className="crm-section__count">{total}</span>
      </div>
      {items.length === 0 ? (
        <p className="crm-note-empty">{emptyText}</p>
      ) : (
        <div className="cust-group">
          <div className="crm-list">{shown.map(renderItem)}</div>
          {hidden > 0 || expanded ? (
            <button
              type="button"
              className="cust-more"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? t("customers.customer.card.showLess") : t("customers.customer.card.showMore", { count: hidden })}
            </button>
          ) : null}
          {expanded && total > items.length ? (
            <p className="cust-group__note">
              {t("customers.customer.card.showingLatest", { shown: items.length, total })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function BillingDocumentsSection({
  section,
}: {
  section: { items: CustomerCardBillingDocument[]; total: number };
}) {
  const { t, locale } = useI18n();
  return (
    <HistorySection
      icon={<DocumentIcon />}
      tone="file"
      title={t("customers.customer.card.recentDocuments")}
      section={section}
      emptyText={t("customers.customer.card.noDocuments")}
      renderItem={(d) => {
        const dateStr = formatDate(d.issuedAt ?? d.createdAt, locale);
        const badgeClass =
          d.status === "ISSUED"
            ? "crm-badge crm-badge--success"
            : d.status === "PENDING_REVIEW"
              ? "crm-badge crm-badge--warning"
              : "crm-badge";
        return (
          <Link className="crm-item cust-item" key={d.id} href={`/billing/${d.id}`}>
            <span className="cust-item__icon cust-tone--file" aria-hidden>
              <DocumentIcon />
            </span>
            <div className="crm-item__main">
              <div className="crm-item__title">
                {labelT(t, DOC_TYPE_LABEL, d.documentType)}
                {d.documentNumberFormatted ? <> <bdi>{d.documentNumberFormatted}</bdi></> : null}
              </div>
              <div className="crm-item__meta">
                <span className={badgeClass}>{labelT(t, DOC_STATUS_LABEL, d.status)}</span>
                {dateStr ? <span> · {dateStr}</span> : null}
              </div>
            </div>
            <div className="crm-item__amount">
              <bdi>{formatMoney(d.totalAmount, d.currency, locale)}</bdi>
            </div>
            <ChevronIcon className="cust-item__chev" />
          </Link>
        );
      }}
    />
  );
}

function PaymentRequestsSection({
  section,
  customerId,
}: {
  section: { items: CustomerCardPaymentRequest[]; total: number };
  customerId: number;
}) {
  const { t, locale } = useI18n();
  return (
    <HistorySection
      icon={<CardIcon />}
      tone="phone"
      title={t("customers.customer.card.recentPayments")}
      section={section}
      emptyText={t("customers.customer.card.noPayments")}
      renderItem={(p) => {
        const dateStr = formatDate(p.paidAt ?? p.createdAt, locale);
        const badgeClass =
          p.status === "PAID"
            ? "crm-badge crm-badge--success"
            : p.status === "PENDING"
              ? "crm-badge crm-badge--warning"
              : "crm-badge";
        return (
          // The request opens inside the customer's collection thread, anchored
          // to it — the same destination the legacy /payments/[id] resolves to.
          <Link className="crm-item cust-item" key={p.id} href={`/collection/c/${customerId}?request=${p.id}`}>
            <span className="cust-item__icon cust-tone--phone" aria-hidden>
              <CardIcon />
            </span>
            <div className="crm-item__main">
              <div className="crm-item__title">{t("customers.customer.card.paymentRequest")}</div>
              <div className="crm-item__meta">
                <span className={badgeClass}>{labelT(t, PAYMENT_STATUS_LABEL, p.status)}</span>
                {dateStr ? <span> · {dateStr}</span> : null}
              </div>
            </div>
            <div className="crm-item__amount">
              <bdi>{formatMoney(p.amount, p.currency, locale)}</bdi>
            </div>
            <ChevronIcon className="cust-item__chev" />
          </Link>
        );
      }}
    />
  );
}

function ConversationsSection({
  section,
}: {
  section: { items: CustomerCardConversation[]; total: number };
}) {
  const { t, locale } = useI18n();
  return (
    <HistorySection
      icon={<ChatIcon />}
      tone="whatsapp"
      title={t("customers.customer.card.sections.conversations")}
      section={section}
      renderItem={(c) => {
        const dateStr = formatDate(c.lastMessageAt ?? c.startedAt, locale);
        return (
          <div className="crm-item cust-item" key={c.id}>
            <div className="crm-item__main">
              <div className="crm-item__title">{labelT(t, CHANNEL_LABEL, c.channel)}</div>
              <div className="crm-item__meta">
                <span className="crm-badge">{labelT(t, CONVERSATION_STATUS_LABEL, c.status)}</span>
                {dateStr ? <span> · {dateStr}</span> : null}
              </div>
            </div>
          </div>
        );
      }}
    />
  );
}

function AppointmentsSection({
  section,
}: {
  section: { items: CustomerCardAppointment[]; total: number };
}) {
  const { t, locale } = useI18n();
  return (
    <HistorySection
      icon={<CalendarIcon />}
      tone="file"
      title={t("customers.customer.card.sections.appointments")}
      section={section}
      renderItem={(a) => {
        const dateStr = formatDate(a.startsAt ?? a.createdAt, locale);
        return (
          <div className="crm-item cust-item" key={a.id}>
            <div className="crm-item__main">
              <div className="crm-item__title">{a.title?.trim() || t("customers.customer.card.appointmentFallback")}</div>
              <div className="crm-item__meta">
                <span className="crm-badge">{labelT(t, APPOINTMENT_STATUS_LABEL, a.status)}</span>
                {dateStr ? <span> · {dateStr}</span> : null}
              </div>
            </div>
          </div>
        );
      }}
    />
  );
}

/** M7-B — the customer's orders from the online store: history only (no payment, document or stock). */
function OrdersSection({ section }: { section: { items: CustomerCardOrder[]; total: number } }) {
  const { t, locale } = useI18n();
  return (
    <HistorySection
      icon={<BagIcon />}
      tone="mail"
      title={t("customers.customer.card.sections.orders")}
      section={section}
      renderItem={(o) => {
        const dateStr = formatDate(o.placedAt, locale);
        return (
          <div className="crm-item cust-item" key={o.id}>
            <div className="crm-item__main">
              <div className="crm-item__title">
                {o.orderNumber ? t("customers.customer.card.orderNumber", { number: o.orderNumber }) : t("customers.customer.card.order")} · {formatMinor(o.totalMinor, o.currency, locale)}
              </div>
              <div className="crm-item__meta">
                <span className="crm-badge">{labelT(t, ORDER_STATUS_LABEL, o.status)}</span>
                <span> · {label(ORDER_SOURCE_LABEL, o.sourceKey)}</span>
                {o.refundedMinor > 0 ? <span> · {t("customers.customer.card.refunded", { amount: formatMinor(o.refundedMinor, o.currency, locale) })}</span> : null}
                {dateStr ? <span> · {dateStr}</span> : null}
              </div>
            </div>
          </div>
        );
      }}
    />
  );
}

/** M7-C — calls with the customer: direction, outcome and time (never a number or a recording). */
function CallsSection({ section }: { section: { items: CustomerCardCall[]; total: number } }) {
  const { t, locale } = useI18n();
  return (
    <HistorySection
      icon={<PhoneIcon />}
      tone="phone"
      title={t("customers.customer.card.sections.calls")}
      section={section}
      renderItem={(c) => {
        const dateStr = formatDate(c.startedAt, locale);
        const owed = c.direction === "inbound" && c.outcome !== "answered" && !c.returnedAt;
        return (
          <div className="crm-item cust-item" key={c.id}>
            <div className="crm-item__main">
              <div className="crm-item__title">{c.direction === "inbound" ? t("customers.customer.card.inboundCall") : t("customers.customer.card.outboundCall")}</div>
              <div className="crm-item__meta">
                <span className="crm-badge">{labelT(t, CALL_OUTCOME_LABEL, c.outcome)}</span>
                {c.outcome === "answered" && c.durationSec > 0 ? <span> · {t("customers.customer.card.durationMinutes", { minutes: Math.max(1, Math.round(c.durationSec / 60)) })}</span> : null}
                {owed ? <span> · {t("customers.customer.card.notReturned")}</span> : c.returnedAt ? <span> · {t("customers.customer.card.returned")}</span> : null}
                {dateStr ? <span> · {dateStr}</span> : null}
              </div>
            </div>
          </div>
        );
      }}
    />
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
  const { t } = useI18n();
  const [name, setName] = useState(customer.name);
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [city, setCity] = useState(customer.city ?? "");
  const [notes, setNotes] = useState(customer.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError(t("customers.customer.form.nameRequired"));
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
      setError(err instanceof Error ? err.message : t("customers.customer.edit.error"));
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
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={t("customers.customer.edit.title")}>
        <h2 className="crm-modal__title">{t("customers.customer.edit.title")}</h2>

        <div className="crm-field">
          <label className="crm-field__label" htmlFor="cust-edit-name">
            {t("customers.customer.form.name")}
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
            {t("customers.customer.form.phone")}
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
            {t("customers.customer.form.email")}
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
            {t("customers.customer.form.city")}
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
            {t("customers.customer.edit.note")}
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
            {saving ? t("customers.customer.form.saving") : t("customers.customer.form.save")}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            {t("customers.customer.form.cancel")}
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
  const { t } = useI18n();
  return (
    <div
      className="crm-modal__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label={t("customers.customer.deactivate.ariaLabel")}>
        <h2 className="crm-modal__title">{t("customers.customer.deactivate.title", { name: customerName })}</h2>
        <p className="crm-panel__body" style={{ marginBottom: 8 }}>
          {t("customers.customer.deactivate.body")}
        </p>

        {error ? <div className="crm-modal__error">{error}</div> : null}

        <div className="crm-modal__actions">
          <button
            type="button"
            className="crm-btn crm-btn--primary crm-btn--full"
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? t("customers.customer.deactivate.saving") : t("customers.customer.deactivate.confirm")}
          </button>
          <button
            type="button"
            className="crm-btn crm-btn--ghost"
            onClick={onCancel}
            disabled={saving}
          >
            {t("customers.customer.form.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
