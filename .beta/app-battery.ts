/**
 * Closed beta — the APPLICATION against the migrated Production-shaped database, as the real roles:
 *   signup plane  AUTH_PLANE_ENABLED=true, AUTH_DATABASE_URL = a LOGIN member of app_auth
 *   tenant plane  DATABASE_URL = app_runtime_prod (NOSUPERUSER NOBYPASSRLS)
 *
 *   S   (the signup transaction itself is proven by .authfix/auth-plane-write-battery.ts) one business
 *       enrolled through the signup plane, one not, and every pre-existing business untouched;
 *   P1  switch on: the enrolled business is restricted (all three capabilities), the public one is not,
 *       and every pre-existing business is not;
 *   P2  switch off: nobody is restricted, the enrolled business included;
 *   G1  the route gate answers 403 FEATURE_COMING_SOON for the enrolled business only;
 *   G2  the issue pre-check reads the real draft: a qualifying tax invoice of the enrolled business → 409,
 *       a non-qualifying one → proceed; the same qualifying draft of a non-enrolled business → proceed.
 *
 * env: OWNER_URL, DATABASE_URL (runtime), AUTH_URL (app_auth login).
 * Synthetic only. ZERO network.
 */
import { PrismaClient, Prisma, BillingDocumentType, CustomerTaxIdType } from "@prisma/client";

import { CLOSED_BETA_COHORT } from "@/lib/beta/beta-cohort";
import { resolveBetaAccess, defaultBetaPolicyDeps } from "@/lib/beta/beta-access-policy";
import { betaGate, betaIssueGate, defaultBetaIssueGateDeps } from "@/lib/beta/beta-gate";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const ON = { ...defaultBetaPolicyDeps, restrictionsOn: () => true };
const OFF = { ...defaultBetaPolicyDeps, restrictionsOn: () => false };
const stamp = Date.now();

async function enrolled(businessId: number): Promise<number> {
  const r = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BusinessBetaEnrollment" WHERE "businessId" = $1`, businessId)) as { c: number }[];
  return r[0].c;
}

async function main() {
  const existing = ((await owner.$queryRawUnsafe(`SELECT id FROM "Business" ORDER BY id`)) as { id: number }[]).map((r) => r.id);
  ok(`S0 ${existing.length} pre-existing businesses, none enrolled`,
    ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BusinessBetaEnrollment"`)) as { c: number }[])[0].c === 0);

  // S — the signup itself is proven by .authfix/auth-plane-write-battery.ts (real createAccount under the
  // shipped auth grants). Here: two new businesses, one enrolled exactly as signup enrolls (app_auth INSERT).
  const mk = async (name: string) =>
    ((await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, name)) as { id: number }[])[0].id;
  const beta = { businessId: await mk("beta app lab") };
  const pub = { businessId: await mk("public app lab") };
  const authDbc = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
  await authDbc.businessBetaEnrollment.createMany({
    data: [{ businessId: beta.businessId, cohort: CLOSED_BETA_COHORT, source: "CLOSED_BETA_SIGNUP", createdAt: new Date() }],
  });
  await authDbc.$disconnect();
  ok("S1 enrolled through the signup plane (createMany, no RETURNING)", (await enrolled(beta.businessId)) === 1);
  ok("S2 the other new business is not enrolled", (await enrolled(pub.businessId)) === 0);

  // P1 / P2
  const b = await resolveBetaAccess(beta.businessId, ON);
  ok("P1a switch on: the enrolled business is restricted on all three", b.restricted && b.comingSoon.META_WHATSAPP && b.comingSoon.META_LEAD_ADS && b.comingSoon.TAX_AUTHORITY);
  const p = await resolveBetaAccess(pub.businessId, ON);
  ok("P1b switch on: a public-signup business is not restricted", !p.restricted);
  let anyExisting = 0;
  for (const id of existing) if ((await resolveBetaAccess(id, ON)).restricted) anyExisting++;
  ok(`P1c switch on: none of the ${existing.length} pre-existing businesses is restricted`, anyExisting === 0);
  ok("P2 switch off: the enrolled business is not restricted", !(await resolveBetaAccess(beta.businessId, OFF)).restricted);

  // G1
  const g = await betaGate(beta.businessId, "META_WHATSAPP", ON);
  ok("G1a gate: enrolled → 403 FEATURE_COMING_SOON", g?.status === 403 && (await g!.json()).code === "FEATURE_COMING_SOON");
  ok("G1b gate: public → proceed", (await betaGate(pub.businessId, "TAX_AUTHORITY", ON)) === null);

  // G2 — real drafts, written by the owner role (the issue pre-check reads them as the tenant).
  async function draft(businessId: number, subtotal: number, taxIdType: CustomerTaxIdType | null) {
    const customer = await owner.customer.create({
      data: { businessId, name: "לקוח", taxId: taxIdType ? "515555555" : null, taxIdType },
      select: { id: true },
    });
    const doc = await owner.billingDocument.create({
      data: {
        businessId, documentType: BillingDocumentType.TAX_INVOICE, customerId: customer.id,
        customerNameSnapshot: "לקוח", currency: "ILS",
        subtotalAmount: new Prisma.Decimal(subtotal), vatAmount: new Prisma.Decimal(subtotal * 0.18),
        totalAmount: new Prisma.Decimal(subtotal * 1.18),
      } as never,
      select: { id: true },
    });
    return doc.id;
  }
  const ISSUE_ON = { ...defaultBetaIssueGateDeps, restrictionsOn: () => true };
  const q1 = await draft(beta.businessId, 6000, CustomerTaxIdType.AUTHORIZED_DEALER);
  const r1 = await betaIssueGate(beta.businessId, q1, ISSUE_ON);
  ok("G2a enrolled + qualifying tax invoice (₪6,000 + VAT to an authorized dealer) → 409", r1?.status === 409);
  const q2 = await draft(beta.businessId, 1000, CustomerTaxIdType.AUTHORIZED_DEALER);
  ok("G2b enrolled + under the threshold → proceed", (await betaIssueGate(beta.businessId, q2, ISSUE_ON)) === null);
  const q3 = await draft(beta.businessId, 6000, CustomerTaxIdType.PRIVATE_ID);
  ok("G2c enrolled + private customer → proceed", (await betaIssueGate(beta.businessId, q3, ISSUE_ON)) === null);
  const q4 = await draft(pub.businessId, 6000, CustomerTaxIdType.AUTHORIZED_DEALER);
  ok("G2d NOT enrolled + qualifying → proceed (the normal issue path)", (await betaIssueGate(pub.businessId, q4, ISSUE_ON)) === null);
  ok("G2e enrolled + another business's draft id → proceed (tenant read finds nothing; the issue answers 404)",
    (await betaIssueGate(beta.businessId, q4, ISSUE_ON)) === null);
  const docs = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "BillingDocument" WHERE id = ANY($1::int[]) AND status::text <> 'DRAFT'`, [q1, q2, q3, q4])) as { c: number }[];
  ok("G2f the pre-check wrote nothing: every draft is still a draft", docs[0].c === 0);

  console.log(`\nclosed beta app battery: ${pass} PASS, ${failures.length} FAIL`);
  await owner.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
