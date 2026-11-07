/**
 * ר1 — fingerprints of a quote. Pure: no DB, no clock.
 *
 *   quoteContentHash  — the quote itself: number, customer, validity, currency, totals and every line. Events and
 *                       reminders compare against it ("this response was about another version of the quote").
 *                       Deliberately NOT the status, the conversion link or the issuer's letterhead.
 *   renderInputHash   — everything the PDF is rendered from: the snapshot handed to the existing renderer, minus
 *                       its date and actor. The copy is accepted only if a fresh read after the render still yields
 *                       the same value — i.e. the PDF was rendered from rows that are the quote's rows at that point.
 */
import { createHash } from "node:crypto";

import { canonicalJson } from "../requests/business-docs-requests";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const dec = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export type QuoteContentRows = {
  doc: {
    id: number;
    documentNumberFormatted: string | null;
    customerId: number | null;
    customerNameSnapshot: string | null;
    validUntil: Date | null;
    currency: string;
    subtotalAmount: unknown;
    vatAmount: unknown;
    totalAmount: unknown;
  };
  lines: { lineIndex: number; description: string; quantity: unknown; unitPrice: unknown; vatRatePercent: unknown; lineSubtotal: unknown; vatAmount: unknown; lineTotal: unknown }[];
  customer: { id: number; name: string; phone: string | null; email: string | null; city: string | null } | null;
};

export function quoteContentHash(rows: QuoteContentRows): string {
  const { doc, lines, customer } = rows;
  return sha(canonicalJson({
    v: 1,
    id: doc.id,
    number: doc.documentNumberFormatted,
    customerId: doc.customerId,
    customerName: doc.customerNameSnapshot,
    customer: customer && { id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, city: customer.city },
    validUntil: doc.validUntil ? doc.validUntil.toISOString() : null,
    currency: doc.currency,
    totals: { subtotal: dec(doc.subtotalAmount), vat: dec(doc.vatAmount), total: dec(doc.totalAmount) },
    lines: [...lines]
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((l) => ({ i: l.lineIndex, d: l.description, q: dec(l.quantity), p: dec(l.unitPrice), r: dec(l.vatRatePercent), s: dec(l.lineSubtotal), v: dec(l.vatAmount), t: dec(l.lineTotal) })),
  }));
}

/** The render input: the snapshot without the two values that legitimately differ per render (date, actor). */
export function renderInputHash(snapshot: { issuedAt?: unknown; metadata?: unknown } & Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...snapshot };
  delete rest.issuedAt;
  delete rest.metadata;
  return sha(canonicalJson(rest));
}
