/**
 * New business documents — the business_documents quota (subscriptions stage C, decisions 17 / 19). SERVER-ONLY.
 *
 * ATOMIC: one unit is RESERVED (usage_consume under the counter's row lock) BEFORE the document is created, so two
 * parallel requests can never both take the last unit; it is COUNTED when the document exists and RELEASED when the
 * creation failed. A request with an idempotency key reserves `bd:<kind>:<key>`: a replay of it is the same unit
 * (DUPLICATE — never counted twice).
 *
 * Counted ONCE, when a NEW document is created: a billing draft, an invoice converted from a quote, a letter, a
 * supplier order sheet. Issuing a draft, editing it, downloading it, re-rendering its PDF — none of that counts (the
 * same invoice is never counted twice for draft + issue).
 *
 * RECEIPTS (owner 2026-11-24, point 3): a RECEIPT or an INVOICE-RECEIPT draft documents a payment received — a legal
 * duty — but an exemption must not become a way around the quota. So they are COUNTED against the same quota (and
 * shown to the admin as OVER_SHADOW when beyond it) but NEVER refused, until the accountant decides (question ש6).
 * NOT counted at all (legal corrections / the system's own records): credit notes, the receipt the system issues for a
 * payment received, issuing an existing draft, tax-authority decisions — those paths do not call this module.
 */
import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { consumeUsage, quotaExhaustedBody, settleUsage } from "./usage-meter";

export type BusinessDocumentKind = "billing" | "letter" | "po_sheet";

/** Billing document types whose refusal waits on the accountant (decision 11 / point 3). */
export const RECEIPT_LIKE_TYPES: readonly string[] = ["RECEIPT", "TAX_INVOICE_RECEIPT"];

export type BusinessDocumentReservation = {
  /** The 403 to return (ENFORCE, a customer over its quota) — nothing was reserved. */
  denied: NextResponse | null;
  /** The document exists: keep the unit. */
  commit: () => Promise<void>;
  /** The creation failed: give the unit back (a keyed reservation stays — its retry is the same unit). */
  release: () => Promise<void>;
};

export async function reserveBusinessDocument(
  businessId: number,
  opts: { kind: BusinessDocumentKind; source: string; idempotencyKey?: string | null; documentType?: string | null },
): Promise<BusinessDocumentReservation> {
  const keyed = typeof opts.idempotencyKey === "string" && opts.idempotencyKey.trim().length > 0;
  const unitKey = keyed ? `bd:${opts.kind}:${opts.idempotencyKey!.trim().slice(0, 150)}` : `bd:${opts.kind}:${randomUUID()}`;
  const neverRefuse = opts.documentType ? RECEIPT_LIKE_TYPES.includes(opts.documentType) : false;
  // A keyed unit is counted at once (its replay is free and creates nothing new); an unkeyed one is reserved.
  const d = await consumeUsage({ businessId, metric: "business_documents", unitKey, source: opts.source, reserve: !keyed, neverRefuse });
  const reserved = !keyed && d.outcome === "COUNTED";
  return {
    denied: d.allowed ? null : NextResponse.json(quotaExhaustedBody(d), { status: 403, headers: { "Cache-Control": "no-store" } }),
    commit: async () => {
      if (reserved) await settleUsage({ businessId, metric: "business_documents", unitKey, state: "COUNTED" });
    },
    release: async () => {
      if (reserved) await settleUsage({ businessId, metric: "business_documents", unitKey, state: "RELEASED" });
    },
  };
}
