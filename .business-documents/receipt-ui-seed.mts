/**
 * Receipt screen end to end — the fixtures, on the Production-shaped business-documents lab (.business-documents/lab.sh
 * --with-bd). Synthetic only. Business A has business_documents ON by a per-business override (as a business-9 pilot
 * would); business B has no override (the default: OFF). A's two issued tax invoices are issued through the REAL billing
 * services AS the runtime role (DATABASE_URL); only the business, users, profile, customers and the override are owner
 * fixtures. Writes session tokens and ids to $SEED_OUT.
 *
 * env: OWNER_URL, DATABASE_URL (runtime), AUTH_TOKEN_SECRET, SEED_OUT.
 */
import { writeFileSync } from "node:fs";
import { BillingDocumentType, PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");

  const tag = `rcpt-ui-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: "עסק פיילוט-בדיקה קבלות" } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "business_documents", state: "ENABLED", reason: "lab: receipt screen e2e" } });
  await owner.businessProfile.create({
    data: {
      businessId: bizA,
      billingLegalName: "עסק סינתטי לבדיקות בע\"מ",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingVatNumber: "999999998",
      billingAddress: "רחוב הבדיקה 1",
      billingPhone: "03-0000000",
      billingEmail: "rcpt-ui@lab.test",
    },
  });
  const customer = (await owner.customer.create({ data: { businessId: bizA, name: "פיילוט-בדיקה-לקוח-01" } })).id;
  const customer2 = (await owner.customer.create({ data: { businessId: bizA, name: "פיילוט-בדיקה-לקוח-02" } })).id;

  // Two issued tax invoices (1,180.00 each) — the existing path, as the runtime role. A RECEIPT never reaches the
  // authority executor; these small invoices do not either, but the stub keeps the lab off the network regardless.
  const stub = { executeApproval: async (input: { billingDocumentId: number }) => ({ outcome: "completed_approved" as const, billingDocumentId: input.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) };
  const lines = [{ description: "שירות סינתטי", quantity: "1", unitPrice: "1000", vatRatePercent: "18" }];
  const invoices: number[] = [];
  for (let i = 0; i < 2; i++) {
    const d = await createBillingDraft({ businessId: bizA, actorUserId: userA, documentType: BillingDocumentType.TAX_INVOICE, customerId: customer, initialLines: lines });
    await issueBillingDocument({ businessId: bizA, billingDocumentId: d.id, actorUserId: userA }, stub as never);
    invoices.push(d.id);
  }

  const out = { tokenA: signAuthToken(userA, 0), tokenB: signAuthToken(userB, 0), bizA, bizB, customer, customer2, invoices };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`seeded: business A ${bizA} (business_documents ON), B ${bizB} (default OFF), invoices ${invoices.join(", ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
