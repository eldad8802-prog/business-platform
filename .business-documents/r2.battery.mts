/**
 * The fence against REAL Cloudflare R2 — a DEDICATED TEST BUCKET only, with a token scoped to that bucket
 * (Object Read & Write). Never the Production bucket or its credentials.
 *
 *   R2_TEST_ACCOUNT_ID, R2_TEST_ACCESS_KEY_ID, R2_TEST_SECRET_ACCESS_KEY, R2_TEST_BUCKET   (required)
 *   optional: DATABASE_URL (+ OWNER_URL) of a lab migrated by .business-documents/lab.sh — adds the erasure scenario
 *
 *   npx tsx .business-documents/r2.battery.mts
 *
 * Refuses to start when the bucket name does not contain "test", or equals R2_BUCKET_NAME (the app's own bucket).
 * Every object it writes lives under biz/999999/business-docs/r2-battery-<run>/ (or the lab business's prefix) and is
 * removed at the end.
 *
 *   1  create-once: CREATED, then 412 → EXISTS; 20 concurrent creators → exactly one CREATED
 *   2  the upload wins before the marker → closeKey deletes it and the marker goes in
 *   3  the marker wins before the upload → the upload (still streaming) ends in 412; the key holds the marker
 *   4  an abandoned upload (client aborts mid-body) → closeKey; after the abort the key still holds the marker
 *   5  repeated / concurrent closings → all succeed on one marker; deleting a missing key is not an error
 *   6  listing confined to the prefix
 *   7  (with a lab DB) account erasure while an upload is streaming — the wired path (the purge's erase call, then the
 *      post-commit object stage) → done, the late upload refused, only markers left
 */
import { Readable } from "node:stream";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { closeKey, FENCE_MARKER } from "../lib/services/business-documents/files/business-docs-files";
import { R2StorageService } from "../lib/storage";

const env = (k: string) => (process.env[k] ?? "").trim();
const cfg = { accountId: env("R2_TEST_ACCOUNT_ID"), accessKeyId: env("R2_TEST_ACCESS_KEY_ID"), secretAccessKey: env("R2_TEST_SECRET_ACCESS_KEY"), bucketName: env("R2_TEST_BUCKET") };
if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucketName) {
  console.log("R2 battery NOT RUN: R2_TEST_ACCOUNT_ID / R2_TEST_ACCESS_KEY_ID / R2_TEST_SECRET_ACCESS_KEY / R2_TEST_BUCKET are not set.");
  process.exit(2);
}
if (!/test/i.test(cfg.bucketName) || cfg.bucketName === env("R2_BUCKET_NAME")) {
  console.log(`R2 battery REFUSED: "${cfg.bucketName}" is not a dedicated test bucket.`);
  process.exit(3);
}

