/**
 * Purchase-order sheet end to end — the fixtures, on the business-documents lab (.business-documents/lab.sh --with-po).
 * Synthetic only. Business A has business_documents ON by a per-business override; business B has none (default OFF).
 * Each has a supplier order awaiting receipt (the send screen's sharing state). Writes tokens and ids to $SEED_OUT.
 *
 * env: OWNER_URL, AUTH_TOKEN_SECRET, SEED_OUT.
 */
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const tag = `po-ui-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: "עסק פיילוט-בדיקה רכש" } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "business_documents", state: "ENABLED", reason: "lab: purchase-order sheet e2e" } });
  const order = (b: number, supplier: string) =>
    owner.supplierPurchaseDraft.create({
      data: {
        businessId: b,
        supplierName: supplier,
        externalOrderId: "A-100",
        orderDate: new Date("2026-11-02T22:30:00.000Z"),
        status: "PENDING_REVIEW",
        lines: { create: [{ rawName: "מוצר א", quantity: 5, unitType: "UNIT" }, { rawName: "מוצר ב", quantity: 2.5, unitType: "KG" }] },
      },
      select: { id: true },
    });
  const orderA = (await order(bizA, "פיילוט-בדיקה-ספק-01")).id;
  const orderB = (await order(bizB, "ספק של B")).id;
  const out = { tokenA: signAuthToken(userA, 0), tokenB: signAuthToken(userB, 0), bizA, bizB, orderA, orderB };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`seeded: A ${bizA} (business_documents ON) order ${orderA}; B ${bizB} (default OFF) order ${orderB}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => owner.$disconnect());
