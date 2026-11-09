/**
 * Business documents in ACCOUNT DELETION — the real flow (deleteOwnBusinessAccount + prismaAccountDeletionStore) AS the
 * runtime role, on a database where EVERY migration is really applied (the Service Desk 1.3-0 lab, .sd3/lab.sh
 * --with-sd3, plus 20261114090000_business_documents_records by `prisma migrate deploy`), with real local storage.
 *
 *   S1  happy path: records gone, every object replaced by a data-free marker, job DONE, other modules' erasure intact
 *   S2  storage down during the object stage: the deletion still completes; job open, keys kept, objects untouched;
 *       the sweep finishes it, and a second sweep changes nothing
 *   S3  the purge transaction fails AFTER the erase call: nothing of business documents changed (no job, files
 *       COMMITTED, objects intact); the resumed deletion then completes
 *   S4  uploads already in flight: an uncommitted object is deleted, a late create-once put is refused by the marker,
 *       no commit can land, and no new file / key can be started once the deletion began
 *   S5  concurrency: the post-commit stage and two sweeps at once; two deletion requests at once
 *   S6  a business with no business documents; S7 a neighbour business untouched; S8 a business deleted before this
 *       wiring (no job): the sweep creates nothing; S9 the module runner never throws
 *
 * env: DATABASE_URL / DIRECT_URL / AUTH_DATABASE_URL (app_runtime_prod), OWNER_URL (lab_owner — seeding, fault
 *      injection, reads), SUPER_URL (lab superuser — only to mirror a missing erase
 *      function and to inject the S3 fault), STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT, AUTH_TOKEN_SECRET. Synthetic only.
 */
import { createHash, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { deleteOwnBusinessAccount, type AccountDeletionStore } from "../lib/services/account/account-deletion.service";
import { prismaAccountDeletionStore } from "../lib/services/account/account-deletion.prisma-store";
import { runAccountStorageErasure, sweepAccountStorageErasures, type StorageErasureModule } from "../lib/services/account/account-storage-erasure";
import { bdTx } from "../lib/services/business-documents/bd-tx";
import { continueBusinessDocumentsErasure } from "../lib/services/business-documents/erasure/business-docs-erasure";
import { commitFile, createPendingFile, FENCE_MARKER, uploadCreateOnce } from "../lib/services/business-documents/files/business-docs-files";
import { parseLetterInput } from "../lib/services/business-documents/letter/letter.contracts";
import { saveLetter } from "../lib/services/business-documents/letter/saved-letters-save.service";
import { hideSavedLetter } from "../lib/services/business-documents/letter/saved-letters.service";
import { BusinessDocumentsRequestError, issueRequestKey } from "../lib/services/business-documents/requests/business-docs-requests";
import { getStorageService, type PutIfAbsentResult, type PutObjectInput, type StorageService } from "../lib/storage";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const own = new PrismaClient({ datasources: { db: { url: process.env.OWNER_URL } } });
const local = getStorageService();

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
async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    if (e instanceof BusinessDocumentsRequestError) return e.code;
    return `ERR:${String((e as Error).message).replace(/\s+/g, " ").slice(-200)}`;
  }
}

