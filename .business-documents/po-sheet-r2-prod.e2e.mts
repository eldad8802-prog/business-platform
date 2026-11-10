/**
 * Purchase-order sheet — the REAL APP IN PRODUCTION MODE (`next build` + `next start`, NODE_ENV=production) on the PG17
 * lab, storing in the DEDICATED R2 TEST BUCKET (the app's own R2_* settings point at it). Synthetic data only.
 *
 *   E1  the server issues a key; save → 201; the copy is listed (exactly one)
 *   E2  download = the object in the bucket (read straight from R2) = the recorded digest; it is a PDF
 *   E3  double click: two saves at once with one key → one copy; the retry of that click → the same copy (200)
 *   E4  retry with the first key → the same copy (200), still two copies (one per key), two objects
 *   E5  a business without the feature → 404 (list and save)
 *   E6  account deletion through the app (DELETE /api/account) → deleted; no sheet / file / request row; each saved
 *       key holds only the data-free marker; nothing else under the business's prefix
 *   then the run removes what it left in the test bucket (also when a check failed).
 *
 * env: E2E_BASE, OWNER_URL, SUPER_URL, AUTH_TOKEN_SECRET; R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *      R2_BUCKET_NAME — the TEST bucket (refused unless its name contains "test").
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";

import { mirrorMissingEraseFunctions, uniqueBusinessIds } from "./lab-erase-functions.mts";
import { sameCopy } from "./po-sheet-checks.mts";

const env = (k: string) => (process.env[k] ?? "").trim();
const BASE = env("E2E_BASE");
const bucket = env("R2_BUCKET_NAME");
if (!/test/i.test(bucket)) {
  console.log(`REFUSED: R2_BUCKET_NAME "${bucket}" is not a dedicated test bucket.`);
  process.exit(3);
}
const raw = new S3Client({ region: "auto", endpoint: `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`, credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") } });
const own = new PrismaClient({ datasources: { db: { url: env("OWNER_URL") } } });
const FENCE_MARKER = Buffer.from("dubiz:fenced\n", "utf8");

let passed = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) passed++; else failures.push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

async function bucketList(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await raw.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}
const bucketGet = async (key: string) => Buffer.from(await (await raw.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray());
const sha = async (b: Buffer) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex");

let cleanupPrefixes: string[] = [];
async function cleanup() {
  for (const p of cleanupPrefixes) for (const k of await bucketList(p)) await raw.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })).catch(() => undefined);
}

async function main() {
  const start = await uniqueBusinessIds(env("SUPER_URL"));
  const mirrored = await mirrorMissingEraseFunctions(env("OWNER_URL"), env("SUPER_URL"));
  console.log(`bucket ${bucket}; business ids from ${start}; erase functions mirrored: ${mirrored.join(", ") || "none"}`);

  const { signAuthToken } = await import("@/lib/auth-token");
  const stamp = Date.now();
  const A = (await own.business.create({ data: { name: `po-r2-prod-A-${stamp}` } })).id;
  const B = (await own.business.create({ data: { name: `po-r2-prod-B-${stamp}` } })).id;
  const uA = (await own.user.create({ data: { email: `po-r2-prod-a-${stamp}@lab.test`, password: "synthetic", businessId: A, role: "USER" } })).id;
  const uB = (await own.user.create({ data: { email: `po-r2-prod-b-${stamp}@lab.test`, password: "synthetic", businessId: B, role: "USER" } })).id;
  await own.businessFeatureAccess.create({ data: { businessId: A, featureKey: "business_documents", state: "ENABLED", reason: "lab: purchase-order sheet production-mode R2 run" } });
  const order = (b: number) => own.supplierPurchaseDraft.create({
    data: { businessId: b, supplierName: "ספק בדיקה R2", externalOrderId: "R2-200", orderDate: new Date("2026-11-02T22:30:00.000Z"), status: "PENDING_REVIEW", lines: { create: [{ rawName: "מוצר א", quantity: 5, unitType: "UNIT" }] } },
    select: { id: true },
  });
  const oA = (await order(A)).id;
  const oB = (await order(B)).id;
  const tA = signAuthToken(uA, 0);
  const tB = signAuthToken(uB, 0);
  const prefix = `biz/${A}/business-docs/`;
  cleanupPrefixes = [prefix, `biz/${B}/business-docs/`];
  const sheetsPath = `/api/business-documents/supplier-orders/${oA}/sheets`;
  const issue = async () => {
    const r = await api("/api/business-documents/requests", tA, { method: "POST", body: JSON.stringify({ operation: "PURCHASE_ORDER_SHEET" }) });
    return r.ok ? ((await r.json()) as { idempotencyKey: string }).idempotencyKey : "";
  };
  const save = (k: string) => api(sheetsPath, tA, { method: "POST", body: JSON.stringify({ idempotencyKey: k, locale: "he" }) });
  const sheets = () => own.purchaseOrderSheet.count({ where: { businessId: A } });
  const pdfObjects = async () => (await bucketList(`${prefix}po-sheets/`)).length;

  console.log("--- E1 save, list ---");
  const k1 = await issue();
  const s1 = await save(k1);
  const v1 = s1.status === 201 ? ((await s1.json()) as { id: number }) : null;
  ok("E1 the server issues a key and the save answers 201", k1.length > 0 && s1.status === 201 && Boolean(v1?.id), `${s1.status}`);
  const l = await api(sheetsPath, tA);
  const lj = l.status === 200 ? ((await l.json()) as { sheets: { id: number }[] }) : null;
  ok("E1 the copy is listed (exactly one)", lj?.sheets.length === 1 && sameCopy([{ status: s1.status, id: v1?.id, ok: [201] }, { status: l.status, id: lj.sheets[0].id, ok: [200] }]), `${l.status} ${lj?.sheets.length}`);

  console.log("--- E2 download = the object in the bucket ---");
  const d = await api(`/api/business-documents/po-sheets/${v1?.id}/pdf`, tA);
  const bytes = Buffer.from(await d.arrayBuffer());
  const rec = await own.purchaseOrderSheet.findFirst({ where: { businessId: A, id: v1?.id ?? 0 }, select: { sha256: true, fileId: true } });
  const fileRow = rec ? await own.businessDocumentFile.findFirst({ where: { id: rec.fileId }, select: { objectKey: true } }) : null;
  const stored = fileRow ? await bucketGet(fileRow.objectKey) : Buffer.alloc(0);
  ok("E2 the download is the object in the bucket, byte for byte, and matches the recorded digest", d.status === 200 && bytes.equals(stored) && (await sha(bytes)) === rec?.sha256, `${d.status}, ${bytes.length} bytes`);
  ok("E2 it is a PDF served as a private attachment", bytes.subarray(0, 5).toString() === "%PDF-" && /attachment/.test(d.headers.get("content-disposition") ?? "") && /no-store/.test(d.headers.get("cache-control") ?? ""));

  console.log("--- E3 double click ---");
  const k2 = await issue();
  const both = await Promise.all([save(k2), save(k2)]);
  const statuses = both.map((r) => r.status);
  ok("E3 two saves at once: each saved, replayed or was told to retry (409) — nothing else", statuses.every((s) => s === 201 || s === 200 || s === 409) && statuses.some((s) => s === 201), statuses.join(","));
  const won = await Promise.all(both.filter((r) => r.status === 201 || r.status === 200).map(async (r) => ({ status: r.status, id: ((await r.json()) as { id?: unknown }).id, ok: [201, 200] })));
  const retry2 = await save(k2);
  const rv2 = retry2.status === 200 ? ((await retry2.json()) as { id?: unknown }) : null;
  // At least one click saved (two answers to compare), every saved click and the retry carry the same real id.
  ok("E3 the retry of that click returns the same copy (200)", sameCopy([...won, { status: retry2.status, id: rv2?.id, ok: [200] }]), `${retry2.status}, saved ${won.length}`);

  console.log("--- E4 retry with the first key ---");
  const retry1 = await save(k1);
  const rv1 = retry1.status === 200 ? ((await retry1.json()) as { id?: unknown }) : null;
  ok("E4 the same copy as the first save (200)", sameCopy([{ status: s1.status, id: v1?.id, ok: [201] }, { status: retry1.status, id: rv1?.id, ok: [200] }]), `${s1.status} → ${retry1.status}`);
  ok("E4 two copies in all (one per key), two objects in the bucket", (await sheets()) === 2 && (await pdfObjects()) === 2, `${await sheets()} / ${await pdfObjects()}`);

  console.log("--- E5 business without the feature ---");
  const gB = await api(`/api/business-documents/supplier-orders/${oB}/sheets`, tB);
  const pB = await api(`/api/business-documents/supplier-orders/${oB}/sheets`, tB, { method: "POST", body: JSON.stringify({ idempotencyKey: "x", locale: "he" }) });
  ok("E5 list and save answer 404", gB.status === 404 && pB.status === 404, `${gB.status}/${pB.status}`);

  console.log("--- E6 account deletion through the app ---");
  const keys = (await own.businessDocumentFile.findMany({ where: { businessId: A, purpose: "PURCHASE_ORDER_SHEET" }, select: { objectKey: true } })).map((f) => f.objectKey);
  const del = await api("/api/account", tA, { method: "DELETE" });
  const dj = (await del.json().catch(() => ({}))) as { ok?: boolean; status?: string };
  ok("E6 DELETE /api/account → deleted", del.status === 200 && dj.status === "deleted", `${del.status} ${JSON.stringify(dj)}`);
  // The post-commit object stage runs inside the request; give a sweep-free run a moment to settle before reading.
  let after: string[] = [];
  for (let i = 0; i < 10; i++) {
    after = await bucketList(prefix);
    const allMarkers = (await Promise.all(after.map(async (k) => (await bucketGet(k)).equals(FENCE_MARKER)))).every(Boolean);
    if (after.length === keys.length && allMarkers) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const left = { sheets: await sheets(), files: await own.businessDocumentFile.count({ where: { businessId: A } }), requests: await own.businessDocumentRequest.count({ where: { businessId: A } }) };
  ok("E6 no sheet, no file row, no request row is left", left.sheets === 0 && left.files === 0 && left.requests === 0, JSON.stringify(left));
  const markers = await Promise.all(after.map(async (k) => (await bucketGet(k)).equals(FENCE_MARKER)));
  ok("E6 every saved PDF is gone: each key holds only the data-free marker", keys.length === 2 && keys.every((k) => after.includes(k)) && markers.every(Boolean), `${after.length} objects`);
  ok("E6 nothing else under the business's prefix", after.every((k) => keys.includes(k)));

  await cleanup();
  ok("cleanup: this run left nothing in the test bucket", (await bucketList(prefix)).length === 0 && (await bucketList(`biz/${B}/business-docs/`)).length === 0);
}

main()
  .catch((e) => { console.error(e); failures.push("threw"); })
  .finally(async () => {
    await cleanup().catch(() => undefined);
    await own.$disconnect().catch(() => undefined);
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exit(failures.length ? 1 : 0);
  });
