/**
 * Purchase-order sheet against REAL Cloudflare R2 — a DEDICATED TEST BUCKET only (token scoped to that bucket, Object
 * Read & Write). Never the Production bucket or its credentials. The service on the real migrations AS the runtime
 * role (PG17 lab, Production role topology: .business-documents/lab.sh <db> --with-po), the real account deletion.
 *
 *   P1  save → a copy, its object is in the bucket under the business's prefix, byte digest = the record's
 *   P2  it is listed (exactly one)
 *   P3  download (the stored-file read) = the object in the bucket = the record's digest
 *   P4  double click: two saves at once with the same key → one copy, one object
 *   P5  retry with the same key after success → the same copy (replay), still one copy, one object
 *   P6  account deletion (deleteOwnBusinessAccount, the real adapter; its post-commit object stage on this bucket) →
 *       no sheet, no file row, no request row; the PDF is gone — the key holds only the data-free marker; nothing
 *       else under the business's prefix
 *
 * env: R2_TEST_ACCOUNT_ID, R2_TEST_ACCESS_KEY_ID, R2_TEST_SECRET_ACCESS_KEY, R2_TEST_BUCKET (required);
 *      DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner), SUPER_URL (lab superuser — lab infrastructure only:
 *      unique business ids, erase functions the base lab lacks).
 * Refuses to start when the bucket name does not contain "test", or equals R2_BUCKET_NAME (the app's own bucket).
 * Removes the markers it leaves at the end. Run: npx tsx .business-documents/po-sheet-r2.battery.mts
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

import { deleteOwnBusinessAccount, type AccountDeletionStore } from "../lib/services/account/account-deletion.service";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";
import { runAccountStorageErasure } from "../lib/services/account/account-storage-erasure";
import { bdTx } from "../lib/services/business-documents/bd-tx";
import { continueBusinessDocumentsErasure } from "../lib/services/business-documents/erasure/business-docs-erasure";
import { FENCE_MARKER, readCommittedFile, sha256Hex } from "../lib/services/business-documents/files/business-docs-files";
import { listPurchaseOrderSheets, purchaseOrderSheetFile, savePurchaseOrderSheet } from "../lib/services/business-documents/po-sheet/po-sheet.service";
import { BusinessDocumentsRequestError, issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";
import { R2StorageService } from "../lib/storage";
import { mirrorMissingEraseFunctions, uniqueBusinessIds } from "./lab-erase-functions.mts";

const env = (k: string) => (process.env[k] ?? "").trim();
const cfg = { accountId: env("R2_TEST_ACCOUNT_ID"), accessKeyId: env("R2_TEST_ACCESS_KEY_ID"), secretAccessKey: env("R2_TEST_SECRET_ACCESS_KEY"), bucketName: env("R2_TEST_BUCKET") };
if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucketName) {
  console.log("PO-sheet R2 battery NOT RUN: R2_TEST_ACCOUNT_ID / R2_TEST_ACCESS_KEY_ID / R2_TEST_SECRET_ACCESS_KEY / R2_TEST_BUCKET are not set.");
  process.exit(2);
}
if (!/test/i.test(cfg.bucketName) || cfg.bucketName === env("R2_BUCKET_NAME")) {
  console.log(`PO-sheet R2 battery REFUSED: "${cfg.bucketName}" is not a dedicated test bucket.`);
  process.exit(3);
}
if (!env("DATABASE_URL") || !env("OWNER_URL") || !env("SUPER_URL")) {
  console.log("PO-sheet R2 battery NOT RUN: DATABASE_URL / OWNER_URL / SUPER_URL of a --with-po lab are required.");
  process.exit(2);
}

const storage = new R2StorageService({ provider: "r2", signedUrlTtlSeconds: 60, r2: cfg });
const raw = new S3Client({ region: "auto", endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
const own = new PrismaClient({ datasources: { db: { url: env("OWNER_URL") } } });

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

/** Every object under the prefix, read straight from the bucket (not through the app's storage layer). */
async function bucketList(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await raw.send(new ListObjectsV2Command({ Bucket: cfg.bucketName, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
async function bucketGet(key: string): Promise<Buffer> {
  const r = await raw.send(new GetObjectCommand({ Bucket: cfg.bucketName, Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

/** The real deletion adapter, with only its storage seam pointed at the test bucket (as account-erasure.battery does). */
const adapter: AccountDeletionStore = {
  ...prismaAccountDeletionStore,
  async eraseStoredObjects(b) {
    const outcomes = await runAccountStorageErasure(b, [{ module: "business-documents", resume: (id) => continueBusinessDocumentsErasure(id, storage) }]);
    return { complete: outcomes.every((o) => o.done) };
  },
};

let cleanupPrefix = "";
/** Removes everything this run wrote under its business's prefix — also when a check failed or the run threw. */
async function cleanup(prefix: string) {
  if (!prefix) return;
  for (const k of await bucketList(prefix)) await storage.deleteObject(k).catch(() => undefined);
}

async function main() {
  const start = await uniqueBusinessIds(env("SUPER_URL"));
  const mirrored = await mirrorMissingEraseFunctions(env("OWNER_URL"), env("SUPER_URL"));
  console.log(`--- bucket ${cfg.bucketName}; business ids from ${start}; erase functions mirrored: ${mirrored.join(", ") || "none"} ---`);

  const stamp = Date.now();
  const A = (await own.business.create({ data: { name: `po-r2-A-${stamp}` } })).id;
  const uA = (await own.user.create({ data: { email: `po-r2-a-${stamp}@lab.test`, password: "synthetic", businessId: A, role: "USER" } })).id;
  const order = (await own.supplierPurchaseDraft.create({
    data: {
      businessId: A,
      supplierName: "ספק בדיקה R2",
      externalOrderId: "R2-100",
      orderDate: new Date("2026-11-02T22:30:00.000Z"),
      lines: { create: [{ rawName: "מוצר א", quantity: 5, unitType: "UNIT" }, { rawName: "מוצר ב", quantity: 2.5, unitType: "KG" }] },
    },
    select: { id: true },
  })).id;
  const prefix = `biz/${A}/business-docs/`;
  cleanupPrefix = prefix;
  const key = () => bdTx(A, (tx) => issueRequestKey(tx, A, uA, "PURCHASE_ORDER_SHEET"));
  const save = (k: string) => savePurchaseOrderSheet({ businessId: A, userId: uA, supplierOrderId: order, locale: "he", idempotencyKey: k }, { storage });
  const sheets = () => own.purchaseOrderSheet.count({ where: { businessId: A } });
  const pdfObjects = async () => (await bucketList(prefix)).filter((k) => k.startsWith(`${prefix}po-sheets/`));

  console.log("--- P1 save ---");
  const k1 = await key();
  const s1 = await save(k1);
  const file = await purchaseOrderSheetFile(A, s1.id);
  const row = file ? await own.businessDocumentFile.findFirst({ where: { businessId: A, id: file.fileId }, select: { objectKey: true, sha256: true, state: true } }) : null;
  const sheetRow = await own.purchaseOrderSheet.findFirst({ where: { businessId: A, id: s1.id }, select: { sha256: true } });
  ok("a copy is saved, numbered with the order's id", s1.displayedNumber === `#${order}` && !s1.replay);
  ok("its file is COMMITTED under the business's prefix", row?.state === "COMMITTED" && Boolean(row?.objectKey.startsWith(prefix)), row?.objectKey ?? "none");
  const inBucket = row ? await bucketGet(row.objectKey) : Buffer.alloc(0);
  ok("the object is in the bucket and its digest = the file's = the record's", inBucket.length > 0 && sha256Hex(inBucket) === row?.sha256 && row?.sha256 === sheetRow?.sha256, `${inBucket.length} bytes`);
  ok("it is a PDF", inBucket.subarray(0, 5).toString() === "%PDF-");

  console.log("--- P2 listed ---");
  const listed = await listPurchaseOrderSheets(A, order);
  ok("the list holds exactly this copy", listed.length === 1 && listed[0].id === s1.id, `${listed.length}`);

  console.log("--- P3 download = stored ---");
  const downloaded = file ? await readCommittedFile(A, file.fileId, storage) : Buffer.alloc(0);
  ok("the download is byte-identical to the object in the bucket", downloaded.equals(inBucket));

  console.log("--- P4 double click (two saves at once, one key) ---");
  const k2 = await key();
  const both = await Promise.allSettled([save(k2), save(k2)]);
  const won = both.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ id: number }>).value.id);
  const busy = both.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof BusinessDocumentsRequestError && (r as PromiseRejectedResult).reason.code === "IN_PROGRESS").length;
  ok("each click either saved or was told to retry — nothing else", won.length + busy === 2 && won.length >= 1, `saved ${won.length}, retry ${busy}`);
  const again = await save(k2);
  ok("the retry of that click returns the same copy", won.every((id) => id === again.id) && again.replay === true);
  ok("…two copies in all (one per key), two objects", (await sheets()) === 2 && (await pdfObjects()).length === 2, `${await sheets()} / ${(await pdfObjects()).length}`);

  console.log("--- P5 retry with the first key ---");
  const r1 = await save(k1);
  ok("the same copy (replay), never a new one", r1.id === s1.id && r1.replay === true);
  ok("…still two copies, two objects", (await sheets()) === 2 && (await pdfObjects()).length === 2);
  const keys = (await own.businessDocumentFile.findMany({ where: { businessId: A, purpose: "PURCHASE_ORDER_SHEET" }, select: { objectKey: true } })).map((f) => f.objectKey);

  console.log("--- P6 account deletion ---");
  const result = await deleteOwnBusinessAccount(adapter, { businessId: A, actorUserId: uA });
  ok("the deletion completes", result.status === "deleted", result.status);
  const left = { sheets: await sheets(), files: await own.businessDocumentFile.count({ where: { businessId: A } }), requests: await own.businessDocumentRequest.count({ where: { businessId: A } }) };
  ok("no sheet, no file row, no request row is left", left.sheets === 0 && left.files === 0 && left.requests === 0, JSON.stringify(left));
  const after = await bucketList(prefix);
  const markers = await Promise.all(after.map(async (k) => (await bucketGet(k)).equals(FENCE_MARKER)));
  ok("every saved PDF is gone: each key holds only the data-free marker", keys.length === 2 && keys.every((k) => after.includes(k)) && markers.every(Boolean), `${after.length} objects, all markers: ${markers.every(Boolean)}`);
  ok("nothing else is left under the business's prefix", after.every((k) => keys.includes(k)), after.filter((k) => !keys.includes(k)).join(", "));

  // Test cleanup: the markers too (Production keeps them by design; a test bucket does not need them).
  await cleanup(prefix);
  ok("cleanup: the business's prefix is empty", (await bucketList(prefix)).length === 0);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await own.$disconnect();
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup(cleanupPrefix).catch(() => undefined);
  await own.$disconnect().catch(() => undefined);
  process.exit(1);
});
