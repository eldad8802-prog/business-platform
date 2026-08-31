"use client";

/**
 * Collection · the approval moment.
 *
 * The message is written for the owner, but it is never sent for him. He sees
 * the exact text, can edit it, and then sends it himself. That is not caution
 * about bugs — it is the trust contract: Dubiz does not speak to a customer in
 * the owner's name without him reading the words first.
 *
 * WhatsApp — the channel Israeli SMBs actually use — is reached through a deep
 * link the owner completes in WhatsApp itself. Dubiz therefore knows it OPENED
 * the message, never that it was sent, and both the callback and the label say
 * exactly that. Copy is always available, because a link that fails must never
 * be the only way out.
 */

import { useEffect, useMemo, useState } from "react";

import { TOKEN } from "@/lib/design/tokens";
import { WarmButton } from "@/components/ui/warm/warm-primitives";
import { buildCollectionMessage } from "@/lib/services/billing/collection/collection-message";
import {
  currencySymbol,
  toWhatsAppNumber,
} from "@/lib/services/billing/collection/collection-display";
import type { AwaitingCustomerApi } from "@/lib/services/billing/collection/awaiting-payment.serializer";

const W = TOKEN.warm;

export function CollectionMessageSheet({
  customer,
  businessName,
  onOpenedWhatsApp,
  onCopied,
  onClose,
}: {
  customer: AwaitingCustomerApi;
  businessName: string;
  /** WhatsApp was opened with the message ready — NOT that it was sent. */
  onOpenedWhatsApp: () => void;
  /** The text reached the clipboard. */
  onCopied: () => void;
  onClose: () => void;
}) {
  const symbol = currencySymbol(customer.currency);

  const initialMessage = useMemo(
    () =>
      buildCollectionMessage({
        customerName: customer.customerName,
        totalAmount: customer.totalOutstandingFormatted,
        currencySymbol: symbol,
        businessName,
        invoices: customer.invoices.map((invoice) => ({
          documentNumber: invoice.documentNumber,
          amount: invoice.outstandingFormatted,
          issuedOn: new Date(invoice.issuedAt),
        })),
      }),
    [customer, businessName, symbol],
  );

  const [message, setMessage] = useState(initialMessage);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const whatsAppNumber = toWhatsAppNumber(customer.customerPhone);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      // Reported only on success — a failed clipboard write must not mark the
      // row as handled.
      onCopied();
    } catch {
      setCopied(false);
    }
  };

  const openWhatsApp = () => {
    if (!whatsAppNumber) return;
    window.open(
      `https://wa.me/${whatsAppNumber}?text=${encodeURIComponent(message)}`,
      "_blank",
      "noopener,noreferrer",
    );
    // We opened WhatsApp with the message ready. Whether it was then sent
    // happens inside WhatsApp, where Dubiz cannot see — so that is all we claim.
    onOpenedWhatsApp();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`הודעה ל${customer.customerName}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(35, 48, 43, 0.45)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 60,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: W.surface,
          borderRadius: `${W.radius.card}px ${W.radius.card}px 0 0`,
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          boxShadow: W.shadowHover,
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600, color: W.ink }}>
          הודעה ל{customer.customerName || "לקוח"}
        </div>
        <div style={{ fontSize: 13, color: W.muted, marginTop: 4 }}>
          {customer.totalOutstandingFormatted} {symbol} · אפשר לערוך לפני שליחה
        </div>

        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={10}
          dir="rtl"
          style={{
            width: "100%",
            marginTop: 14,
            padding: 14,
            background: W.canvas,
            border: `1px solid ${W.line}`,
            borderRadius: W.radius.control,
            fontFamily: "inherit",
            fontSize: 15,
            lineHeight: 1.6,
            color: W.ink,
            resize: "vertical",
          }}
        />

        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 14,
            flexWrap: "wrap",
          }}
        >
          {whatsAppNumber ? (
            /* "פתח" and not "שלח" — the send happens in WhatsApp, by the owner. */
            <WarmButton onClick={openWhatsApp} style={{ flex: "1 1 200px" }}>
              פתח בוואטסאפ
            </WarmButton>
          ) : (
            <div style={{ flex: "1 1 200px", fontSize: 13, color: W.muted }}>
              אין מספר טלפון שמור ללקוח הזה — העתיקו את ההודעה ושלחו בעצמכם.
            </div>
          )}
          <WarmButton variant="secondary" onClick={copy}>
            {copied ? "הועתק" : "העתק"}
          </WarmButton>
          <WarmButton variant="text" onClick={onClose}>
            סגור
          </WarmButton>
        </div>
      </div>
    </div>
  );
}