/** The real local store, with faults on demand: everything failing, or one key's put held until released. */
class FaultyStore implements StorageService {
  down = false;
  private held = new Map<string, Promise<void>>();
  hold(key: string): () => void {
    let release!: () => void;
    this.held.set(key, new Promise<void>((r) => (release = r)));
    return release;
  }
  private gate() {
    if (this.down) throw new Error("simulated storage outage");
  }
  putObject(input: PutObjectInput) {
    this.gate();
    return local.putObject(input);
  }
  async putObjectIfAbsent(input: PutObjectInput): Promise<PutIfAbsentResult> {
    const wait = this.held.get(input.key);
    if (wait) {
      this.held.delete(input.key);
      await wait;
    }
    this.gate();
    return local.putObjectIfAbsent(input);
  }
  async getObject(key: string) {
    this.gate();
    return local.getObject(key);
  }
  async headObject(key: string) {
    this.gate();
    return local.headObject(key);
  }
  async getMetadata(key: string) {
    this.gate();
    return local.getMetadata(key);
  }
  async deleteObject(key: string) {
    this.gate();
    return local.deleteObject(key);
  }
  async listObjects(prefix: string) {
    this.gate();
    return local.listObjects(prefix);
  }
  getSignedDownloadUrl(key: string, ttl?: number) {
    return local.getSignedDownloadUrl(key, ttl);
  }
  getPublicUrl(key: string) {
    return local.getPublicUrl(key);
  }
}
const moduleWith = (store: StorageService): StorageErasureModule[] => [
  { module: "business-documents", resume: (b) => continueBusinessDocumentsErasure(b, store) },
];
/** The real adapter with only its storage seam swapped. */
const adapterWith = (store: StorageService): AccountDeletionStore => ({
  ...prismaAccountDeletionStore,
  async eraseStoredObjects(b) {
    return { complete: (await runAccountStorageErasure(b, moduleWith(store))).every((o) => o.done) };
  },
});

const fakeRender = async (html: string) => Buffer.from(`%PDF-fake ${sha(html)} ${randomUUID()}`);
const stamp = Date.now();

type Biz = { b: number; u: number; keys: string[] };
async function seed(name: string, withDocs = true): Promise<Biz> {
  const b = await own.business.create({ data: { name: `bder-${name}-${stamp}` } });
  const u = await own.user.create({ data: { email: `bder-${name}-${stamp}@example.test`, password: "synthetic", businessId: b.id, role: "USER" } });
  await own.businessProfile.create({ data: { businessId: b.id, billingLegalName: `עסק ${name}`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "999999998", billingAddress: "רחוב 1" } });
  await own.customer.create({ data: { businessId: b.id, name: `לקוח בדיקה ${name}`, city: "חיפה" } });
  const x: Biz = { b: b.id, u: u.id, keys: [] };
  if (!withDocs) return x;
  const letter = parseLetterInput({ recipientKind: "free", recipientName: `נמען בדיקה ${name}`, recipientAddress: "רחוב 2", date: "2026-11-08", subject: "בדיקה", body: "גוף סינתטי", signerName: "בודק" });
  const l1 = await saveLetter({ businessId: x.b, userId: x.u, letter, idempotencyKey: await bdTx(x.b, (tx) => issueRequestKey(tx, x.b, x.u, "LETTER_SAVE")) }, { render: fakeRender });
  const l2 = await saveLetter({ businessId: x.b, userId: x.u, letter: { ...letter, subject: "שני" }, idempotencyKey: await bdTx(x.b, (tx) => issueRequestKey(tx, x.b, x.u, "LETTER_SAVE")) }, { render: fakeRender });
  await hideSavedLetter(x.b, x.u, l2.id);
  // A quote share copy with its stored PDF and an event, through the real file primitives.
  const quote = (await own.billingDocument.create({ data: { businessId: x.b, documentType: "QUOTE" } })).id;
  const lease = randomUUID();
  const pdf = Buffer.from(`%PDF-fake quote ${name} ${randomUUID()}`);
  const f = await bdTx(x.b, (tx) => createPendingFile(tx, x.b, "QUOTE_SHARE_COPY", lease));
  await uploadCreateOnce(x.b, f.objectKey, pdf);
  await bdTx(x.b, async (tx) => {
    if (!(await commitFile(tx, x.b, f.id, lease, pdf))) throw new Error("seed commit failed");
    const c = (await tx.$queryRawUnsafe(`INSERT INTO "QuoteShareCopy" ("businessId", "quoteDocumentId", "fileId", "sha256", "quoteContentHash", "quoteNumberSnapshot", "customerNameSnapshot", "totalSnapshot", "currencySnapshot", "contentCheckedAt") VALUES ($1, $2, $3, $4, $5, 'Q-1', 'לקוח בדיקה', 100, 'ILS', now()) RETURNING id`, x.b, quote, f.id, sha(pdf), sha("content")) as { id: number }[])[0];
    await tx.$executeRawUnsafe(`INSERT INTO "QuoteShareEvent" ("businessId", "quoteDocumentId", "kind", "copyId", "quoteContentHash") VALUES ($1, $2, 'MARKED_SENT', $3, $4)`, x.b, quote, c.id, sha("content"));
  });
  x.keys = (await own.businessDocumentFile.findMany({ where: { businessId: x.b }, select: { objectKey: true } })).map((r) => r.objectKey);
  return x;
}
const records = async (b: number) =>
  (await own.quoteShareCopy.count({ where: { businessId: b } })) + (await own.quoteShareEvent.count({ where: { businessId: b } }))
  + (await own.businessLetter.count({ where: { businessId: b } })) + (await own.businessDocumentRequest.count({ where: { businessId: b } }));
