/**
 * Service Desk QA track defaults (migration 20261130100000, DRAFT) — the database guards AS the real runtime role, on the
 * QA lists lab (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>, .sdqa/chain.sh <db>, then .sdqad/chain.sh <db>).
 * Synthetic only. (Modelled on .sdqa/battery.ts.)
 *
 *   S  structure: FORCE RLS, per-operation policies (no DELETE), runtime grants SELECT / INSERT only, the runtime role
 *      cannot bypass RLS, businessId in every composite key, the erase function SECURITY DEFINER and not PUBLIC.
 *   D  defaults: the first revision names a list; each change is exactly the next revision (no gap, no repeat); a clear
 *      (NULL) after it; an ARCHIVED list or another business's list is refused; by an owner user of the business; texts
 *      none; append-only (no UPDATE / DELETE / TRUNCATE, not even by the table owner).
 *   H  history: archiving / revising the default's list is not blocked and rewrites no default row; a case's pinned list
 *      version is untouched by a later default.
 *   P  idempotency: one row per key per business; concurrency: two writers of the same revision → exactly one wins.
 *   I  isolation.  E  erasure: refused unless deleting / without context; not imitable; scrubs in place; re-run safe.
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod).
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const key = () => `sdqad-${randomUUID()}`;
const err = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").trim();
type S = { q: (sql: string, ...a: unknown[]) => Promise<Rows>; x: (sql: string, ...a: unknown[]) => Promise<number> };
async function inTenant(client: PrismaClient, b: number, work: (s: S) => Promise<unknown>): Promise<string> {
  try {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      await work({ q: (sql, ...a) => tx.$queryRawUnsafe(sql, ...a) as Promise<Rows>, x: (sql, ...a) => tx.$executeRawUnsafe(sql, ...a) });
    });
    return "OK";
  } catch (e) { return `ERR:${err(e).slice(-300)}`; }
}
/** AS the runtime role, one tenant transaction: "OK" or the refusal. */
const rt = (b: number, work: (s: S) => Promise<unknown>) => inTenant(runtime, b, work);
/** AS the lab owner (the table owner), one tenant transaction. */
const ow = (b: number, work: (s: S) => Promise<unknown>) => inTenant(owner, b, work);
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdqad-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdqad-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust };
}
type Biz = Awaited<ReturnType<typeof business>>;

