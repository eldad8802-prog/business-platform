/**
 * Service Desk 1.3-0 PR-2 — the object stage of an account erasure, end to end on PostgreSQL with the applied
 * migration (.sd3/lab.sh --with-sd3), real local storage (a temp directory) and the runtime role.
 *
 * The purge (prismaAccountDeletionStore.purgeOperationalData) opens the job in its transaction; then
 * continueServiceStorageErasure() — the "service-desk" module of the shared post-commit stage — deletes, verifies with a
 * fresh listing, and records the pass through service_storage_erasure_record_pass():
 *
 *   S1. no committed purge (never ran / rolled back) → no job → nothing deleted, no row written;
 *   S2. the pass right after the purge deletes every object, verifies 0 left, and keeps the job OPEN (the hour);
 *   S3. a pass ≥ 1 hour after the deletion request deletes a late object and closes the job (DONE, completedAt);
 *   S4. DONE is final: another pass changes nothing (attempts unchanged);
 *   S5. a storage failure in the middle → the job stays open with the FIXED code DELETE_FAILED (never the message, key
 *       or path); the retry finishes and closes it;
 *   S6. a failed verification (the second listing) never closes the job, even with nothing left;
 *   S7. two passes at once: both succeed, nothing is left, the job ends DONE once, no error;
 *   S8. isolation: another business's objects (biz/{Y}/service/ and the look-alike biz/{X}0/service/) and its rows stay;
 *       a listing that returns a foreign key never deletes it (FOREIGN_KEY_LISTED);
 *   S9. no new upload for a business being deleted: the table guards refuse the row (DZU02);
 *  S10. the shared stage runs the module ("service-desk" in ACCOUNT_STORAGE_ERASURES); isStuck flags an old open job.
 *
 * env: OWNER_URL (lab owner), DATABASE_URL = DIRECT_URL = the runtime login, AUTH_*. Synthetic only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";
import { ACCOUNT_STORAGE_ERASURES } from "../lib/services/account/account-storage-erasure";
import {
  SERVICE_ERASURE_ERROR_CODES,
  continueServiceStorageErasure,
  isStuck,
} from "../lib/services/service-desk/erasure/service-storage-erasure";
import { LocalFsStorageService, type StorageService } from "../lib/storage";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const one = async (sql: string, ...a: unknown[]) => (await q(sql, ...a))[0] ?? {};
const n = async (sql: string, ...a: unknown[]) => Number((await one(sql, ...a)).n);
const purge = (biz: number) => prismaAccountDeletionStore.purgeOperationalData(biz).then(() => null, (e: Error) => e.message);
const job = (biz: number) => one(`SELECT state::text s, attempts a, "objectsDeleted"::int d, "lastPassRemaining" r, "lastError" e, "completedAt" IS NOT NULL c
  FROM "ServiceStorageErasure" WHERE "businessId" = $1`, biz);

async function business(name: string) {
  const biz = Number((await one(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, name)).id);
  await x(`INSERT INTO "User" (email, name, "businessId", "updatedAt") VALUES ($1, 'בעל עסק', $2, now())`, `${name}@lab.invalid`, biz);
  return biz;
}

let storage: LocalFsStorageService;
const put = (key: string, biz: number) => storage.putObjectIfAbsent({
  key, body: Buffer.from(`bytes of ${key}`), contentType: "application/octet-stream",
  metadata: { businessId: biz, domain: "service", visibility: "private" },
});
const keysOf = async (biz: number) => (await storage.listObjects(`biz/${biz}/service/`)).map((o) => o.key).sort();
async function seed(biz: number, count = 3) {
  for (let i = 1; i <= count; i++) await put(`biz/${biz}/service/cases/${i}/obj-${i}.bin`, biz);
}
/** A storage that fails on chosen calls — stands in for an R2 outage. */
function faulty(base: StorageService, o: { failDeleteAt?: number; failListAt?: number; foreignKey?: string }): StorageService {
  let deletes = 0, lists = 0;
  return new Proxy(base, {
    get(target, prop, recv) {
      if (prop === "deleteObject") return async (key: string) => {
        if (++deletes === o.failDeleteAt) throw new Error(`R2 refused DELETE of ${key} at /bucket/${key}`);
        return target.deleteObject(key);
      };
      if (prop === "listObjects") return async (prefix: string) => {
        if (++lists === o.failListAt) throw new Error(`R2 refused LIST of ${prefix}`);
        const listed = await target.listObjects(prefix);
        return o.foreignKey ? [...listed, { key: o.foreignKey, size: 1 }] : listed;
      };
      return Reflect.get(target, prop, recv);
    },
  });
}
const quarantineAgo = (biz: number, hours: number) => x(`UPDATE "Business" SET "deletionRequestedAt" = now() - make_interval(hours => $2::int) WHERE id = $1`, biz, hours);

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sd3-storage-erasure-"));
  storage = new LocalFsStorageService({ provider: "local", localRoot: root, signedUrlTtlSeconds: 300 });
  try {
    // ── S1 — no committed purge → no job → nothing deleted
    const X = await business(`sd3-se-x-${Date.now()}`);
    const Y = await business(`sd3-se-y-${Date.now()}`);
    const lookalike = X * 10; // biz/{X}0/service/ — must never match biz/{X}/service/
    await seed(X); await seed(Y, 2); await put(`biz/${lookalike}/service/cases/1/near.bin`, lookalike);
    const s1 = await continueServiceStorageErasure(X, storage);
    ok("S1 no purge yet → NO_JOB, nothing deleted, no row", s1.state === "NO_JOB" && s1.done && (await keysOf(X)).length === 3
      && await n(`SELECT count(*)::int n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, X) === 0, JSON.stringify(s1));
    await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, X);
    await x(`REVOKE EXECUTE ON FUNCTION public.service_desk_ui_erase_business() FROM app_runtime`);
    const failed = await purge(X);
    await x(`GRANT EXECUTE ON FUNCTION public.service_desk_ui_erase_business() TO app_runtime`);
    const s1b = await continueServiceStorageErasure(X, storage);
    ok("S1 a purge that rolled back (door refused) leaves no job → nothing deleted", failed !== null && s1b.state === "NO_JOB" && (await keysOf(X)).length === 3,
      `${failed} ${JSON.stringify(s1b)}`);

    // ── S2 — the pass right after the purge: delete + verify, the job stays open (quarantine < 1 hour)
    const p2 = await purge(X);
    const j0 = await job(X);
    ok("S2 the purge commits and opens the job (PENDING_OBJECTS, no pass yet)", p2 === null && j0.s === "PENDING_OBJECTS" && Number(j0.a) === 0, `${p2} ${JSON.stringify(j0)}`);
    const s2 = await continueServiceStorageErasure(X, storage);
    const j2 = await job(X);
    ok("S2 the post-commit pass deletes every object of X and verifies none left", s2.deleted === 3 && s2.remaining === 0 && (await keysOf(X)).length === 0, JSON.stringify(s2));
    ok("S2 … but cannot close the job inside the hour: PENDING_OBJECTS, attempts 1, deleted 3, remaining 0, no error",
      s2.state === "PENDING_OBJECTS" && !s2.done && j2.s === "PENDING_OBJECTS" && Number(j2.a) === 1 && Number(j2.d) === 3 && Number(j2.r) === 0 && j2.e === null && j2.c === false,
      JSON.stringify(j2));

    // ── S3 — a later pass (≥ 1 hour) deletes a late object and closes the job
    await put(`biz/${X}/service/cases/9/late-upload.bin`, X);
    await quarantineAgo(X, 2);
    const s3 = await continueServiceStorageErasure(X, storage);
    const j3 = await job(X);
    ok("S3 ≥ 1 hour later: the late object is deleted and the job closes (DONE, completedAt)",
      s3.state === "DONE" && s3.done && s3.deleted === 1 && (await keysOf(X)).length === 0 && j3.s === "DONE" && j3.c === true && Number(j3.d) === 4, JSON.stringify({ s3, j3 }));

    // ── S4 — DONE is final
    await put(`biz/${X}/service/cases/9/after-done.bin`, X); // cannot happen (guards), proves the module never reopens
    const s4 = await continueServiceStorageErasure(X, storage);
    const j4 = await job(X);
    ok("S4 DONE is final: no further pass, attempts unchanged", s4.state === "DONE" && Number(j4.a) === Number(j3.a) && j4.s === "DONE", JSON.stringify(j4));
    await storage.deleteObject(`biz/${X}/service/cases/9/after-done.bin`);

    // ── S5 — a storage failure mid-pass → open job, FIXED code; the retry finishes
    const Z = await business(`sd3-se-z-${Date.now()}`);
    await seed(Z, 3);
    await x(`UPDATE "Business" SET "deletionRequestedAt" = now() - interval '2 hours' WHERE id = $1`, Z);
    ok("S5 setup: Z purged", (await purge(Z)) === null);
    const s5 = await continueServiceStorageErasure(Z, faulty(storage, { failDeleteAt: 2 }));
    const j5 = await job(Z);
    ok("S5 a delete fails mid-pass → the job stays open, remaining 1, error = DELETE_FAILED",
      s5.state === "PENDING_OBJECTS" && s5.error === "DELETE_FAILED" && s5.deleted === 2 && s5.remaining === 1 && j5.e === "DELETE_FAILED" && (await keysOf(Z)).length === 1,
      JSON.stringify({ s5, j5 }));
    ok("S5 lastError is the fixed code only — no message, key or path", j5.e === "DELETE_FAILED" && !String(j5.e).includes("biz/")
      && (SERVICE_ERASURE_ERROR_CODES as readonly string[]).includes(String(j5.e)));
    const s5b = await continueServiceStorageErasure(Z, storage);
    const j5b = await job(Z);
    ok("S5 the retry deletes the rest and closes the job; the error is cleared", s5b.state === "DONE" && j5b.s === "DONE" && j5b.e === null && Number(j5b.a) === 2 && Number(j5b.d) === 3,
      JSON.stringify(j5b));

    // ── S6 — a failed verification never closes the job
    const V = await business(`sd3-se-v-${Date.now()}`);
    await seed(V, 2);
    await x(`UPDATE "Business" SET "deletionRequestedAt" = now() - interval '2 hours' WHERE id = $1`, V);
    await purge(V);
    const s6 = await continueServiceStorageErasure(V, faulty(storage, { failListAt: 2 }));
    const j6 = await job(V);
    ok("S6 the second listing fails → VERIFY_FAILED, the job stays open although everything was deleted",
      s6.state === "PENDING_OBJECTS" && s6.error === "VERIFY_FAILED" && (await keysOf(V)).length === 0 && j6.s === "PENDING_OBJECTS" && j6.e === "VERIFY_FAILED", JSON.stringify(j6));
    const s6b = await continueServiceStorageErasure(V, storage);
    ok("S6 the next clean pass closes it", s6b.state === "DONE");

    // ── S7 — two passes at once
    const W = await business(`sd3-se-w-${Date.now()}`);
    await seed(W, 20);
    await x(`UPDATE "Business" SET "deletionRequestedAt" = now() - interval '2 hours' WHERE id = $1`, W);
    await purge(W);
    const [a, b] = await Promise.all([continueServiceStorageErasure(W, storage), continueServiceStorageErasure(W, storage)]);
    const j7 = await job(W);
    ok("S7 two concurrent passes both succeed, nothing is left, the job is DONE with no error",
      (await keysOf(W)).length === 0 && j7.s === "DONE" && j7.e === null && [a, b].every((r) => r.error === null) && [a, b].some((r) => r.state === "DONE")
      && a.deleted + b.deleted >= 20, JSON.stringify({ a, b, j7 }));

    // ── S8 — isolation
    ok("S8 business Y's objects are untouched", (await keysOf(Y)).length === 2);
    ok("S8 the look-alike prefix biz/{X}0/service/ is untouched", (await keysOf(lookalike)).length === 1);
    ok("S8 business Y has no job and its rows were not touched by X's erasure", await n(`SELECT count(*)::int n FROM "ServiceStorageErasure" WHERE "businessId" = $1`, Y) === 0
      && await n(`SELECT count(*)::int n FROM "User" WHERE "businessId" = $1 AND email LIKE 'sd3-se-y-%'`, Y) === 1);
    const F = await business(`sd3-se-f-${Date.now()}`);
    await seed(F, 1);
    await x(`UPDATE "Business" SET "deletionRequestedAt" = now() - interval '2 hours' WHERE id = $1`, F);
    await purge(F);
    const foreign = `biz/${Y}/service/cases/1/obj-1.bin`;
    const s8 = await continueServiceStorageErasure(F, faulty(storage, { foreignKey: foreign }));
    ok("S8 a listing that returns another business's key never deletes it (FOREIGN_KEY_LISTED, job open)",
      s8.error === "FOREIGN_KEY_LISTED" && s8.state === "PENDING_OBJECTS" && (await keysOf(Y)).includes(foreign), JSON.stringify(s8));

    // ── S9 — no new upload row for a business being deleted
    const up = await runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${Z}', true)`);
      return tx.$executeRawUnsafe(`INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256") VALUES ($1, 'TERMS', 1, 'x', encode(sha256(convert_to('x','UTF8')),'hex'))`, Z);
    }).then(() => null, (e: Error) => e.message);
    ok("S9 a write to the new tables for a business being deleted is refused (DZU02)", up !== null && /SERVICE_UI_BUSINESS_DELETING|DZU02/.test(up), String(up));

    // ── S10 — the shared stage, monitoring
    ok("S10 the shared post-commit stage runs the module (\"service-desk\" in ACCOUNT_STORAGE_ERASURES)",
      ACCOUNT_STORAGE_ERASURES.some((m) => m.module === "service-desk") && ACCOUNT_STORAGE_ERASURES.some((m) => m.module === "business-documents"));
    const now = new Date("2026-11-10T00:00:00Z");
    ok("S10 isStuck: 24 attempts or 48 hours open → reported; a fresh job is not",
      isStuck({ attempts: 24, startedAt: now }, now) && isStuck({ attempts: 1, startedAt: new Date(now.getTime() - 48 * 3_600_000) }, now)
      && !isStuck({ attempts: 2, startedAt: new Date(now.getTime() - 3_600_000) }, now));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main()
  .catch((e) => { failures.push(`crash: ${(e as Error).message}`); console.error(e); })
  .finally(async () => {
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) console.log("FAILED:\n  " + failures.join("\n  "));
    await owner.$disconnect(); await runtime.$disconnect();
    process.exit(failures.length ? 1 : 0);
  });