const jobState = async (b: number) => (await own.businessDocumentErasure.findUnique({ where: { businessId: b } }))?.state ?? "NONE";
const fileStates = async (b: number) => (await own.businessDocumentFile.findMany({ where: { businessId: b }, select: { state: true } })).map((r) => r.state);
const isMarker = async (key: string) => {
  const h = await local.headObject(key);
  return h.exists ? (await local.getObject(key)).body.equals(FENCE_MARKER) : false;
};
const listed = (b: number) => local.listObjects(`biz/${b}/business-docs/`);
async function allMarkers(b: number, keys: string[]): Promise<boolean> {
  const l = await listed(b);
  if (l.length !== keys.length) return false;
  for (const k of keys) if (!(await isMarker(k))) return false;
  return true;
}
async function noneTouched(keys: string[]): Promise<boolean> {
  for (const k of keys) {
    const h = await local.headObject(k);
    if (!h.exists || (await isMarker(k))) return false;
  }
  return true;
}
const del = (x: Biz, store: AccountDeletionStore = prismaAccountDeletionStore) => deleteOwnBusinessAccount(store, { businessId: x.b, actorUserId: x.u });

/**
 * Lab infrastructure only: the base lab records some older migrations in the ledger without running them, so an erasure
 * function the purge — or a module of the shared post-commit stage (ACCOUNT_STORAGE_ERASURES) — calls may be missing.
 * Each missing one is created from the REAL definition in the latest migration that creates it (any arguments, e.g.
 * service_storage_erasure_record_pass(integer, integer, text)), EXECUTE to the runtime alone (as .ad2a/battery.mjs does).
 * No erasure logic is written here, nothing is stubbed: a required function no migration defines is an error.
 */
