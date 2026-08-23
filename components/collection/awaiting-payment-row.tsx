"use client";

/**
 * Collection · one customer, one row.
 *
 * The row is grouped by customer and not by invoice on purpose: the owner does
 * not send three messages to Moshe about three invoices, he has one
 * conversation with Moshe. The invoice numbers belong inside the message, not
 * in the list.
 *
 * WHAT THE ROW SHOWS: who, how much, since when — a date, never a day count
 * (Constitution, Article 8: no manufactured anxiety). No aging buckets, no red,
 * no "overdue" badge. The screen states a fact; it does not editorialise about
 * the customer.
 *
 * THE ROW STATES (step 5) are SESSION states. They are not persisted, and they
 * are not financial records. They exist so the owner can see what he has
 * already handled while he works through the list; tomorrow the list is fresh.
 *
 * Each name states only what Dubiz actually knows:
 *
 *   idle             — nothing done yet. One primary action: write the message.
 *   opened-whatsapp  — WhatsApp was opened with the message ready. Dubiz does
 *                      NOT know whether it was sent, so the row never claims
 *                      "נשלח" — only that the owner was handed the message.
 *   copied           — the text reached the clipboard. That, and only that.
 *   already-paid     — the owner says this was settled outside Dubiz. It is a
 *                      temporary suppression for this session and NOTHING else:
 *                      no receipt, no allocation, no financial state. The row
 *                      points at the existing receipt flow, which remains the
 *                      only way a payment becomes true.
 *   not-now          — deliberately skipped. It returns next time, quietly.
 */

import { useState } from "react";

import { TOKEN } from "@/lib/design/tokens";
import { WarmButton, WarmCard } from "@/components/ui/warm/warm-primitives";
import { currencySymbol } from "@/lib/services/billing/collection/collection-display";
import type { AwaitingCustomerApi } from "@/lib/services/billing/collection/awaiting-payment.serializer";

const W = TOKEN.warm;

export type RowState =
  | "idle"
  | "opened-whatsapp"
  | "copied"
  | "already-paid"
  | "not-now";

/**
 * What the row says about itself once the owner has acted on it.
 *
 * Every label describes an action Dubiz observed — opening WhatsApp, writing to
 * the clipboard, the owner's own note — and never an outcome it cannot see.
 */
const HANDLED_LABEL: Record<Exclude<RowState, "idle">, string> = {
  "opened-whatsapp": "ההודעה נפתחה בוואטסאפ",
  copied: "ההודעה הועתקה",
  "already-paid": "סומן: כבר שולם",
  "not-now": "לא עכשיו",
};

/** A quiet second line, only where the label alone could be misread. */
const HANDLED_NOTE: Partial<Record<RowState, string>> = {
  "opened-whatsapp": "— לא נדע אם ההודעה נשלחה בסוף",
  "already-paid": "— לא נרשם תשלום. כדי לסגור בספרים, הפיקו קבלה.",
};

export function AwaitingPaymentRow({
  customer,
  state,
  onWriteMessage,
  onMarkAlreadyPaid,
  onNotNow,
}: {
  customer: AwaitingCustomerApi;
  state: RowState;
  onWriteMessage: () => void;
  onMarkAlreadyPaid: () => void;
  onNotNow: () => void;
}) {
  const [showInvoices, setShowInvoices] = useState(false);
  const symbol = currencySymbol(customer.currency);
  const handled = state !== "idle";

  return (
    <WarmCard
      padding={0}
      style={{
        // A handled row recedes; it does not disappear. The owner should be
        // able to see what he already did without re-reading the whole list.
        opacity: handled ? 0.55 : 1,
        transition: "opacity 200ms ease",
      }}
    >
      <div style={{ padding: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: W.ink,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {customer.customerName || "לקוח ללא שם"}
            </div>
            <div style={{ fontSize: 13, color: W.muted, marginTop: 4 }}>
              ממתין מאז {customer.awaitingSinceFormatted}
            </div>
          </div>

          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              color: W.ink,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {customer.totalOutstandingFormatted} {symbol}
          </div>
        </div>

        {customer.invoices.length > 1 && (
          <button
            type="button"
            onClick={() => setShowInvoices((open) => !open)}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              marginTop: 8,
              fontFamily: "inherit",
              fontSize: 13,
              color: W.tealDeep,
              cursor: "pointer",
            }}
          >
            {showInvoices
              ? "הסתר"
              : `${customer.invoices.length} חשבוניות פתוחות`}
          </button>
        )}

        {showInvoices && (
          <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
            {customer.invoices.map((invoice) => (
              <div
                key={invoice.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  fontSize: 13,
                  color: W.muted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>
                  {invoice.documentNumber ? `${invoice.documentNumber} · ` : ""}
                  {invoice.issuedAtFormatted}
                  {invoice.isPartiallySettled ? " · שולם חלקית" : ""}
                </span>
                <span style={{ whiteSpace: "nowrap" }}>
                  {invoice.outstandingFormatted} {symbol}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Stated plainly, because a message that cannot be sent is worse than
            no button at all. */}
        {customer.hasNoContactChannel && !handled && (
          <div style={{ marginTop: 10, fontSize: 13, color: W.muted }}>
            אין טלפון או אימייל ללקוח הזה — אפשר להעתיק את ההודעה ולשלוח בעצמך.
          </div>
        )}
      </div>

      <div
        style={{
          borderTop: `1px solid ${W.line}`,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        {handled ? (
          <>
            <span style={{ fontSize: 14, color: W.muted, fontWeight: 600 }}>
              {HANDLED_LABEL[state as Exclude<RowState, "idle">]}
            </span>
            {HANDLED_NOTE[state] && (
              <span style={{ fontSize: 13, color: W.muted }}>
                {HANDLED_NOTE[state]}
              </span>
            )}
          </>
        ) : (
          <>
            {/* One primary action per row. */}
            <WarmButton height={40} onClick={onWriteMessage}>
              כתוב הודעה
            </WarmButton>
            <WarmButton height={40} variant="text" onClick={onMarkAlreadyPaid}>
              כבר שילם
            </WarmButton>
            <WarmButton height={40} variant="text" onClick={onNotNow}>
              לא עכשיו
            </WarmButton>
          </>
        )}
      </div>
    </WarmCard>
  );
}
