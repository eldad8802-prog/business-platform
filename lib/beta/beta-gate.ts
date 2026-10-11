/**
 * Server-side enforcement of the beta access policy (./beta-access-policy.ts).
 *
 * Each gated entry point calls ONE function here before it does anything else of its own. With the
 * switch off, or for a business that is not in the beta, every function returns null without a database
 * read beyond the enrollment lookup (and none at all with the switch off) — the route then runs exactly
 * as it did before this module existed.
 *
 * Gated entry points (and only these — the coverage test pins the list):
 *   META_WHATSAPP  POST /api/integrations/whatsapp/embedded-signup
 *   META_LEAD_ADS  POST /api/integrations/acquisition/meta/pages, POST /api/integrations/acquisition/meta/connect
 *   TAX_AUTHORITY  GET  /api/taxes/oauth/connect, POST /api/billing/documents/[id]/authority-decision,
 *                  POST /api/billing/documents/[id]/issue (only a tax invoice that would need an
 *                  allocation number — see betaIssueGate)
 * Deliberately NOT gated: status reads, disconnect, Meta data deletion, acquisition revoke / pause, the
 * inbound webhooks (a beta business cannot hold a connection, because connecting is refused), the OAuth
 * callback (reachable only through the refused connect), and the public privacy / data-deletion pages.
 */

import { NextResponse } from "next/server";

import { BillingAuthoritySubmissionStatus, BillingDocumentType, CustomerTaxIdType, Prisma } from "@prisma/client";
import { runWithTenantContext } from "@/lib/tenant/context";
import { withTenantTransaction } from "@/lib/tenant/transaction";
import { evaluateAuthorityReadinessAtIssue } from "@/lib/services/billing/authority/billing-authority-readiness";
import {
  defaultBetaPolicyDeps,
  resolveBetaAccess,
  type BetaGatedCapability,
  type BetaPolicyDeps,
} from "./beta-access-policy";

export const FEATURE_COMING_SOON_CODE = "FEATURE_COMING_SOON" as const;
export const BETA_ALLOCATION_COMING_SOON_CODE = "BETA_ALLOCATION_COMING_SOON" as const;

export const COMING_SOON_MESSAGE_HE: Record<BetaGatedCapability, string> = {
  META_WHATSAPP: "חיבור WhatsApp Business ייפתח בקרוב.",
  META_LEAD_ADS: "חיבור לידים מפייסבוק ואינסטגרם ייפתח בקרוב.",
  TAX_AUTHORITY: "החיבור לרשות המסים ייפתח בקרוב.",
};

export const BETA_ALLOCATION_MESSAGE_HE =
  "חשבונית מס שמחייבת מספר הקצאה מרשות המסים תתאפשר בקרוב. אפשר להמשיך לעבוד עם הטיוטה, או להפיק מסמך שאינו מחייב מספר הקצאה.";

export function comingSoonResponse(capability: BetaGatedCapability): NextResponse {
  return NextResponse.json(
    { error: COMING_SOON_MESSAGE_HE[capability], code: FEATURE_COMING_SOON_CODE, capability },
    { status: 403, headers: { "Cache-Control": "no-store" } }
  );
}

/** null = proceed as before; a response = refuse with "בקרוב". */
export async function betaGate(
  businessId: number,
  capability: BetaGatedCapability,
  deps: BetaPolicyDeps = defaultBetaPolicyDeps
): Promise<NextResponse | null> {
  const access = await resolveBetaAccess(businessId, deps);
  return access.comingSoon[capability] ? comingSoonResponse(capability) : null;
}

/** What the issue pre-check reads about the draft — exactly the inputs the issue itself hands readiness. */
export type IssueReadinessDraft = {
  documentType: BillingDocumentType;
  vatAmount: Prisma.Decimal;
  subtotalAmount: Prisma.Decimal;
  currency: string;
  customerTaxId: string | null;
  customerTaxIdType: CustomerTaxIdType | null;
};

export type BetaIssueGateDeps = BetaPolicyDeps & {
  /** The draft, tenant-scoped; null when not found (the issue itself then answers 404). */
  loadDraft: (businessId: number, billingDocumentId: number) => Promise<IssueReadinessDraft | null>;
  now: () => Date;
};

async function loadDraftTenant(businessId: number, billingDocumentId: number): Promise<IssueReadinessDraft | null> {
  return runWithTenantContext({ businessId }, () =>
    withTenantTransaction(async (tx) => {
      const doc = await tx.billingDocument.findFirst({
        where: { id: billingDocumentId, businessId },
        select: {
          documentType: true,
          vatAmount: true,
          subtotalAmount: true,
          currency: true,
          customerId: true,
        },
      });
      if (!doc) return null;
      const customer =
        doc.customerId === null
          ? null
          : await tx.customer.findFirst({
              where: { id: doc.customerId, businessId },
              select: { taxId: true, taxIdType: true },
            });
      return {
        documentType: doc.documentType,
        vatAmount: doc.vatAmount,
        subtotalAmount: doc.subtotalAmount,
        currency: doc.currency,
        customerTaxId: customer?.taxId ?? null,
        customerTaxIdType: customer?.taxIdType ?? null,
      };
    })
  );
}

export const defaultBetaIssueGateDeps: BetaIssueGateDeps = {
  ...defaultBetaPolicyDeps,
  loadDraft: loadDraftTenant,
  now: () => new Date(),
};

/**
 * Before a beta business issues a document: would it need an allocation number? If so, refuse BEFORE
 * anything is written — no number consumed, no document locked, nothing sent to the Tax Authority —
 * because without a Tax Authority connection such an invoice could be issued but never delivered.
 *
 * It asks the Tax Authority rules the question; it does not restate them. `evaluateAuthorityReadinessAtIssue`
 * is the same pure function the issue transaction calls, fed the same inputs (document type, stored totals,
 * currency, the customer's tax id and its type, the issue date). Nothing about the rules, the submission,
 * the delivery guard or any issued document changes.
 *
 * Every document that would be NOT_REQUIRED (receipts, credit notes, quotes, tax invoices under the
 * threshold, to a private customer, without VAT or not in ILS) issues exactly as before.
 */
export async function betaIssueGate(
  businessId: number,
  billingDocumentId: number,
  deps: BetaIssueGateDeps = defaultBetaIssueGateDeps
): Promise<NextResponse | null> {
  const access = await resolveBetaAccess(businessId, deps);
  if (!access.comingSoon.TAX_AUTHORITY) return null;

  const draft = await deps.loadDraft(businessId, billingDocumentId);
  if (!draft) return null;

  const status = evaluateAuthorityReadinessAtIssue({
    documentType: draft.documentType,
    invoiceDate: deps.now(),
    vatAmount: draft.vatAmount,
    subtotalAmount: draft.subtotalAmount,
    currency: draft.currency,
    customerTaxIdType: draft.customerTaxIdType,
    customerTaxId: draft.customerTaxId,
  });
  if (status !== BillingAuthoritySubmissionStatus.READY) return null;

  return NextResponse.json(
    {
      error: BETA_ALLOCATION_MESSAGE_HE,
      code: BETA_ALLOCATION_COMING_SOON_CODE,
      capability: "TAX_AUTHORITY",
    },
    { status: 409, headers: { "Cache-Control": "no-store" } }
  );
}
