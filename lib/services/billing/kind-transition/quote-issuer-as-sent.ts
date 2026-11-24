/**
 * 4a T3 — a quote sent while the business was an exempt dealer keeps the issuer details it was sent with after
 * "מעבר לעוסק מורשה" (owner decision 2026-11-24). A quote's PDF is rendered from the live profile on every download
 * (existing behaviour, unchanged). On path A the transition changes only the kind and the VAT number
 * (billingVatNumber: null → the id number), and a quote's snapshot carries the VAT number only (as "עוסק מורשה" when
 * set), not the kind. So the exact pre-transition issuer of such a quote = the live profile with billingVatNumber = null.
 *
 * "Sent before the transition" = the quote's FIRST BILLING_QUOTE_PDF_RENDERED event (written at the first render since
 * the quote MVP, 2026-05-11) happened before the transition's confirmedAt. No transition → nothing changes. No such
 * event (never rendered, or a best-effort write that failed) → nothing is guessed: the live profile is used, as today.
 * A quote first rendered after the transition uses the updated details. Read only; nothing is stored.
 */
import type { Prisma } from "@prisma/client";

type Tx = Pick<Prisma.TransactionClient, "businessKindTransition" | "billingAuditEvent">;

export type QuoteIssuerDecision =
  | { asSent: false; reason: "NO_TRANSITION" | "NO_RENDER_EVENT" | "FIRST_RENDERED_AFTER_TRANSITION" | "NOT_FROM_EXEMPT" }
  | { asSent: true; reason: "FIRST_RENDERED_BEFORE_TRANSITION"; firstRenderedAt: string; transitionConfirmedAt: string };

export async function decideQuoteIssuerAsSentTx(tx: Tx, args: { businessId: number; quoteId: number }): Promise<QuoteIssuerDecision> {
  const transition = await tx.businessKindTransition.findUnique({ where: { businessId: args.businessId }, select: { fromKind: true, confirmedAt: true } });
  if (!transition) return { asSent: false, reason: "NO_TRANSITION" };
  if (transition.fromKind !== "EXEMPT_DEALER") return { asSent: false, reason: "NOT_FROM_EXEMPT" };
  const first = await tx.billingAuditEvent.findFirst({
    where: { businessId: args.businessId, billingDocumentId: args.quoteId, eventType: "BILLING_QUOTE_PDF_RENDERED" },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: { occurredAt: true },
  });
  if (!first) return { asSent: false, reason: "NO_RENDER_EVENT" };
  if (!(first.occurredAt < transition.confirmedAt)) return { asSent: false, reason: "FIRST_RENDERED_AFTER_TRANSITION" };
  return { asSent: true, reason: "FIRST_RENDERED_BEFORE_TRANSITION", firstRenderedAt: first.occurredAt.toISOString(), transitionConfirmedAt: transition.confirmedAt.toISOString() };
}

/** The profile a quote's PDF is rendered from: unchanged, or the pre-transition one (no VAT number). */
export function applyQuoteIssuerAsSent<B extends { profile: { billingVatNumber: string | null } | null }>(business: B, decision: QuoteIssuerDecision): B {
  if (!decision.asSent || !business.profile) return business;
  return { ...business, profile: { ...business.profile, billingVatNumber: null } };
}