type LabMigration = { dir: string; sql: string };
async function labMigrations(): Promise<LabMigration[]> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(process.cwd(), "prisma/migrations");
  return fs.readdirSync(dir).sort()
    .filter((d) => fs.existsSync(path.join(dir, d, "migration.sql")))
    .map((d) => ({ dir: d, sql: fs.readFileSync(path.join(dir, d, "migration.sql"), "utf8") }));
}
/** The real CREATE OR REPLACE FUNCTION public.<fn>(<args>) … $fn$; of the latest migration that creates it; throws if none. */
function definitionFromMigrations(fn: string, migrations: LabMigration[]): string {
  const re = new RegExp(String.raw`CREATE OR REPLACE FUNCTION public\.${fn}\([^)]*\)[\s\S]*?\$fn\$;`);
  for (const m of [...migrations].reverse()) {
    const d = m.sql.match(re)?.[0];
    if (d) return d;
  }
  throw new Error(`${fn}() not found in any migration`);
}
/** Every public.<fn>( called by the purge adapter and by the erasure code of each registered storage-erasure module. */
async function requiredEraseFunctions(): Promise<string[]> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
  const registry = read("lib/services/account/account-storage-erasure.ts");
  const moduleFiles = [...registry.matchAll(/from "@\/(lib\/services\/[^"]+\/erasure\/[^"]+)"/g)].map((m) => `${m[1]}.ts`);
  const sources = [read("lib/services/account/account-deletion.prisma-store.ts"), ...moduleFiles.map(read)];
  return [...new Set(sources.flatMap((s) => [...s.matchAll(/\bpublic\.([a-z_]+)\(/g)].map((m) => m[1])))].sort();
}
/** public.<fn>(<types>) of a definition's header — parameter names dropped, so to_regprocedure() can match it exactly. */
function signatureOf(fn: string, definition: string): string {
  const args = definition.match(new RegExp(String.raw`^CREATE OR REPLACE FUNCTION public\.${fn}\(([^)]*)\)`))?.[1] ?? "";
  const types = args.split(",").map((a) => a.trim()).filter(Boolean).map((a) => {
    const t = a.split(/\s+/);
    return t.length > 1 ? t.slice(1).join(" ") : t[0];
  });
  return `public.${fn}(${types.join(", ")})`;
}
const installed = async (signature: string) =>
  Boolean(((await own.$queryRawUnsafe(`SELECT to_regprocedure($1) IS NOT NULL AS ok`, signature)) as { ok: boolean }[])[0].ok);
async function mirrorMissingEraseFunctions(): Promise<string[]> {
  const migrations = await labMigrations();
  const mirrored: string[] = [];
  for (const fn of await requiredEraseFunctions()) {
    // The definition is always taken first: a required function that no migration defines fails here, installed or not.
    const body = definitionFromMigrations(fn, migrations);
    const sig = signatureOf(fn, body);
    if (await installed(sig)) continue;
    // Created by the lab superuser (the lab owner holds no CREATE on the schema), then owned by the table owner, as
    // the migration role owns it in Production.
    const sup = new PrismaClient({ datasources: { db: { url: process.env.SUPER_URL } } });
    try {
      await sup.$executeRawUnsafe(body);
      await sup.$executeRawUnsafe(`ALTER FUNCTION ${sig} OWNER TO lab_owner`);
      await sup.$executeRawUnsafe(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`);
      await sup.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION ${sig} TO app_runtime`);
    } finally {
      await sup.$disconnect();
    }
    mirrored.push(sig);
  }
  return mirrored;
}

