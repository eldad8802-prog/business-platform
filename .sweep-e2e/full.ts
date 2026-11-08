/**
 * EVIDENCE ONLY (branch evidence/storage-erasure-sweep-e2e, never merged). #1017's shared sweep route driving BOTH modules of ACCOUNT_STORAGE_ERASURES —
 * "business-documents" (main, #1007) and "service-desk" (#1014) — end to end, in an isolated checkout
 * (main + #1013 + #1014 + #1017) with its OWN freshly generated Prisma client, on a database where every migration is
 * really applied (.business-documents/lab.sh --with-bd: the 1.3-0 lab + 20261114 by migrate deploy), as the runtime
 * role, with real local storage.
 *
 *   E0  the client is fresh: both modules' delegates exist
 *   E1  switch absent (the default) → 200 enabled:false; nothing deleted, no pass recorded, both jobs still open
 *   E2  on: three overlapping runs → all 200, counts only
 *   E3  A (requested 2 h ago): business documents job DONE, every object a data-free marker; Service Desk job DONE, 0 objects
 *   E4  B (requested now): business documents done; Service Desk objects gone but its job stays open inside the hour
 *   E5  C: one Service Desk delete fails → never DONE with objects left; fixed code only; the next run finishes it
 *   E6  N (not being deleted): its business documents objects and Service Desk objects are untouched
 *   E7  DONE is final; the last run reports 0 module errors and only B open
 *   E8  static: vercel.json schedules no such route; the switch is off unless exactly "true"
 *
 * env: OWNER_URL, DATABASE_URL = DIRECT_URL = AUTH_DATABASE_URL (app_runtime_prod), STORAGE_PROVIDER=local,
 * LOCAL_STORAGE_ROOT, BILLING_PDF_STORAGE_ROOT, AUTH_TOKEN_SECRET. Synthetic only.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

import * as route from "../app/api/account/storage-erasure-sweep/route";
import { ACCOUNT_STORAGE_ERASURES } from "../lib/services/account/account-storage-erasure";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";
import { bdTx } from "../lib/services/business-documents/bd-tx";
import { commitFile, createPendingFile, FENCE_MARKER, uploadCreateOnce } from "../lib/services/business-documents/files/business-docs-files";
import { parseLetterInput } from "../lib/services/business-documents/letter/letter.contracts";
import { saveLetter } from "../lib/services/business-documents/letter/saved-letters-save.service";
import { issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";
import { getStorageService } from "../lib/storage";

const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });
const store = getStorageService();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const stamp = Date.now();

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const q = (sql: string, ...a: unknown[]) => own.$queryRawUnsafe(sql, ...a) as Promise<Record<string, unknown>[]>;
const x = (sql: string, ...a: unknown[]) => own.$executeRawUnsafe(sql, ...a);

type Biz = { b: number; u: number; bdKeys: string[] };
async function seed(name: string): Promise<Biz> {
  const b = await own.business.create({ data: { name: `e2e-${name}-${stamp}` } });
  const u = await own.user.create({ data: { email: `e2e-${name}-${stamp}@example.test`, password: "synthetic", businessId: b.id, role: "USER" } });
  await own.businessProfile.create({ data: { businessId: b.id, billingLegalName: `עסק ${name}`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "רחוב 1" } });
  const z: Biz = { b: b.id, u: u.id, bdKeys: [] };
  // business documents: a saved letter (stored PDF) and a quote share copy (stored PDF), through the real primitives
  const letter = parseLetterInput({ recipientKind: "free", recipientName: `נמען ${name}`, recipientAddress: "רחוב 2", date: "2026-11-09", subject: "בדיקה", body: "גוף סינתטי", signerName: "בודק" });
  await saveLetter({ businessId: z.b, userId: z.u, letter, idempotencyKey: await bdTx(z.b, (tx) => issueRequestKey(tx, z.b, z.u, "LETTER_SAVE")) }, { render: async (h: string) => Buffer.from(`%PDF-fake ${sha(h)} ${randomUUID()}`) });
  const quote = (await own.billingDocument.create({ data: { businessId: z.b, documentType: "QUOTE" } })).id;
  const lease = randomUUID();
  const pdf = Buffer.from(`%PDF-fake quote ${name} ${randomUUID()}`);
  const f = await bdTx(z.b, (tx) => createPendingFile(tx, z.b, "QUOTE_SHARE_COPY", lease));
  await uploadCreateOnce(z.b, f.objectKey, pdf);
  await bdTx(z.b, async (tx) => {
    if (!(await commitFile(tx, z.b, f.id, lease, pdf))) throw new Error("seed commit failed");
    await tx.$executeRawUnsafe(`INSERT INTO "QuoteShareCopy" ("businessId", "quoteDocumentId", "fileId", "sha256", "quoteContentHash", "quoteNumberSnapshot", "customerNameSnapshot", "totalSnapshot", "currencySnapshot", "contentCheckedAt") VALUES ($1, $2, $3, $4, $5, 'Q-1', 'לקוח', 100, 'ILS', now())`, z.b, quote, f.id, sha(pdf), sha("content"));
  });
  z.bdKeys = (await own.businessDocumentFile.findMany({ where: { businessId: z.b }, select: { objectKey: true } })).map((r) => r.objectKey);
  // service desk: three private objects under biz/{id}/service/
  for (let i = 1; i <= 3; i++) {
    await store.putObjectIfAbsent({ key: `biz/${z.b}/service/cases/${i}/o${i}.bin`, body: Buffer.from(`sd ${name} ${i}`), contentType: "application/octet-stream", metadata: { businessId: z.b, domain: "service", visibility: "private" } });
  }
  return z;
}
const sdLeft = async (b: number) => (await store.listObjects(`biz/${b}/service/`)).length;
const sdJob = async (b: number) => (await q(`SELECT state::text s, attempts::int a, "lastError" e FROM "ServiceStorageErasure" WHERE "businessId" = $1`, b))[0] ?? null;
const bdJob = async (b: number) => (await own.businessDocumentErasure.findUnique({ where: { businessId: b } }))?.state ?? "NONE";
const isMarker = async (key: string) => { const h = await store.headObject(key); return h.exists ? (await store.getObject(key)).body.equals(FENCE_MARKER) : false; };
const allMarkers = async (keys: string[]) => { for (const k of keys) if (!(await isMarker(k))) return false; return keys.length > 0; };
const noneMarked = async (keys: string[]) => { for (const k of keys) { const h = await store.headObject(k); if (!h.exists || (await isMarker(k))) return false; } return keys.length > 0; };

const SECRET = "e".repeat(48);
const call = async () => {
  const r = await route.GET(new NextRequest("https://lab.test/api/account/storage-erasure-sweep", { headers: { authorization: `Bearer ${SECRET}` } }));
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

async function main() {
  process.env.CRON_SECRET = SECRET;
  const p = new PrismaClient();
  ok("E0 fresh client: business-documents + service-desk delegates exist; both modules registered",
    typeof (p as any).businessDocumentErasure === "object" && typeof (p as any).serviceStorageErasure === "object"
    && JSON.stringify(ACCOUNT_STORAGE_ERASURES.map((m) => m.module)) === '["business-documents","service-desk"]');
  await p.$disconnect();

  const A = await seed("a"), B = await seed("b"), C = await seed("c"), N = await seed("n");
  for (const z of [A, C]) await x(`UPDATE "Business" SET "deletionRequestedAt" = now() - interval '2 hours' WHERE id = $1`, z.b);
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, B.b);
  for (const z of [A, B, C]) await prismaAccountDeletionStore.purgeOperationalData(z.b);
  const opened = await Promise.all([A, B, C].map(async (z) => `${await bdJob(z.b)}/${(await sdJob(z.b))?.s}`));
  ok("setup: each purge opened both jobs (business documents + Service Desk), objects untouched", opened.every((s) => !s.startsWith("NONE") && s.endsWith("/PENDING_OBJECTS")) && (await noneMarked(A.bdKeys)) && (await sdLeft(A.b)) === 3, JSON.stringify(opened));

  // E1 off
  delete process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED;
  const r1 = await call();
  ok("E1 switch absent → 200 enabled:false; nothing deleted, no pass recorded", r1.status === 200 && r1.body.enabled === false && (await noneMarked(A.bdKeys)) && (await sdLeft(A.b)) === 3 && (await sdJob(A.b))?.a === 0, JSON.stringify(r1.body));

  // E2 on, with one Service Desk delete failing for C
  process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED = "true";
  const realDelete = store.deleteObject.bind(store);
  let failed = false;
  (store as any).deleteObject = async (key: string) => {
    if (!failed && key.startsWith(`biz/${C.b}/service/`)) { failed = true; throw new Error(`R2 refused DELETE of ${key}`); }
    return realDelete(key);
  };
  const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {};
  const runs = await Promise.all([call(), call(), call()]);
  console.error = e; console.warn = w;
  ok("E2 three overlapping runs → all 200, counts only", runs.every((r) => r.status === 200 && Object.keys(r.body).sort().join() === "counts,enabled,ok"), JSON.stringify(runs.map((r) => [r.status, r.body.counts])));

  ok("E3 A: business documents job DONE, every stored object is a data-free marker", (await bdJob(A.b)) === "DONE" && (await allMarkers(A.bdKeys)), `${await bdJob(A.b)}`);
  const ja = await sdJob(A.b);
  ok("E3 A: Service Desk job DONE, 0 objects, no error", ja?.s === "DONE" && ja?.e === null && (await sdLeft(A.b)) === 0, JSON.stringify(ja));
  const jb = await sdJob(B.b);
  ok("E4 B: business documents done; Service Desk objects gone but the job stays open inside the hour", (await bdJob(B.b)) === "DONE" && (await allMarkers(B.bdKeys)) && (await sdLeft(B.b)) === 0 && jb?.s === "PENDING_OBJECTS", `${await bdJob(B.b)} ${JSON.stringify(jb)}`);
  const jc = await sdJob(C.b);
  ok("E5 C: never DONE while objects remain; lastError a fixed code only", failed && (jc?.s !== "DONE" || (await sdLeft(C.b)) === 0) && (jc?.e === null || ["LIST_FAILED", "DELETE_FAILED", "VERIFY_FAILED", "FOREIGN_KEY_LISTED"].includes(String(jc?.e))), JSON.stringify(jc));
  ok("E6 N (not being deleted): business documents objects and Service Desk objects untouched, no jobs", (await noneMarked(N.bdKeys)) && (await sdLeft(N.b)) === 3 && (await bdJob(N.b)) === "NONE" && (await sdJob(N.b)) === null);

  // E5 retry, E7 final
  (store as any).deleteObject = realDelete;
  const r3 = await call();
  const jc3 = await sdJob(C.b);
  ok("E5 the next run finishes C: 0 objects, DONE, error cleared", r3.status === 200 && (await sdLeft(C.b)) === 0 && jc3?.s === "DONE" && jc3?.e === null && (await bdJob(C.b)) === "DONE", `${JSON.stringify(jc3)} ${JSON.stringify(r3.body)}`);
  const aBefore = (await sdJob(A.b))?.a;
  const r4 = await call();
  ok("E7 DONE is final (A unchanged); 0 module errors; only B still open", (await sdJob(A.b))?.a === aBefore && (await bdJob(A.b)) === "DONE" && r4.body.counts.errors === 0 && r4.body.counts.open === 1, JSON.stringify(r4.body));

  // E8 static
  const vercel = JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { crons?: { path: string }[] };
  ok("E8 vercel.json schedules no storage-erasure-sweep", !(vercel.crons ?? []).some((c) => c.path.includes("storage-erasure-sweep")));
  process.env.ACCOUNT_STORAGE_ERASURE_SWEEP_ENABLED = "TRUE";
  const r5 = await call();
  ok("E8 the switch is off unless exactly \"true\" (\"TRUE\" → inert)", r5.status === 200 && r5.body.enabled === false);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await own.$disconnect();
  process.exit(failures.length ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