const storage = new R2StorageService({ provider: "r2", signedUrlTtlSeconds: 60, r2: cfg });
const raw = new S3Client({ region: "auto", endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
const BIZ = 999999;
const RUN = `r2-battery-${Date.now()}`;
const prefix = `biz/${BIZ}/business-docs/${RUN}/`;
const k = (name: string) => `${prefix}${name}.pdf`;
const meta = { businessId: BIZ, domain: "business-docs" as const, visibility: "private" as const };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
const isMarker = async (key: string) => {
  try {
    return (await storage.getObject(key)).body.equals(FENCE_MARKER);
  } catch {
    return false;
  }
};

/** A create-once PUT whose body trickles in over `ms` — an upload still in flight. Resolves to "CREATED" | "412" | error text. */
function slowConditionalPut(key: string, ms: number, abort?: AbortSignal): Promise<string> {
  const chunks = 10;
  const chunk = Buffer.alloc(32 * 1024, 0x41);
  let sent = 0;
  const body = new Readable({
    read() {
      if (sent === chunks) return this.push(null);
      sent++;
      setTimeout(() => this.push(chunk), ms / chunks);
    },
  });
  return raw
    .send(new PutObjectCommand({ Bucket: cfg.bucketName, Key: key, Body: body, ContentLength: chunk.length * chunks, ContentType: "application/pdf", IfNoneMatch: "*" }), { abortSignal: abort })
    .then(() => "CREATED", (e: { $metadata?: { httpStatusCode?: number }; name?: string; message?: string }) => (e?.$metadata?.httpStatusCode === 412 ? "412" : `ERR:${e?.name ?? ""} ${e?.message ?? ""}`));
}

async function main() {
  console.log(`--- bucket ${cfg.bucketName}, prefix ${prefix} ---`);

  console.log("--- 1 create-once ---");
  const first = await storage.putObjectIfAbsent({ key: k("once"), body: Buffer.from("%PDF one"), contentType: "application/pdf", metadata: meta });
  const second = await storage.putObjectIfAbsent({ key: k("once"), body: Buffer.from("%PDF two"), contentType: "application/pdf", metadata: meta });
  ok("first create → CREATED; second → EXISTS (R2 412 PreconditionFailed)", first.status === "CREATED" && second.status === "EXISTS");
  ok("the object keeps the first body", (await storage.getObject(k("once"))).body.toString() === "%PDF one");
  const racers = await Promise.all(Array.from({ length: 20 }, (_, i) => storage.putObjectIfAbsent({ key: k("race"), body: Buffer.from(`%PDF ${i}`), contentType: "application/pdf", metadata: meta }).then((r) => r.status, (e) => `ERR:${(e as Error).name}`)));
  ok("20 concurrent creators → exactly one CREATED", racers.filter((r) => r === "CREATED").length === 1, JSON.stringify(racers.reduce((m: Record<string, number>, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {})));

  console.log("--- 2 the upload wins before the marker ---");
  await storage.putObjectIfAbsent({ key: k("upload-first"), body: Buffer.from("%PDF landed"), contentType: "application/pdf", metadata: meta });
  ok("closeKey deletes the landed upload and puts the marker", (await closeKey(BIZ, k("upload-first"), storage)) && (await isMarker(k("upload-first"))));

  console.log("--- 3 the marker wins before the upload ---");
  const inFlight = slowConditionalPut(k("marker-first"), 6000);
  await sleep(1500);
  const closed = await closeKey(BIZ, k("marker-first"), storage);
  const lateResult = await inFlight;
  ok("the marker is created while the upload is still streaming", closed);
  ok("the upload ends refused (412) — it never lands", lateResult === "412", lateResult);
  ok("the key holds the marker afterwards", await isMarker(k("marker-first")));

  console.log("--- 4 an abandoned upload ---");
  const ac = new AbortController();
  const abandoned = slowConditionalPut(k("abandoned"), 6000, ac.signal);
  await sleep(1500);
  ac.abort();
  const abandonedResult = await abandoned;
  ok("closeKey after the client gave up", await closeKey(BIZ, k("abandoned"), storage), abandonedResult);
  await sleep(10_000);
  ok("10 s later the key still holds the marker (whatever the abandoned PUT did, it did not land after the marker)", await isMarker(k("abandoned")));

  console.log("--- 5 retries ---");
  const many = await Promise.all(Array.from({ length: 5 }, () => closeKey(BIZ, k("retry"), storage)));
  ok("five concurrent closings all succeed on one marker", many.every(Boolean) && (await isMarker(k("retry"))));
  ok("closing an already-closed key again succeeds without rewriting", (await closeKey(BIZ, k("retry"), storage)) && (await isMarker(k("retry"))));
  let missingDelete = "OK";
  await storage.deleteObject(k("never-existed")).catch((e) => (missingDelete = String((e as Error).name)));
  ok("deleting a missing key is not an error", missingDelete === "OK", missingDelete);

  console.log("--- 6 listing ---");
  const listed = await storage.listObjects(prefix);
  ok("listing returns this run's objects, confined to the prefix", listed.length >= 5 && listed.every((o) => o.key.startsWith(prefix)), `${listed.length}`);

  if (env("DATABASE_URL") && env("OWNER_URL")) {
    console.log("--- 7 account erasure while an upload is streaming (lab DB) ---");
    const { PrismaClient } = await import("@prisma/client");
    const { continueBusinessDocumentsErasure } = await import("../lib/services/business-documents/erasure/business-docs-erasure");
    const { bdTx } = await import("../lib/services/business-documents/bd-tx");
    const own = new PrismaClient({ datasources: { db: { url: env("OWNER_URL") } } });
    const biz = (await own.business.create({ data: { name: `r2-erasure-${Date.now()}` } })).id;
    const key = `biz/${biz}/business-docs/quote-shares/${RUN}.pdf`;
    await own.$executeRawUnsafe(`INSERT INTO "BusinessDocumentFile" ("businessId", "purpose", "objectKey") VALUES ($1, 'QUOTE_SHARE_COPY', $2)`, biz, key);
    const streaming = slowConditionalPut(key, 6000);
    await sleep(1000);
    await own.business.update({ where: { id: biz }, data: { deletionRequestedAt: new Date() } });
    // Exactly what account deletion does: business_documents_erase() in the purge transaction, then — only after it
    // committed — the post-commit object stage against this bucket.
    await bdTx(biz, (tx) => tx.$queryRaw`SELECT public.business_documents_erase() AS n`);
    const run = await continueBusinessDocumentsErasure(biz, storage);
    const late = await streaming;
    const left = await storage.listObjects(`biz/${biz}/business-docs/`);
    ok("the erasure completes with the upload still streaming", run.done === true);
    ok("the streaming upload is refused (412)", late === "412", late);
    ok("only data-free markers remain under the business's prefix", left.length === 1 && (await isMarker(key)));
    for (const o of left) await storage.deleteObject(o.key);
    await own.$disconnect();
  } else {
    console.log("--- 7 skipped (no lab DATABASE_URL / OWNER_URL) ---");
  }

  for (const o of await storage.listObjects(prefix)) await storage.deleteObject(o.key);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
