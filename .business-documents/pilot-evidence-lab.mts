/**
 * LAB ONLY (PG17 lab from lab.sh, synthetic data) — drives the states that ops/evidence/business-documents-pilot-business-9.sql
 * must tell apart. Never pointed at Production: it refuses unless OWNER_URL is a localhost URL.
 *
 *   seed      business 9 and business 38, a user of 9, an existing supplier order with lines, a stock item + movement
 *   enable    business 9 alone: business_documents ENABLED (the owner's admin-screen switch-on, in the lab)
 *   save      one purchase-order sheet of that order, through the REAL service (local storage) — the phone test
 *   parallel  an unrelated change to business 9's stock (a second movement) — a concurrent change the report must show
 *   extra38   an override of business_documents on business 38 — must be caught
 *
 * env: OWNER_URL (lab owner), DATABASE_URL / DIRECT_URL (lab runtime), STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT
 */
import { PrismaClient } from "@prisma/client";

import { bdTx } from "../lib/services/business-documents/bd-tx";
import { savePurchaseOrderSheet } from "../lib/services/business-documents/po-sheet/po-sheet.service";
import { issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";

const ownerUrl = process.env.OWNER_URL ?? "";
if (!/@localhost:5432\//.test(ownerUrl)) {
  console.log("REFUSED: lab only (OWNER_URL must be a localhost lab database)");
  process.exit(3);
}
const own = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const B9 = 9;
const B38 = 38;

async function seed() {
  // Explicit ids 9 and 38 (as in Production); the sequence moves past them so nothing else takes those ids.
  await own.$executeRawUnsafe(`INSERT INTO "Business" (id, name, "updatedAt") VALUES (${B9}, 'lab nine', now()), (${B38}, 'lab thirty-eight', now())`);
  await own.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Business"', 'id'), 1000)`);
  await own.user.create({ data: { email: "pilot-nine@lab.test", password: "x", businessId: B9 } });
  await own.supplierPurchaseDraft.create({
    data: {
      businessId: B9, supplierName: "ספק בדיקה", externalOrderId: "P-9", orderDate: new Date("2026-11-02T22:30:00.000Z"),
      lines: { create: [{ rawName: "מוצר א", quantity: 5, unitType: "UNIT" }, { rawName: "מוצר ב", quantity: 2, unitType: "UNIT" }] },
    },
  });
  const item = await own.inventoryItem.create({ data: { businessId: B9, name: "פריט בדיקה", unitType: "UNIT" } });
  await own.inventoryMovement.create({ data: { businessId: B9, itemId: item.id, movementType: "IN", reason: "INITIAL_STOCK", quantityDelta: 10, quantityBefore: 0, quantityAfter: 10 } });
}

async function enable(businessId: number, state: "ENABLED" | "DISABLED") {
  await own.businessFeatureAccess.create({ data: { businessId, featureKey: "business_documents", state, reason: "lab" } });
}

async function save() {
  const user = await own.user.findFirstOrThrow({ where: { businessId: B9 }, select: { id: true } });
  const order = await own.supplierPurchaseDraft.findFirstOrThrow({ where: { businessId: B9 }, select: { id: true } });
  const key = await bdTx(B9, (tx) => issueRequestKey(tx, B9, user.id, "PURCHASE_ORDER_SHEET"));
  const s = await savePurchaseOrderSheet({ businessId: B9, userId: user.id, supplierOrderId: order.id, locale: "he", idempotencyKey: key });
  console.log(`saved sheet ${s.id} (replay=${s.replay})`);
}

async function parallel() {
  const item = await own.inventoryItem.findFirstOrThrow({ where: { businessId: B9 }, select: { id: true } });
  await own.inventoryMovement.create({ data: { businessId: B9, itemId: item.id, movementType: "OUT", reason: "MANUAL_REMOVE", quantityDelta: -1, quantityBefore: 10, quantityAfter: 9 } });
}

const step = process.argv[2];
const run: Record<string, () => Promise<void>> = { seed, enable: () => enable(B9, "ENABLED"), save, parallel, extra38: () => enable(B38, "DISABLED") };
if (!run[step]) {
  console.log(`unknown step ${step}`);
  process.exit(2);
}
run[step]()
  .then(() => console.log(`lab step ${step}: done`))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => own.$disconnect());