/** A QA list of the business (version 1, one REQUIRED check), written the way #1124's service writes it. */
async function list(z: Biz): Promise<number> {
  let id = 0;
  const r = await rt(z.b, async (s) => {
    id = Number((await s.q(`INSERT INTO "ServiceQaList" ("businessId", "currentVersion", revision) VALUES ($1, 1, 1) RETURNING id`, z.b))[0].id);
    await s.x(`INSERT INTO "ServiceQaListVersion" ("businessId", "listId", version, name, "itemCount", "requiredCount", "createdByUserId") VALUES ($1, $2, 1, 'בדיקת סיום', 1, 1, $3)`, z.b, id, z.u);
    await s.x(`INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required) VALUES ($1, $2, 1, 1, 'works', 'עובד', true)`, z.b, id);
    await s.x(`INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
      VALUES ($1, $2, 1, 'CREATE', 1, 1, 1, 'OWNER_USER', $3, $4)`, z.b, id, z.u, key());
  });
  if (r !== "OK") throw new Error(`list fixture: ${r}`);
  return id;
}
async function listHead(z: Biz, id: number) {
  const h = (await own(z.b, `SELECT revision, "currentVersion" v FROM "ServiceQaList" WHERE id = $1`, id))[0];
  return { revision: Number(h.revision), version: Number(h.v) };
}
async function archiveList(z: Biz, id: number, archived: boolean): Promise<string> {
  const h = await listHead(z, id);
  const c = (await own(z.b, `SELECT "itemCount" n, "requiredCount" r FROM "ServiceQaListVersion" WHERE "listId" = $1 AND version = $2`, id, h.version))[0];
  return rt(z.b, async (s) => {
    await s.x(`UPDATE "ServiceQaList" SET revision = revision + 1, "archivedAt" = ${archived ? "now()" : "NULL"} WHERE id = $1`, id);
    // the event names the current version's own counts (#1124's event guard)
    await s.x(`INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
      VALUES ($1, $2, $3, $4::"ServiceQaListAction", $5, $6, $7, 'OWNER_USER', $8, $9)`, z.b, id, h.revision + 1, archived ? "ARCHIVE" : "RESTORE", h.version, Number(c.n), Number(c.r), z.u, key());
  });
}
async function reviseList(z: Biz, id: number): Promise<string> {
  const h = await listHead(z, id);
  return rt(z.b, async (s) => {
    const nv = h.version + 1;
    await s.x(`UPDATE "ServiceQaList" SET revision = revision + 1, "currentVersion" = $2 WHERE id = $1`, id, nv);
    await s.x(`INSERT INTO "ServiceQaListVersion" ("businessId", "listId", version, name, "itemCount", "requiredCount", "createdByUserId") VALUES ($1, $2, $3, 'בדיקת סיום', 1, 0, $4)`, z.b, id, nv, z.u);
    await s.x(`INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required) VALUES ($1, $2, $3, 1, 'works', 'עובד', false)`, z.b, id, nv);
    await s.x(`INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
      VALUES ($1, $2, $3, 'REVISE', $4, 1, 0, 'OWNER_USER', $5, $6)`, z.b, id, h.revision + 1, nv, z.u, key());
  });
}

type Def = { track?: string; revision: number; listId: number | null; user?: number | null; actor?: string; idem?: string; business?: number };
const setDefault = (z: Biz, d: Def) => rt(z.b, (s) => s.x(
  `INSERT INTO "ServiceQaTrackDefault" ("businessId", track, revision, "listId", actor, "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId")
   VALUES ($1, $2, $3, $4, $5::"ServiceActor", $6, $7, $8, 'lab')`,
  d.business ?? z.b, d.track ?? "T1", d.revision, d.listId, d.actor ?? "OWNER_USER", d.user === undefined ? z.u : d.user, d.idem ?? key(), "a".repeat(64)));
async function rows(z: Biz, track = "T1") {
  return own(z.b, `SELECT revision, "listId", "actorUserId", "requestDigest" FROM "ServiceQaTrackDefault" WHERE "businessId" = $1 AND track = $2 ORDER BY revision`, z.b, track);
}
const snapshot = async (z: Biz) => JSON.stringify(await own(z.b, `SELECT * FROM "ServiceQaTrackDefault" WHERE "businessId" = $1 ORDER BY id`, z.b));

