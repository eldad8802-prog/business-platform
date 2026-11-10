/**
 * "הפקת מסמך" stage 1 end to end — fixtures on the business-documents lab (.business-documents/lab.sh). Synthetic only.
 *   A  business_documents ON, authorized dealer, complete invoice identity, one customer
 *   E  business_documents ON, exempt dealer, complete identity
 *   I  business_documents ON, identity incomplete (the existing identity gate must open)
 *   B  no override (default OFF), complete identity, one customer
 * Writes tokens and ids to $SEED_OUT.  env: OWNER_URL, AUTH_TOKEN_SECRET, SEED_OUT.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const tag = `pe-ui-${Date.now()}`;
  const make = async (key: string, opts: { on: boolean; kind: string | null; complete: boolean }) => {
    const businessId = (await owner.business.create({ data: { name: `עסק בדיקה ${key}` } })).id;
    const userId = (await owner.user.create({ data: { email: `${tag}-${key}@lab.test`, password: "x", businessId } })).id;
    await owner.businessProfile.create({
      data: {
        businessId,
        billingLegalName: `עסק בדיקה ${key} בע"מ`,
        billingBusinessKind: opts.kind,
        billingTaxId: opts.complete ? "515151515" : null,
        billingAddress: opts.complete ? "רחוב הבדיקה 1, תל אביב" : null,
        billingPhone: opts.complete ? "0501234567" : null,
        billingEmail: opts.complete ? `${key}@lab.test` : null,
      },
    });
    if (opts.on) await owner.businessFeatureAccess.create({ data: { businessId, featureKey: "business_documents", state: "ENABLED", reason: "lab: production entry e2e" } });
    const customerId = (await owner.customer.create({ data: { businessId, name: `לקוחה בדיקה ${key}` } })).id;
    return { businessId, token: signAuthToken(userId, 0), customerId };
  };
  const out = {
    A: await make("A", { on: true, kind: "AUTHORIZED_DEALER", complete: true }),
    E: await make("E", { on: true, kind: "EXEMPT_DEALER", complete: true }),
    I: await make("I", { on: true, kind: null, complete: false }),
    B: await make("B", { on: false, kind: "AUTHORIZED_DEALER", complete: true }),
  };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`seeded: ${Object.entries(out).map(([k, v]) => `${k}=${v.businessId}`).join(" ")}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
