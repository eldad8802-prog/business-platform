/**
 * iPhone input zoom probe — fixtures on the business-documents lab (.business-documents/lab.sh). Synthetic only.
 *   M  complete invoice identity, one customer, one supplier, one lead (customers / leads / supplier forms, /business)
 *   N  identity incomplete (the identity gate on the invoices screen)
 * Writes tokens and ids to $SEED_OUT.  env: OWNER_URL, AUTH_TOKEN_SECRET, SEED_OUT.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const tag = `mi-${Date.now()}`;
  const biz = async (key: string, complete: boolean) => {
    const businessId = (await owner.business.create({ data: { name: `עסק בדיקה ${key}` } })).id;
    const userId = (await owner.user.create({ data: { email: `${tag}-${key}@lab.test`, password: "x", businessId } })).id;
    await owner.businessProfile.create({
      data: complete
        ? { businessId, billingLegalName: `עסק בדיקה ${key} בע"מ`, billingBusinessKind: "AUTHORIZED_DEALER", billingTaxId: "515000123", billingAddress: "רחוב הבדיקה 1, תל אביב", billingPhone: "0501234567", billingEmail: `${key}@lab.test` }
        : { businessId },
    });
    return { businessId, token: signAuthToken(userId, 0) };
  };
  const M = await biz("M", true);
  const N = await biz("N", false);
  const customerId = (await owner.customer.create({ data: { businessId: M.businessId, name: "לקוחה בדיקה" } })).id;
  const supplierId = (await owner.supplier.create({ data: { businessId: M.businessId, name: "ספק בדיקה" } })).id;
  const leadId = (await owner.lead.create({ data: { businessId: M.businessId, customerName: "ליד בדיקה", phone: "0501112233" } })).id;
  const out = { M: { ...M, customerId, supplierId, leadId }, N };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`seeded: M=${M.businessId} (customer ${customerId}, supplier ${supplierId}, lead ${leadId}), N=${N.businessId}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
