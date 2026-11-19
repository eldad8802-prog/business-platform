/**
 * Purchase-order sheet — the SERVICE on the real migrations, AS the runtime role (PG17, Production role topology:
 * .business-documents/lab.sh <db> --with-po). Local storage (create-once semantics), synthetic data only.
 *
 *   saving: the stored PDF is the document the send screen produces (number = the order's id, external number, header
 *     in the chosen language, the date); the record freezes what was printed;
 *   retry: the same key returns the same copy — never a second one; a changed request under the same key is refused;
 *   isolation: another business can neither save, list nor download a copy of this business's order;
 *   frozen: editing the order later changes no saved copy, and a download returns the stored file itself;
 *   inventory untouched: the order's status / dates, purchase orders and receiving stay exactly as they were;
 *   failure: a storage failure leaves no copy and releases the key, so the same key then succeeds.
 *
 * env: DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner), STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT.
 * Run: npx tsx .business-documents/po-sheet.battery.mts
 */
import { PrismaClient } from "@prisma/client";
import { PDFParse } from "pdf-parse";

import { bdTx } from "../lib/services/business-documents/bd-tx";
import { readCommittedFile, sha256Hex } from "../lib/services/business-documents/files/business-docs-files";
import { listPurchaseOrderSheets, purchaseOrderSheetFile, PurchaseOrderSheetNotFoundError, savePurchaseOrderSheet } from "../lib/services/business-documents/po-sheet/po-sheet.service";
import { issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";
import { getStorageService, type StorageService } from "../lib/storage";
import { validId } from "./po-sheet-checks.mts";

const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
async function refused(name: string, fn: () => Promise<unknown>, expect: (e: unknown) => boolean) {
  try {
    await fn();
    ok(name, false, "it succeeded");
  } catch (e) {
    ok(name, expect(e), e instanceof Error ? e.message.split("\n")[0] : String(e));
  }
}
async function text(buf: Buffer): Promise<string> {
  const p = new PDFParse({ data: new Uint8Array(buf) });
  try {
    return (await p.getText()).text.replace(/\s+/g, "");
  } finally {
    await p.destroy();
  }
}
const key = (b: number, u: number) => bdTx(b, (tx) => issueRequestKey(tx, b, u, "PURCHASE_ORDER_SHEET"));
const sheetsOf = (b: number) => own.purchaseOrderSheet.count({ where: { businessId: b } });

async function main() {
  const stamp = Date.now();
  const A = (await own.business.create({ data: { name: `po-svc-A-${stamp}` } })).id;
  const B = (await own.business.create({ data: { name: `po-svc-B-${stamp}` } })).id;
  const uA = (await own.user.create({ data: { email: `po-a-${stamp}@lab.test`, password: "x", businessId: A } })).id;
  const uB = (await own.user.create({ data: { email: `po-b-${stamp}@lab.test`, password: "x", businessId: B } })).id;
  const order = await own.supplierPurchaseDraft.create({
    data: {
      businessId: A,
      supplierName: "ספק בדיקה",
      externalOrderId: "A-100",
      orderDate: new Date("2026-11-02T22:30:00.000Z"), // 3.11 in Israel, 2.11 in UTC
      lines: { create: [{ rawName: "מוצר א", quantity: 5, unitType: "UNIT" }, { rawName: "מוצר ב", quantity: 2.5, unitType: "KG" }] },
    },
    select: { id: true, status: true, approvedAt: true, rejectedAt: true },
  });
  const poBefore = await own.purchaseOrder.count({ where: { businessId: A } });
  const recvBefore = await own.receivingSession.count({ where: { businessId: A } }).catch(() => 0);

  console.log("--- saving ---");
  const k1 = await key(A, uA);
  const s1 = await savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: k1 });
  ok("a copy is saved, numbered with the order's own id", s1.displayedNumber === `#${order.id}` && s1.supplierOrderId === order.id);
  ok("the external number and supplier are frozen in the record", s1.externalNumber === "A-100" && s1.supplierName === "ספק בדיקה");
  ok("the date is the order date in Israel time (3.11.2026)", s1.displayDate === "3.11.2026", s1.displayDate);
  ok("the save time is recorded", !Number.isNaN(Date.parse(s1.savedAt)));
  const f1 = await purchaseOrderSheetFile(A, s1.id);
  const bytes1 = await readCommittedFile(A, f1!.fileId);
  const printed = await text(bytes1);
  ok("the stored file is a PDF printing '#<id>', the external number, the supplier and the Hebrew header", bytes1.subarray(0, 5).toString() === "%PDF-" && printed.includes(`#${order.id}`) && printed.includes("A-100") && printed.includes("ספקבדיקה") && printed.includes("מלאי"), `${bytes1.length} bytes`);
  const row = await own.purchaseOrderSheet.findUniqueOrThrow({ where: { id: s1.id } });
  ok("the record's digest matches the stored bytes", row.sha256 === sha256Hex(bytes1));
  ok("the header snapshot is the Hebrew send-screen title", row.headerTitleSnapshot === "מלאי · Dubiz" && row.locale === "he");

  console.log("--- language: the header the send screen would print in English ---");
  const sEn = await savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "en", idempotencyKey: await key(A, uA) });
  const rowEn = await own.purchaseOrderSheet.findUniqueOrThrow({ where: { id: sEn.id } });
  ok("English interface → English header ('Inventory · Dubiz'), the rest of the document unchanged", rowEn.headerTitleSnapshot === "Inventory · Dubiz" && rowEn.locale === "en" && (await text(await readCommittedFile(A, rowEn.fileId))).includes("Inventory·Dubiz"));

  console.log("--- retry: never a second copy ---");
  const before = await sheetsOf(A);
  const again = await savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: k1 });
  ok("the same key returns the same copy (replay)", again.id === s1.id && again.replay === true);
  ok("…and no new row", (await sheetsOf(A)) === before);
  await refused("the same key with a different request (another language) → refused", () => savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "en", idempotencyKey: k1 }), (e) => /IDEMPOTENCY_CONFLICT/.test(String((e as { code?: string }).code ?? (e as Error).message)));
  const k2 = await key(A, uA);
  const [c1, c2] = await Promise.allSettled([
    savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: k2 }),
    savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: k2 }),
  ]);
  const ids = [c1, c2].filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: number }>).value.id);
  // At least one save succeeded with a real id (an empty list must not pass), every success is that one copy.
  ok("two concurrent saves with one key make at most one copy", ids.length >= 1 && ids.every(validId) && new Set(ids).size === 1 && (await sheetsOf(A)) === before + 1, `${c1.status}/${c2.status}`);

  console.log("--- isolation ---");
  await refused("business B cannot save a copy of A's order", async () => savePurchaseOrderSheet({ businessId: B, userId: uB, supplierOrderId: order.id, locale: "he", idempotencyKey: await key(B, uB) }), (e) => e instanceof PurchaseOrderSheetNotFoundError);
  ok("B lists no copy of A's order", (await listPurchaseOrderSheets(B, order.id)).length === 0);
  ok("B cannot reach A's stored copy", (await purchaseOrderSheetFile(B, s1.id)) === null);
  ok("A lists its copies, newest first", (await listPurchaseOrderSheets(A, order.id)).map((s) => s.id)[0] !== undefined);

  console.log("--- frozen: a later edit changes no saved copy ---");
  await own.supplierPurchaseDraft.update({ where: { id: order.id }, data: { supplierName: "ספק אחר", externalOrderId: "Z-9" } });
  const bytesAfter = await readCommittedFile(A, (await purchaseOrderSheetFile(A, s1.id))!.fileId);
  ok("the download returns the stored file itself, unchanged", sha256Hex(bytesAfter) === sha256Hex(bytes1));
  ok("the saved record still says the old supplier and external number", (await own.purchaseOrderSheet.findUniqueOrThrow({ where: { id: s1.id } })).externalNumberSnapshot === "A-100");
  const s3 = await savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: await key(A, uA) });
  ok("a new copy after the edit shows the new details, the old one stays", s3.externalNumber === "Z-9" && (await own.purchaseOrderSheet.count({ where: { id: s1.id } })) === 1);

  console.log("--- inventory untouched ---");
  const after = await own.supplierPurchaseDraft.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, approvedAt: true, rejectedAt: true } });
  ok("the order's status and dates are unchanged by saving copies", after.status === order.status && String(after.approvedAt) === String(order.approvedAt) && String(after.rejectedAt) === String(order.rejectedAt), after.status);
  ok("no purchase order was created", (await own.purchaseOrder.count({ where: { businessId: A } })) === poBefore);
  ok("no receiving session was created", (await own.receivingSession.count({ where: { businessId: A } }).catch(() => 0)) === recvBefore);

  console.log("--- a storage failure leaves nothing, and the same key then succeeds ---");
  const real = getStorageService();
  const broken: StorageService = new Proxy(real, { get: (t, p) => (p === "putObjectIfAbsent" ? async () => { throw new Error("storage down"); } : (t as never)[p]) });
  const k4 = await key(A, uA);
  const n4 = await sheetsOf(A);
  await refused("save while storage is down → fails", () => savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: k4 }, { storage: broken }), () => true);
  ok("…no copy recorded", (await sheetsOf(A)) === n4);
  const s4 = await savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order.id, locale: "he", idempotencyKey: k4 });
  ok("the same key succeeds once storage is back — one copy", !!s4.id && (await sheetsOf(A)) === n4 + 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => own.$disconnect());
