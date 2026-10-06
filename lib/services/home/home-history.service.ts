/**
 * Home history — "has this business ever had a real event of this kind?"
 *
 * One read, one round trip: a single SELECT of EXISTS sub-queries inside
 * tenantTx. Every sub-query names the business explicitly (`"businessId" = $1`)
 * AND runs under the tenant GUC, so RLS stays a second, independent guard.
 * Each EXISTS stops at the first matching row and rides an index that leads
 * with businessId (noted beside it).
 *
 * The predicates are business events, not technical rows. What each one counts:
 *
 *   income        money that really came in: a provider payment that settled
 *                 (PAID, amount > 0 — refund reversals are stored as PAID with a
 *                 negative amount), an ISSUED receipt / tax-invoice-receipt, or
 *                 an approved income document. A tax invoice alone is a bill, not
 *                 money in, so it does not count.
 *   expenses      money that really went out or an expense the owner confirmed:
 *                 a RECORDED payment (a VOID one was undone) or an approved
 *                 expense document. FinancialRecord rows are written only by the
 *                 approve flow, so uploads that never got approved cannot count.
 *   obligations   the owner registered a commitment or an obligation (any state).
 *   collection    the owner created a payment request — in any status: a
 *                 cancelled or expired request still means collection was used.
 *   documents     a real document was received: status needs_review or approved.
 *                 `processing` (still being read) and `failed` (could not be
 *                 read) do not count; duplicates are refused before a row exists.
 *   leads         any lead (all are owner-created or owner-confirmed).
 *   conversations a message was exchanged: any inbound message, or an outbound
 *                 one that did not fail to send. Read on Message because
 *                 Conversation has no businessId-leading index (a scan) and
 *                 Message does ("Message_businessId_id_key").
 *   inventory     the owner added an item (active or later deactivated).
 *   insights      Dubiz has produced an insight (any status). The composer only
 *                 writes one from real facts — there are no default insights.
 *   identityDescription  an ACTIVE owner description with text.
 */

import { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";

import { whatsAppHomeState, type HomeHistory } from "./home-history-model";

type Row = {
  income: boolean;
  expenses: boolean;
  obligations: boolean;
  collection: boolean;
  documents: boolean;
  leads: boolean;
  conversations: boolean;
  inventory: boolean;
  insights: boolean;
  identity_description: boolean;
  whatsapp_status: string | null;
};

export function homeHistorySql(businessId: number): Prisma.Sql {
  const b = businessId;
  return Prisma.sql`
    SELECT
      -- PaymentRequest_businessId_status_idx → PaymentTransaction_paymentRequestId_idx
      ( EXISTS (SELECT 1 FROM "PaymentRequest" pr
                JOIN "PaymentTransaction" pt ON pt."paymentRequestId" = pr."id"
                WHERE pr."businessId" = ${b} AND pt."status" = 'PAID' AND pt."amount" > 0)
        -- BillingDocument_businessId_status_issuedAt_idx
        OR EXISTS (SELECT 1 FROM "BillingDocument"
                   WHERE "businessId" = ${b} AND "status" = 'ISSUED'
                     AND "documentType" IN ('RECEIPT', 'TAX_INVOICE_RECEIPT'))
        -- FinancialRecord_businessId_date_idx
        OR EXISTS (SELECT 1 FROM "FinancialRecord"
                   WHERE "businessId" = ${b} AND "direction" = 'income' AND "amount" > 0)
      ) AS "income",
      -- Payment_businessId_status_idx / FinancialRecord_businessId_date_idx
      ( EXISTS (SELECT 1 FROM "Payment" WHERE "businessId" = ${b} AND "status" = 'RECORDED')
        OR EXISTS (SELECT 1 FROM "FinancialRecord"
                   WHERE "businessId" = ${b} AND "direction" = 'expense' AND "amount" > 0)
      ) AS "expenses",
      -- Commitment_businessId_status_idx / BusinessObligation_businessId_state_idx
      ( EXISTS (SELECT 1 FROM "Commitment" WHERE "businessId" = ${b})
        OR EXISTS (SELECT 1 FROM "BusinessObligation" WHERE "businessId" = ${b})
      ) AS "obligations",
      -- PaymentRequest_businessId_createdAt_idx
      EXISTS (SELECT 1 FROM "PaymentRequest" WHERE "businessId" = ${b}) AS "collection",
      -- Document_businessId_status_createdAt_idx
      EXISTS (SELECT 1 FROM "Document"
              WHERE "businessId" = ${b} AND "status" IN ('needs_review', 'approved')) AS "documents",
      -- Lead_businessId_status_nextFollowUpAt_idx
      EXISTS (SELECT 1 FROM "Lead" WHERE "businessId" = ${b}) AS "leads",
      -- Message_businessId_id_key
      EXISTS (SELECT 1 FROM "Message"
              WHERE "businessId" = ${b}
                AND ("direction" = 'INBOUND' OR "sendStatus" IS DISTINCT FROM 'FAILED')) AS "conversations",
      -- InventoryItem_businessId_isActive_idx
      EXISTS (SELECT 1 FROM "InventoryItem" WHERE "businessId" = ${b}) AS "inventory",
      -- BusinessInsight_businessId_status_idx
      EXISTS (SELECT 1 FROM "BusinessInsight" WHERE "businessId" = ${b}) AS "insights",
      -- BusinessIdentityStatement_businessId_status_dimension_idx
      EXISTS (SELECT 1 FROM "BusinessIdentityStatement"
              WHERE "businessId" = ${b} AND "status" = 'ACTIVE' AND "dimension" = 'DESCRIPTION'
                AND "text" IS NOT NULL AND length(btrim("text")) > 0) AS "identity_description",
      -- WhatsAppConnection_businessId_key (unique)
      (SELECT "status"::text FROM "WhatsAppConnection" WHERE "businessId" = ${b}) AS "whatsapp_status"
  `;
}

export async function loadHomeHistory(businessId: number): Promise<HomeHistory> {
  if (!Number.isInteger(businessId) || businessId <= 0) throw new Error("invalid_business");
  const rows = await tenantTx(businessId, (tx) => tx.$queryRaw<Row[]>(homeHistorySql(businessId)));
  const r = rows[0];
  if (!r) throw new Error("home_history_empty");
  return {
    income: r.income === true,
    expenses: r.expenses === true,
    obligations: r.obligations === true,
    collection: r.collection === true,
    documents: r.documents === true,
    leads: r.leads === true,
    conversations: r.conversations === true,
    inventory: r.inventory === true,
    insights: r.insights === true,
    identityDescription: r.identity_description === true,
    whatsapp: whatsAppHomeState(r.whatsapp_status),
  };
}