async function main() {
  // The lab mirror itself must be honest (hard stops, not counted checks): it refuses a function no migration defines,
  // and what it installs is the migration's own text, matched by name AND argument types — never a stand-in.
  {
    const migrations = await labMigrations();
    let refusedMissing = false;
    try { definitionFromMigrations("lab_no_such_erase_function", migrations); } catch { refusedMissing = true; }
    if (!refusedMissing) throw new Error("lab mirror self-check: a function no migration defines was not refused");
    const required = await requiredEraseFunctions();
    if (!required.includes("service_storage_erasure_record_pass")) throw new Error(`lab mirror self-check: the module's record_pass is not required (${required.join(", ")})`);
    const rp = definitionFromMigrations("service_storage_erasure_record_pass", migrations);
    if (!migrations.some((m) => m.sql.includes(rp)) || !/SECURITY DEFINER/.test(rp) || rp.length < 500
        || signatureOf("service_storage_erasure_record_pass", rp) !== "public.service_storage_erasure_record_pass(integer, integer, text)") {
      throw new Error("lab mirror self-check: record_pass is not the migration's own definition with its exact signature");
    }
    console.log("lab mirror self-check: refuses an undefined function; record_pass(integer, integer, text) taken verbatim from its migration");
  }
  console.log(`lab: erase functions mirrored from their migrations: ${(await mirrorMissingEraseFunctions()).join(", ") || "none"}`);
  {
    const migrations = await labMigrations();
    for (const fn of await requiredEraseFunctions()) {
      const sig = signatureOf(fn, definitionFromMigrations(fn, migrations));
      if (!(await installed(sig))) throw new Error(`lab: required erase function ${sig} is not installed`);
    }
  }
  const N = await seed("neighbour");
  const neighbourBefore = { records: await records(N.b), bytes: await Promise.all(N.keys.map(async (k) => sha((await local.getObject(k)).body))) };

  console.log("--- S1: the real deletion, real storage ---");
  {
    const A = await seed("A");
    ok("S1 seeded: 2 letters, 1 copy, 1 event, keys, 3 committed objects", (await records(A.b)) >= 4 && A.keys.length === 3 && (await noneTouched(A.keys)));
    const r = await del(A);
    ok("S1 the deletion reports deleted", r.status === "deleted");
    ok("S1 no business-documents record of the business remains", (await records(A.b)) === 0);
    ok("S1 the job is DONE and the file rows are gone", (await jobState(A.b)) === "DONE" && (await own.businessDocumentFile.count({ where: { businessId: A.b } })) === 0);
    ok("S1 every former key holds only a data-free marker (nothing of the PDFs is left)", await allMarkers(A.b, A.keys), `listed=${(await listed(A.b)).length}`);
    const biz = await own.business.findUniqueOrThrow({ where: { id: A.b } });
    const user = await own.user.findUniqueOrThrow({ where: { id: A.u } });
    const ev = await own.learningEvent.count({ where: { businessId: A.b, eventType: "ACCOUNT_DELETED" } });
    ok("S1 the rest of the deletion is unchanged: PURGED, user anonymised, one ACCOUNT_DELETED evidence",
      biz.deletedAt !== null && user.email === `deleted-biz-${A.b}@deleted.invalid` && ev === 1, `email=${user.email} ev=${ev}`);
    ok("S1 customers are anonymised as before", (await own.customer.count({ where: { businessId: A.b, name: { startsWith: "לקוח בדיקה" } } })) === 0);
  }

  console.log("--- S2: storage down during the object stage ---");
  {
    const B = await seed("B");
    const store = new FaultyStore();
    store.down = true;
    const r = await code(() => del(B, adapterWith(store)));
    ok("S2 the deletion still completes (the database erasure is done)", r === "OK" && (await own.business.findUniqueOrThrow({ where: { id: B.b } })).deletedAt !== null, r);
    ok("S2 records are gone (the purge committed)", (await records(B.b)) === 0);
    ok("S2 the job stays open; every file DELETING with its key kept", (await jobState(B.b)) === "PURGING_OBJECTS" && (await fileStates(B.b)).every((s) => s === "DELETING") && (await fileStates(B.b)).length === 3);
    ok("S2 no object was touched while storage was down", await noneTouched(B.keys));
    const still = await sweepAccountStorageErasures({ modules: moduleWith(store) });
    ok("S2 a sweep while storage is still down leaves the job open (counted open, not an error)", (await jobState(B.b)) === "PURGING_OBJECTS" && still.open >= 1, JSON.stringify(still));
    store.down = false;
    const s1 = await sweepAccountStorageErasures({ modules: moduleWith(store) });
    ok("S2 the sweep after recovery finishes it: DONE, rows gone, only markers", (await jobState(B.b)) === "DONE" && (await fileStates(B.b)).length === 0 && (await allMarkers(B.b, B.keys)), JSON.stringify(s1));
    const s2 = await sweepAccountStorageErasures({ modules: moduleWith(store) });
    ok("S2 a second sweep changes nothing (still DONE, still only markers, no error)", (await jobState(B.b)) === "DONE" && (await allMarkers(B.b, B.keys)) && s2.errors === 0);
  }

  console.log("--- S3: the purge transaction fails after the erase call ---");
  {
    const C = await seed("C");
    const sup = new PrismaClient({ datasources: { db: { url: process.env.SUPER_URL } } });
    await sup.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.lab_fail_purge() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF current_setting('app.current_business_id', true) = '${C.b}' THEN RAISE EXCEPTION 'LAB_INJECTED_PURGE_FAILURE'; END IF; RETURN NULL; END $f$`);
    await sup.$executeRawUnsafe(`CREATE TRIGGER lab_fail_purge BEFORE UPDATE ON "ReceivingSession" FOR EACH STATEMENT EXECUTE FUNCTION public.lab_fail_purge()`);
    const r = await code(() => del(C));
    ok("S3 the deletion fails (the injected failure after business_documents_erase())", r.includes("LAB_INJECTED_PURGE_FAILURE"), r);
    ok("S3 nothing of business documents changed: no job, records intact, files COMMITTED", (await jobState(C.b)) === "NONE" && (await records(C.b)) >= 4 && (await fileStates(C.b)).every((s) => s === "COMMITTED"));
    ok("S3 no object was deleted", await noneTouched(C.keys));
    ok("S3 the business is quarantined (stage 1 committed), not purged", (await own.business.findUniqueOrThrow({ where: { id: C.b } })).deletedAt === null);
    ok("S3 meanwhile no new business-documents work can start", (await code(() => bdTx(C.b, (tx) => issueRequestKey(tx, C.b, C.u, "LETTER_SAVE")))).includes("BEING_ERASED"));
    await sup.$executeRawUnsafe(`DROP TRIGGER lab_fail_purge ON "ReceivingSession"`);
    await sup.$executeRawUnsafe(`DROP FUNCTION public.lab_fail_purge()`);
    await sup.$disconnect();
    const again = await code(() => del(C));
    ok("S3 the resumed deletion completes: records gone, job DONE, only markers", again === "OK" && (await records(C.b)) === 0 && (await jobState(C.b)) === "DONE" && (await allMarkers(C.b, C.keys)), again);
  }

  console.log("--- S4: uploads in flight ---");
  {
    const D = await seed("D");
    const store = new FaultyStore();
    const leaseA = randomUUID(), leaseB = randomUUID();
    const a = await bdTx(D.b, (tx) => createPendingFile(tx, D.b, "LETTER", leaseA));
    const bFile = await bdTx(D.b, (tx) => createPendingFile(tx, D.b, "LETTER", leaseB));
    const bytesA = Buffer.from("%PDF uploaded, not committed"), bytesB = Buffer.from("%PDF late upload");
    await uploadCreateOnce(D.b, a.objectKey, bytesA);
    const release = store.hold(bFile.objectKey);
    const late = uploadCreateOnce(D.b, bFile.objectKey, bytesB, store);
    const r = await code(() => del(D, adapterWith(store)));
    ok("S4 the deletion completes with two uploads in flight", r === "OK", r);
    release();
    const lateResult = await late.catch((e: Error) => `ERR:${e.message}`);
    ok("S4 the late create-once put is refused (the key is fenced)", lateResult === "EXISTS", String(lateResult));
    ok("S4 the uploaded-but-uncommitted object is deleted (marker in its place)", await isMarker(a.objectKey));
    ok("S4 neither upload can commit afterwards", !(await bdTx(D.b, (tx) => commitFile(tx, D.b, a.id, leaseA, bytesA)).catch(() => false))
      && !(await bdTx(D.b, (tx) => commitFile(tx, D.b, bFile.id, leaseB, bytesB)).catch(() => false)));
    ok("S4 no new file can be started for the business", (await code(() => bdTx(D.b, (tx) => createPendingFile(tx, D.b, "LETTER", randomUUID())))).includes("BEING_ERASED"));
    ok("S4 the job is DONE and only markers remain (5 keys: 3 seeded + 2 in flight)", (await jobState(D.b)) === "DONE" && (await allMarkers(D.b, [...D.keys, a.objectKey, bFile.objectKey])));
  }

  console.log("--- S5: concurrency ---");
  {
    const E = await seed("E");
    for (let i = 0; i < 4; i++) {
      const lease = randomUUID();
      const bytes = Buffer.from(`%PDF extra ${i}`);
      const f = await bdTx(E.b, (tx) => createPendingFile(tx, E.b, "LETTER", lease));
      await uploadCreateOnce(E.b, f.objectKey, bytes);
      await bdTx(E.b, (tx) => commitFile(tx, E.b, f.id, lease, bytes));
      E.keys.push(f.objectKey);
    }
    const store = new FaultyStore();
    store.down = true;
    await del(E, adapterWith(store));
    store.down = false;
    const runs = await Promise.allSettled([
      runAccountStorageErasure(E.b, moduleWith(store)),
      sweepAccountStorageErasures({ modules: moduleWith(store) }),
      sweepAccountStorageErasures({ modules: moduleWith(store) }),
    ]);
    const errs = runs.flatMap((x) => (x.status === "rejected" ? [String(x.reason)] : Array.isArray(x.value) ? x.value.filter((o) => o.error).map((o) => o.error!) : x.value.errors > 0 ? ["sweep-errors"] : []));
    ok("S5 the object stage and two sweeps at once: no error, no rejection", errs.length === 0, errs.join(","));
    ok("S5 …and the result is the same as one run: DONE, 7 markers, no rows", (await jobState(E.b)) === "DONE" && (await allMarkers(E.b, E.keys)) && (await fileStates(E.b)).length === 0,
      `job=${await jobState(E.b)} files=${(await fileStates(E.b)).join("/")} keys=${E.keys.length} listed=${(await listed(E.b)).length} markers=${(await Promise.all(E.keys.map(isMarker))).filter(Boolean).length}`);
    for (let round = 1; round <= 5; round++) {
      const F = await seed(`F${round}`);
      const two = await Promise.allSettled([del(F), del(F)]);
      const markers = (await Promise.all(F.keys.map(isMarker))).filter(Boolean).length;
      ok(`S5 two deletion requests at once (round ${round}): at least one completes, and the end state is whole`,
        two.some((x) => x.status === "fulfilled") && (await records(F.b)) === 0 && (await jobState(F.b)) === "DONE" && markers === F.keys.length && (await listed(F.b)).length === F.keys.length,
        `${two.map((x) => (x.status === "fulfilled" ? x.value.status : String(x.reason).replace(/s+/g, " ").slice(-160))).join(" | ")} job=${await jobState(F.b)} records=${await records(F.b)} files=${(await fileStates(F.b)).join("/")} markers=${markers}/${F.keys.length} listed=${(await listed(F.b)).length}`);
    }
  }

  console.log("--- S6–S9 ---");
  {
    const G = await seed("G", false);
    const r = await del(G);
    ok("S6 a business with no business documents: deleted, job DONE, nothing in storage", r.status === "deleted" && (await jobState(G.b)) === "DONE" && (await listed(G.b)).length === 0);
    ok("S7 the neighbour business is untouched (records and stored bytes identical)",
      (await records(N.b)) === neighbourBefore.records && (await own.businessDocumentErasure.count({ where: { businessId: N.b } })) === 0
      && JSON.stringify(await Promise.all(N.keys.map(async (k) => sha((await local.getObject(k)).body)))) === JSON.stringify(neighbourBefore.bytes));
    const H = await seed("H", false);
    await own.business.update({ where: { id: H.b }, data: { deletionRequestedAt: new Date(), deletedAt: new Date() } });
    const sw = await sweepAccountStorageErasures();
    ok("S8 a business deleted before this wiring (no job): the sweep creates nothing and reports nothing open for it", (await jobState(H.b)) === "NONE" && sw.errors === 0, JSON.stringify(sw));
    const outcomes = await runAccountStorageErasure(H.b, [{ module: "broken", resume: async () => { throw new TypeError("boom"); } }]);
    ok("S9 a failing module is an outcome (done=false, error named), never a throw", outcomes.length === 1 && outcomes[0].done === false && outcomes[0].error === "TypeError");
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILED:\n  " + failures.join("\n  "));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => own.$disconnect());