async function main() {
  const A = await business("a");
  const B = await business("b");
  const LA = await list(A);
  const LA2 = await list(A);
  const LB = await list(B);

  console.log("S — structure");
  const rls = (await q(`SELECT relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = 'ServiceQaTrackDefault'`))[0];
  ok("S1 FORCE row-level security", rls?.r === true && rls?.f === true);
  const pol = (await q(`SELECT string_agg(cmd, ',' ORDER BY cmd) c FROM pg_policies WHERE tablename = 'ServiceQaTrackDefault'`))[0];
  ok("S2 per-operation policies: SELECT / INSERT / UPDATE, no DELETE, no ALL", pol?.c === "INSERT,SELECT,UPDATE", String(pol?.c));
  const g = (await q(`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.role_table_grants WHERE table_name = 'ServiceQaTrackDefault' AND grantee = 'app_runtime'`))[0];
  ok("S3 the runtime may only read and append (SELECT, INSERT)", g?.p === "INSERT,SELECT", String(g?.p));
  const role = ((await runtime.$queryRawUnsafe(`SELECT rolbypassrls b, rolsuper s FROM pg_roles WHERE rolname = current_user`)) as Rows)[0];
  ok("S4 the runtime role cannot bypass RLS", role?.b === false && role?.s === false);
  const fn = (await q(`SELECT prosecdef d, has_function_privilege('public', oid, 'EXECUTE') pub, has_function_privilege('app_runtime', oid, 'EXECUTE') rt FROM pg_proc WHERE proname = 'service_qa_track_defaults_erase_business'`))[0];
  ok("S5 the erase function: SECURITY DEFINER, not PUBLIC, granted to app_runtime", fn?.d === true && fn?.pub === false && fn?.rt === true);
  const keys = await q(`SELECT indexdef FROM pg_indexes WHERE tablename = 'ServiceQaTrackDefault' AND indexdef LIKE '%UNIQUE%' AND indexname <> 'ServiceQaTrackDefault_pkey'`);
  ok("S6 every unique key leads with businessId", keys.length === 3 && keys.every((k) => String(k.indexdef).includes(`("businessId",`)));
  const guardPub = (await q(`SELECT bool_or(has_function_privilege('public', oid, 'EXECUTE')) p FROM pg_proc WHERE proname = 'service_qa_track_default_guard'`))[0];
  ok("S7 the guard function is not PUBLIC", guardPub?.p === false);
  const fk = (await q(`SELECT array_length(conkey, 1) n FROM pg_constraint WHERE conname = 'ServiceQaTrackDefault_list_tenant_fkey'`))[0];
  ok("S8 the list is referenced with its business (a composite, tenant-scoped key)", Number(fk?.n) === 2);

  console.log("D — defaults");
  ok("D1 the first revision of a track names an active list of the business", (await setDefault(A, { revision: 1, listId: LA })) === "OK");
  ok("D2 a revision that is not the next one is refused (gap)", (await setDefault(A, { revision: 3, listId: LA2 })).includes("SERVICE_QA_TRACK_DEFAULT_REVISION"));
  const dup = await setDefault(A, { revision: 1, listId: LA2 });
  ok("D3 the same revision again is refused", dup.includes("SERVICE_QA_TRACK_DEFAULT_REVISION") || dup.includes("unique"), dup);
  ok("D4 the next revision switches to another list", (await setDefault(A, { revision: 2, listId: LA2 })) === "OK");
  ok("D5 … and the next one clears it (no default)", (await setDefault(A, { revision: 3, listId: null })) === "OK");
  ok("D6 a first revision without a list is refused (CHECK)", (await setDefault(A, { track: "T2", revision: 1, listId: null })).includes("ServiceQaTrackDefault_first_names_list"));
  ok("D7 a track outside T1–T7 is refused (CHECK)", (await setDefault(A, { track: "T8", revision: 1, listId: LA })).includes("ServiceQaTrackDefault_track"));
  ok("D8 another business's list is refused (composite FK)", (await setDefault(A, { track: "T3", revision: 1, listId: LB })).match(/foreign key|ServiceQaTrackDefault_list_tenant_fkey|SERVICE_QA_TRACK_DEFAULT_LIST/) !== null);
  ok("D9 a SYSTEM actor is refused (by owner only)", (await setDefault(A, { track: "T3", revision: 1, listId: LA, actor: "SYSTEM" })).includes("ServiceQaTrackDefault_by_owner"));
  ok("D10 without an acting user it is refused", (await setDefault(A, { track: "T3", revision: 1, listId: LA, user: null })).includes("SERVICE_QA_TRACK_DEFAULT_NEW"));
  ok("D11 a user of another business is refused (the foundation's same-business guard)", (await setDefault(A, { track: "T3", revision: 1, listId: LA, user: B.u })).startsWith("ERR:"));
  const LARCH = await list(A);
  ok("D12 an ARCHIVED list is refused as a default", (await archiveList(A, LARCH, true)) === "OK"
    && (await setDefault(A, { track: "T4", revision: 1, listId: LARCH })).includes("SERVICE_QA_TRACK_DEFAULT_LIST"));
  ok("D13 … and accepted again once restored", (await archiveList(A, LARCH, false)) === "OK" && (await setDefault(A, { track: "T4", revision: 1, listId: LARCH })) === "OK");
  const before = await snapshot(A);
  ok("D14 the runtime cannot UPDATE a row (no grant)", (await rt(A.b, (s) => s.x(`UPDATE "ServiceQaTrackDefault" SET "listId" = $1 WHERE "businessId" = $2`, LA, A.b))).includes("permission denied"));
  ok("D15 the runtime cannot DELETE a row (no grant)", (await rt(A.b, (s) => s.x(`DELETE FROM "ServiceQaTrackDefault" WHERE "businessId" = $1`, A.b))).includes("permission denied"));
  ok("D16 even the table owner cannot UPDATE a row (append-only guard)", (await ow(A.b, (s) => s.x(`UPDATE "ServiceQaTrackDefault" SET "listId" = $1 WHERE "businessId" = $2 AND track = 'T1' AND revision = 1`, LA2, A.b))).includes("SERVICE_QA_TRACK_DEFAULT_APPEND_ONLY"));
  ok("D17 … nor DELETE one", (await ow(A.b, (s) => s.x(`DELETE FROM "ServiceQaTrackDefault" WHERE "businessId" = $1`, A.b))).includes("SERVICE_QA_TRACK_DEFAULT_APPEND_ONLY"));
  ok("D18 … nor TRUNCATE the table", (await ow(A.b, (s) => s.x(`TRUNCATE "ServiceQaTrackDefault"`))).startsWith("ERR:"));
  ok("D19 the owner cannot fake the erasure marker into an UPDATE of the list id", (await ow(A.b, async (s) => {
    await s.x(`SELECT set_config('dubiz.service_qa_erasure', 'on', true)`);
    await s.x(`UPDATE "ServiceQaTrackDefault" SET "listId" = $1, "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL WHERE "businessId" = $2 AND track = 'T1' AND revision = 1`, LA2, A.b);
  })).includes("SERVICE_QA_TRACK_DEFAULT_APPEND_ONLY"));
  ok("D20 nothing of the refused writes changed a row", (await snapshot(A)) === before);
  const r1 = await rows(A);
  ok("D21 the track's history reads back in order: LA, LA2, none", r1.map((r) => r.listId === null ? "none" : Number(r.listId)).join() === `${LA},${LA2},none`);

  console.log("H — history");
  const t5 = await setDefault(A, { track: "T5", revision: 1, listId: LA });
  const s5 = await snapshot(A);
  ok("H1 the default's list can still be revised (a new version) — the default row is untouched",
    t5 === "OK" && (await reviseList(A, LA)) === "OK" && (await snapshot(A)) === s5);
  ok("H2 … and archived — the default row is untouched (the code reads the list's state at opening)",
    (await archiveList(A, LA, true)) === "OK" && (await snapshot(A)) === s5);
  ok("H3 a further default on an archived list is refused; restored, it is accepted",
    (await setDefault(A, { track: "T5", revision: 2, listId: LA2 })) === "OK"
      && (await setDefault(A, { track: "T5", revision: 3, listId: LA })).includes("SERVICE_QA_TRACK_DEFAULT_LIST")
      && (await archiveList(A, LA, false)) === "OK" && (await setDefault(A, { track: "T5", revision: 3, listId: LA })) === "OK");

  console.log("P — idempotency and concurrency");
  const k = key();
  ok("P1 one row per request key per business", (await setDefault(A, { track: "T6", revision: 1, listId: LA, idem: k })) === "OK"
    && (await setDefault(A, { track: "T6", revision: 2, listId: LA2, idem: k })).match(/unique|idempotencyKey/i) !== null);
  ok("P2 the same key in another business is its own", (await setDefault(B, { track: "T6", revision: 1, listId: LB, idem: k })) === "OK");
  const race = await Promise.all([setDefault(A, { track: "T7", revision: 1, listId: LA }), setDefault(A, { track: "T7", revision: 1, listId: LA2 })]);
  ok("P3 two writers of the same revision: exactly one wins", race.filter((r) => r === "OK").length === 1 && (await rows(A, "T7")).length === 1, race.join(" | "));

  console.log("I — isolation");
  ok("I1 B sees none of A's defaults", (await rtRows(B.b, `SELECT count(*)::int n FROM "ServiceQaTrackDefault" WHERE "businessId" = $1`, A.b))[0].n === 0);
  ok("I2 B cannot write a default for A (RLS WITH CHECK)", (await setDefault(B, { track: "T2", revision: 1, listId: LA, user: A.u, business: A.b })).startsWith("ERR:"));
  ok("I3 without a tenant context the runtime sees nothing", (await runtime.$queryRawUnsafe(`SELECT count(*)::int n FROM "ServiceQaTrackDefault"`) as Rows)[0].n === 0);

  console.log("E — erasure");
  ok("E1 refused without a tenant context", await runtime.$queryRawUnsafe(`SELECT public.service_qa_track_defaults_erase_business()`).then(() => false, (e) => err(e).includes("NO_CONTEXT")));
  ok("E2 refused for a business that is not being deleted", (await rt(A.b, (s) => s.q(`SELECT public.service_qa_track_defaults_erase_business()`))).includes("NOT_DELETING"));
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  ok("E3 a business being deleted cannot get a new default", (await setDefault(A, { track: "T2", revision: 1, listId: LA2 })).includes("SERVICE_UI_BUSINESS_DELETING"));
  const n = Number((await rtRows(A.b, `SELECT public.service_qa_track_defaults_erase_business() AS n`))[0].n);
  const left = (await own(A.b, `SELECT count(*) FILTER (WHERE "actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL OR "digestKeyId" IS NOT NULL)::int dirty,
      count(*)::int total, count(*) FILTER (WHERE "listId" IS NOT NULL)::int lists FROM "ServiceQaTrackDefault" WHERE "businessId" = $1`, A.b))[0];
  ok("E4 who acted and the digests are blanked in place; the rows, tracks and list ids stay", n > 0 && left.dirty === 0 && Number(left.total) === n && Number(left.lists) > 0, `${n} ${JSON.stringify(left)}`);
  ok("E5 re-run safe: 0 the second time", Number((await rtRows(A.b, `SELECT public.service_qa_track_defaults_erase_business() AS n`))[0].n) === 0);
  ok("E6 B's rows were not touched", (await own(B.b, `SELECT count(*)::int n FROM "ServiceQaTrackDefault" WHERE "businessId" = $1 AND "actorUserId" IS NOT NULL`, B.b))[0].n === 1);
  ok("E7 the runtime cannot imitate the erasure (no UPDATE grant, even with the marker)", (await rt(B.b, async (s) => {
    await s.x(`SELECT set_config('dubiz.service_qa_erasure', 'on', true)`);
    await s.x(`UPDATE "ServiceQaTrackDefault" SET "actorUserId" = NULL, "requestDigest" = NULL, "digestKeyId" = NULL WHERE "businessId" = $1`, B.b);
  })).includes("permission denied"));
  const delUser = await q(`SELECT count(*)::int n FROM pg_constraint WHERE conname = 'ServiceQaTrackDefault_actorUserId_fkey' AND confdeltype = 'n'`);
  ok("E8 a deleted user's id goes NULL by the FK (the guard lets exactly that through)", delUser[0].n === 1
    && (await x(`DELETE FROM "User" WHERE id = $1`, B.u).then(() => true, () => false))
    && (await own(B.b, `SELECT count(*)::int n FROM "ServiceQaTrackDefault" WHERE "businessId" = $1 AND "actorUserId" IS NULL`, B.b))[0].n === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
