/**
 * Service Desk QA lists (migration 20261129090000, DRAFT) — the database guards AS the real runtime role, on the M1 lab
 * (.sd3p4/lab.sh <db>, --deploy-only, .sdm1/chain.sh <db>, then .sdqa/chain.sh <db>). Synthetic only. (Modelled on
 * .sdm1/battery.ts.)
 *
 *   S  structure: FORCE RLS on the six tables, per-operation policies (no DELETE), runtime grants (the head: SELECT /
 *      INSERT / UPDATE; every other table SELECT / INSERT), the runtime role cannot bypass RLS, businessId in every
 *      composite key, the erase function SECURITY DEFINER and not PUBLIC.
 *   L  lists: born whole (version complete at COMMIT, counts exact), journaled at each revision, revisions one at a time,
 *      archive / restore, texts bounded.
 *   V  history: a version is immutable (no update, no delete, no late check); a revision leaves every older version and
 *      what a case recorded against it byte-identical.
 *   C  the case's choice: journaled, status-preserving, before QA is passed, only the CURRENT version of an ACTIVE list
 *      of the same business, resets the QA completion, never at the opening.
 *   Q  results: per check, against the checklist the case names, REQUIRED flag as in the version, counts re-derived at
 *      COMMIT, complete only when every REQUIRED check PASSES, immutable; a case WITH a list is stamped QA-complete only
 *      by a complete record against that version; a case WITHOUT one keeps today's rule (built-in template).
 *   P  idempotency: one journal row per key per business (list journal and case journal).
 *   I  isolation.  E  erasure: refused unless deleting; not imitable; scrubs in place; structure kept; re-run safe.
 *
 * env: OWNER_URL (lab owner — fixtures), DATABASE_URL = DIRECT_URL (app_runtime_prod), TASK_REQUEST_HMAC_KEY / _ID,
 *      AUTH_TOKEN_SECRET.
 */
import { PrismaClient } from "@prisma/client";

import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { openCase, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";

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
const key = () => uuidV7(new Date());
const err = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").trim();
type S = { q: (sql: string, ...a: unknown[]) => Promise<Rows>; x: (sql: string, ...a: unknown[]) => Promise<number> };
/** Runs work AS the runtime role inside one tenant transaction (deferred checks run at its COMMIT): "OK" or the refusal. */
async function rt(b: number, work: (s: S) => Promise<unknown>): Promise<string> {
  try {
    await runtime.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      await work({ q: (sql, ...a) => tx.$queryRawUnsafe(sql, ...a) as Promise<Rows>, x: (sql, ...a) => tx.$executeRawUnsafe(sql, ...a) });
    });
    return "OK";
  } catch (e) { return `ERR:${err(e).slice(-300)}`; }
}
async function rtRows(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}
/** Lab owner, in a tenant context (FORCE RLS: the owner too sees only the tenant's rows). */
async function own(b: number, sql: string, ...a: unknown[]): Promise<Rows> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
    return (await tx.$queryRawUnsafe(sql, ...a)) as Rows;
  });
}

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sdqa-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sdqa-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await own(b, `INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;

// ── Lists ───────────────────────────────────────────────────────────────────────────────────────────────────
type Item = { key: string; label: string; required: boolean };
const ITEMS: Item[] = [
  { key: "works", label: "המערכת פועלת", required: true },
  { key: "clean", label: "האתר נקי", required: false },
  { key: "shown", label: "הוצג ללקוח", required: true },
];
type ListOpts = {
  name?: string; items?: Item[]; declare?: { itemCount?: number; requiredCount?: number }; template?: string | null;
  noEvent?: boolean; eventRevision?: number; eventUser?: number | null; actor?: string; head?: { currentVersion?: number; revision?: number; archived?: boolean };
  idem?: string; user?: number | null;
};
async function writeVersion(s: S, z: Biz, listId: number, version: number, o: ListOpts) {
  const items = o.items ?? ITEMS;
  await s.x(`INSERT INTO "ServiceQaListVersion" ("businessId", "listId", version, name, "itemCount", "requiredCount", "createdByUserId")
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, z.b, listId, version, o.name ?? "בדיקת סיום", o.declare?.itemCount ?? items.length,
    o.declare?.requiredCount ?? items.filter((i) => i.required).length, o.user === undefined ? z.u : o.user);
  for (const [i, it] of items.entries()) {
    await s.x(`INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      z.b, listId, version, i + 1, it.key, it.label, it.required);
  }
}
async function writeEvent(s: S, z: Biz, listId: number, revision: number, action: string, listVersion: number, items: Item[], o: ListOpts) {
  if (o.noEvent) return;
  await s.x(`INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
    VALUES ($1, $2, $3, $4::"ServiceQaListAction", $5, $6, $7, $8::"ServiceActor", $9, $10)`, z.b, listId, o.eventRevision ?? revision, action, listVersion,
    o.declare?.itemCount ?? items.length, o.declare?.requiredCount ?? items.filter((i) => i.required).length, o.actor ?? "OWNER_USER", o.eventUser === undefined ? z.u : o.eventUser, o.idem ?? key());
}
let lastListId = 0;
async function createList(z: Biz, o: ListOpts = {}): Promise<string> {
  return rt(z.b, async (s) => {
    const id = Number((await s.q(`INSERT INTO "ServiceQaList" ("businessId", "currentVersion", revision, "sourceTemplateId", "archivedAt")
      VALUES ($1, $2, $3, $4, ${o.head?.archived ? "now()" : "NULL"}) RETURNING id`, z.b, o.head?.currentVersion ?? 1, o.head?.revision ?? 1, o.template ?? null))[0].id);
    lastListId = id;
    await writeVersion(s, z, id, 1, o);
    await writeEvent(s, z, id, 1, "CREATE", 1, o.items ?? ITEMS, o);
  });
}
async function head(z: Biz, listId: number) {
  const r = (await own(z.b, `SELECT revision, "currentVersion", "archivedAt" IS NOT NULL a FROM "ServiceQaList" WHERE id = $1`, listId))[0];
  return { revision: Number(r.revision), version: Number(r.currentVersion), archived: r.a === true };
}
async function revise(z: Biz, listId: number, o: ListOpts & { skip?: number } = {}): Promise<string> {
  const h = await head(z, listId);
  return rt(z.b, async (s) => {
    const nv = h.version + 1 + (o.skip ?? 0);
    await s.x(`UPDATE "ServiceQaList" SET revision = revision + 1, "currentVersion" = $2, "updatedAt" = now() WHERE id = $1`, listId, nv);
    await writeVersion(s, z, listId, nv, o);
    await writeEvent(s, z, listId, h.revision + 1, "REVISE", nv, o.items ?? ITEMS, o);
  });
}
async function setArchived(z: Biz, listId: number, archived: boolean, o: ListOpts & { alsoContent?: boolean } = {}): Promise<string> {
  const h = await head(z, listId);
  const v = (await own(z.b, `SELECT "itemCount" n, "requiredCount" r FROM "ServiceQaListVersion" WHERE "listId" = $1 AND version = $2`, listId, h.version))[0];
  const items: Item[] = Array.from({ length: Number(v.n) }, (_, i) => ({ key: `k${i}`, label: "x", required: i < Number(v.r) }));
  return rt(z.b, async (s) => {
    await s.x(`UPDATE "ServiceQaList" SET revision = revision + 1, "archivedAt" = ${archived ? "now()" : "NULL"}${o.alsoContent ? `, "currentVersion" = "currentVersion" + 1` : ""} WHERE id = $1`, listId);
    await writeEvent(s, z, listId, h.revision + 1, archived ? "ARCHIVE" : "RESTORE", h.version, items, o);
  });
}

// ── Cases ───────────────────────────────────────────────────────────────────────────────────────────────────
const open = async (z: Biz, kind: "IN_SHOP" | "FIELD" | "MAINTENANCE" = "FIELD") =>
  (await openCase(z.p, { kind, customerId: z.cust, problemDescription: "תקלה סינתטית" }, { idempotencyKey: key() })).case.id;
async function caseRow(z: Biz, id: number) {
  const r = (await own(z.b, `SELECT version, status::text status, "qaListId", "qaListVersion", "qaCompletedAt" IS NOT NULL done FROM "ServiceCase" WHERE id = $1`, id))[0];
  return { version: Number(r.version), status: String(r.status), listId: r.qaListId === null ? null : Number(r.qaListId), listVersion: r.qaListVersion === null ? null : Number(r.qaListVersion), done: r.done === true };
}
const evSql = `INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore",
    "cancellationRequestedAfter", actor, "actorUserId", payload, "idempotencyKey")
  VALUES ($1, $2, $3, $4::"ServiceEventType", $5::"ServiceCaseAction", $6::"ServiceCaseStatus", $7::"ServiceCaseStatus", false, false, 'OWNER_USER', $8, $9::jsonb, $10)`;
/** A transition straight to `to` (the lab moves a case; the case machine is the application's). */
async function moveTo(z: Biz, id: number, to: string, action = "FINISH_REPAIR", eventType = "repair.finished"): Promise<string> {
  const c = await caseRow(z, id);
  return rt(z.b, async (s) => {
    await s.x(`UPDATE "ServiceCase" SET status = $2::"ServiceCaseStatus", version = version + 1 WHERE id = $1`, id, to);
    await s.x(evSql, z.b, id, c.version + 1, eventType, action, c.status, to, z.u, "{}", key());
  });
}
type ChooseOpts = { version?: number | null; noEvent?: boolean; payload?: Record<string, unknown>; statusTo?: string; keepDone?: boolean; idem?: string; extraVersion?: number };
async function choose(z: Biz, id: number, listId: number | null, o: ChooseOpts = {}): Promise<string> {
  const c = await caseRow(z, id);
  const lv = o.version !== undefined ? o.version : listId === null ? null : (await head(z, listId)).version;
  return rt(z.b, async (s) => {
    await s.x(`UPDATE "ServiceCase" SET "qaListId" = $2, "qaListVersion" = $3, ${o.keepDone ? "" : `"qaCompletedAt" = NULL, `}
        status = $4::"ServiceCaseStatus", version = version + 1 + $5 WHERE id = $1`, id, listId, lv, o.statusTo ?? c.status, o.extraVersion ?? 0);
    if (!o.noEvent) {
      await s.x(evSql, z.b, id, c.version + 1 + (o.extraVersion ?? 0), "qa.list_chosen", "CHOOSE_QA_LIST", c.status, o.statusTo ?? c.status, z.u,
        JSON.stringify(o.payload ?? { listId, listVersion: lv }), o.idem ?? key());
    }
  });
}
type Res = { key: string; result: "PASS" | "FAIL"; required: boolean; note?: string | null };
type RecOpts = {
  list?: { id: number; version: number } | null; template?: string | null; itemCount?: number; requiredMissing?: number;
  lie?: Partial<{ resultCount: number; passCount: number; failCount: number; requiredFailed: number; requiredMissing: number; itemCount: number; completed: boolean }>;
  stamp?: boolean; noEvent?: boolean; user?: number | null; extraResults?: Res[]; skipResults?: number; resultList?: { id: number; version: number } | null;
};
let lastRecordId = 0;
async function record(z: Biz, id: number, results: Res[], o: RecOpts = {}): Promise<string> {
  const c = await caseRow(z, id);
  const list = o.list === undefined ? (c.listId === null ? null : { id: c.listId, version: c.listVersion as number }) : o.list;
  const passCount = results.filter((r) => r.result === "PASS").length;
  const failCount = results.length - passCount;
  const requiredFailed = results.filter((r) => r.required && r.result === "FAIL").length;
  const requiredMissing = o.requiredMissing ?? 0;
  const completed = requiredFailed === 0 && requiredMissing === 0;
  const L = { resultCount: results.length, passCount, failCount, requiredFailed, requiredMissing, itemCount: o.itemCount ?? 3, completed, ...o.lie };
  return rt(z.b, async (s) => {
    await s.x(`UPDATE "ServiceCase" SET version = version + 1, "qaChecklist" = $2::jsonb, "qaCompletedAt" = CASE WHEN $3::boolean THEN now() ELSE NULL END WHERE id = $1`,
      id, JSON.stringify({ template: list ? `list:${list.id}:v${list.version}` : o.template ?? "FIELD.v1", results: Object.fromEntries(results.map((r) => [r.key, r.result])) }),
      o.stamp ?? L.completed);
    if (!o.noEvent) await s.x(evSql, z.b, id, c.version + 1, "qa.recorded", "RECORD_QA", c.status, c.status, z.u, JSON.stringify({ completed: L.completed }), key());
    const rid = Number((await s.q(`INSERT INTO "ServiceCaseQaRecord" ("businessId", "caseId", "caseVersion", "listId", "listVersion", "templateId", "itemCount", "resultCount",
        "passCount", "failCount", "requiredMissing", "requiredFailed", completed, "actorUserId")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`, z.b, id, c.version + 1, list?.id ?? null, list?.version ?? null,
      list ? null : o.template ?? "FIELD.v1", L.itemCount, L.resultCount, L.passCount, L.failCount, L.requiredMissing, L.requiredFailed, L.completed,
      o.user === undefined ? z.u : o.user))[0].id);
    lastRecordId = rid;
    const rl = o.resultList === undefined ? list : o.resultList;
    for (const r of [...results.slice(o.skipResults ?? 0), ...(o.extraResults ?? [])]) {
      await s.x(`INSERT INTO "ServiceCaseQaItemResult" ("businessId", "recordId", "listId", "listVersion", "itemKey", required, result, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7::"ServiceQaResult", $8)`, z.b, rid, rl?.id ?? null, rl?.version ?? null, r.key, r.required, r.result, r.note ?? null);
    }
  });
}
const ALL_PASS: Res[] = [{ key: "works", result: "PASS", required: true }, { key: "clean", result: "PASS", required: false }, { key: "shown", result: "PASS", required: true }];
const has = (out: string, re: string) => out.includes(re);
const md5Of = async (z: Biz, sql: string, ...a: unknown[]) => String((await own(z.b, `SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) h FROM (${sql}) s`, ...a))[0].h);

async function main() {
  const A = await business("a");
  const B = await business("b");
  const NEW = ["ServiceQaList", "ServiceQaListVersion", "ServiceQaListItem", "ServiceQaListEvent", "ServiceCaseQaRecord", "ServiceCaseQaItemResult"];

  console.log("S — structure");
  const rls = await q(`SELECT relname, relrowsecurity r, relforcerowsecurity f FROM pg_class WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace`, NEW);
  ok("S1 the six tables ENABLE + FORCE row-level security", rls.length === 6 && rls.every((r) => r.r === true && r.f === true), JSON.stringify(rls));
  const pol = await q(`SELECT tablename, string_agg(cmd, ',' ORDER BY cmd) c FROM pg_policies WHERE tablename = ANY($1::text[]) GROUP BY tablename`, NEW);
  ok("S2 per-operation policies SELECT / INSERT / UPDATE on each, never DELETE or ALL", pol.length === 6 && pol.every((p) => p.c === "INSERT,SELECT,UPDATE"), JSON.stringify(pol));
  const gr = await q(`SELECT table_name t, string_agg(privilege_type, ',' ORDER BY privilege_type) p FROM information_schema.role_table_grants
                       WHERE grantee = 'app_runtime' AND table_name = ANY($1::text[]) GROUP BY table_name`, NEW);
  const gmap = Object.fromEntries(gr.map((g) => [g.t, g.p]));
  ok("S3 runtime grants: the head SELECT / INSERT / UPDATE; versions, checks, journal, records, results SELECT / INSERT only; no DELETE / TRUNCATE anywhere",
    gmap.ServiceQaList === "INSERT,SELECT,UPDATE" && NEW.slice(1).every((n) => gmap[n] === "INSERT,SELECT"), JSON.stringify(gmap));
  const pub = await q(`SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name = ANY($1::text[])`, NEW);
  ok("S4 nothing granted to PUBLIC", Number(pub[0].n) === 0);
  const byp = await q(`SELECT bool_or(rolbypassrls) b, bool_or(rolsuper) s FROM pg_roles WHERE rolname IN ('app_runtime', 'app_runtime_prod')`);
  ok("S5 the runtime roles are NOBYPASSRLS and not superusers", byp[0].b === false && byp[0].s === false);
  const fks = await q(`SELECT conname, conrelid::regclass::text t, confrelid::regclass::text r,
      (SELECT array_agg(a.attname::text) FROM unnest(conkey) k JOIN pg_attribute a ON a.attrelid = conrelid AND a.attnum = k) cols
    FROM pg_constraint WHERE contype = 'f' AND (conrelid::regclass::text = ANY($1::text[]) OR conname LIKE 'ServiceCase_qa_list%')`, NEW.map((n) => `"${n}"`));
  const tenantFks = fks.filter((f) => !['"Business"', '"User"'].includes(String(f.r)));
  ok("S6 every foreign key between tenant tables carries businessId (no cross-business reference possible)",
    tenantFks.length >= 11 && tenantFks.every((f) => (f.cols as string[]).includes("businessId")), JSON.stringify(tenantFks.map((f) => [f.conname, f.cols])));
  const uq = await q(`SELECT indexrelid::regclass::text n, (SELECT array_agg(a.attname::text) FROM unnest(indkey) k JOIN pg_attribute a ON a.attrelid = indrelid AND a.attnum = k) cols
    FROM pg_index WHERE indisunique AND NOT indisprimary AND indrelid::regclass::text = ANY($1::text[])`, NEW.map((n) => `"${n}"`));
  ok("S7 every unique key of the six tables carries businessId", uq.length >= 10 && uq.every((u) => (u.cols as string[]).includes("businessId")), JSON.stringify(uq));
  const fn = await q(`SELECT prosecdef d, has_function_privilege('public', oid, 'EXECUTE') p, has_function_privilege('app_runtime', oid, 'EXECUTE') r FROM pg_proc WHERE proname = 'service_qa_lists_erase_business'`);
  ok("S8 the erase function: SECURITY DEFINER, not executable by PUBLIC, executable by the runtime", fn[0]?.d === true && fn[0]?.p === false && fn[0]?.r === true);

  console.log("L — lists");
  ok("L1 a list (head, version 1 with three checks, two REQUIRED, the CREATE event) → written", (await createList(A, { template: "VEHICLE.v1" })) === "OK");
  const L1 = lastListId;
  ok("L2 a version that holds fewer checks than it declares → SERVICE_QA_LIST_VERSION_INCOMPLETE at COMMIT",
    has(await createList(A, { declare: { itemCount: 4 } }), "SERVICE_QA_LIST_VERSION_INCOMPLETE"));
  ok("L3 a version whose REQUIRED count is not its checks' → SERVICE_QA_LIST_VERSION_INCOMPLETE",
    has(await createList(A, { declare: { requiredCount: 1 } }), "SERVICE_QA_LIST_VERSION_INCOMPLETE"));
  ok("L4 more checks than declared → SERVICE_QA_LIST_VERSION_FIXED (the version is full)",
    has(await createList(A, { declare: { itemCount: 2, requiredCount: 1 } }), "SERVICE_QA_LIST_VERSION_FIXED"));
  ok("L5 a head born at version 2 / archived → SERVICE_QA_LIST_NEW",
    has(await createList(A, { head: { currentVersion: 2, revision: 2 } }), "SERVICE_QA_LIST_NEW") && has(await createList(A, { head: { archived: true } }), "SERVICE_QA_LIST_NEW"));
  ok("L6 a list without its journal event → SERVICE_QA_LIST_NOT_JOURNALED at COMMIT", has(await createList(A, { noEvent: true }), "SERVICE_QA_LIST_NOT_JOURNALED"));
  ok("L7 an event at another revision → refused (SERVICE_QA_LIST_EVENT_MISMATCH / CHECK)", (await createList(A, { eventRevision: 2 })).startsWith("ERR"));
  ok("L8 an event without a user, or by SYSTEM → refused",
    has(await createList(A, { eventUser: null }), "SERVICE_QA_LIST_EVENT_NEW") && has(await createList(A, { actor: "SYSTEM" }), "ServiceQaListEvent_by_owner"));
  ok("L9 a version written without a user → SERVICE_QA_LIST_VERSION_NEW", has(await createList(A, { user: null }), "SERVICE_QA_LIST_VERSION_NEW"));
  ok("L10 texts bounded: blank / 121-character name, blank / 201-character / control-character label, a key that is not a token, 101 checks → refused by CHECK",
    has(await createList(A, { name: "  " }), "ServiceQaListVersion_name") && has(await createList(A, { name: "א".repeat(121) }), "ServiceQaListVersion_name")
      && has(await createList(A, { items: [{ key: "a", label: " ", required: true }] }), "ServiceQaListItem_label")
      && has(await createList(A, { items: [{ key: "a", label: "ב".repeat(201), required: true }] }), "ServiceQaListItem_label")
      && has(await createList(A, { items: [{ key: "a", label: "א\nב", required: true }] }), "ServiceQaListItem_label")
      && has(await createList(A, { items: [{ key: "Bad Key", label: "בדיקה", required: true }] }), "ServiceQaListItem_key")
      && (await createList(A, { items: Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, label: "בדיקה", required: false })) })).startsWith("ERR"));
  ok("L11 an unknown origin template token → ServiceQaList_source", has(await createList(A, { template: "vehicle; drop" }), "ServiceQaList_source"));
  ok("L12 a list whose every check is optional → written (the business decides per check)",
    (await createList(A, { items: [{ key: "a", label: "אופציונלי", required: false }] })) === "OK");
  const L_OPT = lastListId;

  console.log("V — versions and history");
  const v1 = await md5Of(A, `SELECT to_jsonb(v)::text t FROM "ServiceQaListVersion" v WHERE "listId" = $1 AND version = 1 UNION ALL SELECT to_jsonb(i)::text FROM "ServiceQaListItem" i WHERE "listId" = $1 AND "listVersion" = 1`, L1);
  ok("V1 a version cannot be updated by the runtime (no UPDATE grant) — name, check label or REQUIRED flag",
    has(await rt(A.b, (s) => s.x(`UPDATE "ServiceQaListVersion" SET name = 'אחר' WHERE "listId" = $1`, L1)), "permission denied")
      && has(await rt(A.b, (s) => s.x(`UPDATE "ServiceQaListItem" SET required = false WHERE "listId" = $1`, L1)), "permission denied"));
  ok("V2 … nor deleted", has(await rt(A.b, (s) => s.x(`DELETE FROM "ServiceQaListItem" WHERE "listId" = $1`, L1)), "permission denied")
    && has(await rt(A.b, (s) => s.x(`DELETE FROM "ServiceQaListVersion" WHERE "listId" = $1`, L1)), "permission denied")
    && has(await rt(A.b, (s) => s.x(`DELETE FROM "ServiceQaList" WHERE id = $1`, L1)), "permission denied"));
  ok("V3 even the table owner cannot update or delete a version or a check (guards), nor truncate",
    has(await own(A.b, `UPDATE "ServiceQaListItem" SET label = 'אחר' WHERE "listId" = ${L1} RETURNING 1`).then(() => "OK", (e) => err(e)), "SERVICE_QA_LIST_ITEM_FIXED")
      && has(await own(A.b, `UPDATE "ServiceQaListVersion" SET name = 'אחר' WHERE "listId" = ${L1} RETURNING 1`).then(() => "OK", (e) => err(e)), "SERVICE_QA_LIST_VERSION_FIXED")
      && has(await own(A.b, `DELETE FROM "ServiceQaListVersion" WHERE "listId" = ${L1} RETURNING 1`).then(() => "OK", (e) => err(e)), "SERVICE_QA_LIST_VERSION_FIXED")
      && has(await x(`TRUNCATE "ServiceQaListItem" CASCADE`).then(() => "OK", (e) => err(e)), "SERVICE_JOURNAL_NO_TRUNCATE"));
  ok("V4 a check added to a committed version → SERVICE_QA_LIST_VERSION_FIXED",
    has(await rt(A.b, (s) => s.x(`INSERT INTO "ServiceQaListItem" ("businessId", "listId", "listVersion", position, "itemKey", label, required) VALUES ($1, $2, 1, 4, 'late', 'מאוחר', true)`, A.b, L1)), "SERVICE_QA_LIST_VERSION_FIXED"));
  // a case checked against version 1 (C + Q below rely on it)
  const c1 = await open(A);
  ok("V5 a case in QA chooses the list (version 1, journaled) and records all PASS against it → written",
    (await moveTo(A, c1, "QA")) === "OK" && (await choose(A, c1, L1)) === "OK" && (await record(A, c1, ALL_PASS)) === "OK");
  const rec1 = await md5Of(A, `SELECT to_jsonb(r)::text t FROM "ServiceCaseQaRecord" r WHERE "caseId" = $1 UNION ALL SELECT to_jsonb(x)::text FROM "ServiceCaseQaItemResult" x JOIN "ServiceCaseQaRecord" r ON r.id = x."recordId" WHERE r."caseId" = $1`, c1);
  const NEW_ITEMS: Item[] = [{ key: "works", label: "המערכת פועלת ונבדקה", required: false }, { key: "photo", label: "צולם", required: true }];
  ok("V6 revision 2: renamed, a check removed, one added, REQUIRED flipped (new version 2, REVISE event) → written",
    (await revise(A, L1, { name: "בדיקת סיום מעודכנת", items: NEW_ITEMS })) === "OK" && (await head(A, L1)).version === 2);
  const v1after = await md5Of(A, `SELECT to_jsonb(v)::text t FROM "ServiceQaListVersion" v WHERE "listId" = $1 AND version = 1 UNION ALL SELECT to_jsonb(i)::text FROM "ServiceQaListItem" i WHERE "listId" = $1 AND "listVersion" = 1`, L1);
  const rec1after = await md5Of(A, `SELECT to_jsonb(r)::text t FROM "ServiceCaseQaRecord" r WHERE "caseId" = $1 UNION ALL SELECT to_jsonb(x)::text FROM "ServiceCaseQaItemResult" x JOIN "ServiceCaseQaRecord" r ON r.id = x."recordId" WHERE r."caseId" = $1`, c1);
  ok("V7 version 1 and its checks are byte-identical after the revision", v1 === v1after);
  ok("V8 the case still names version 1 and its recorded results are byte-identical (no retroactive change)",
    (await caseRow(A, c1)).listVersion === 1 && rec1 === rec1after);
  ok("V9 a revision that skips a version, or a version that is not the head's current → refused",
    has(await revise(A, L1, { skip: 1 }), "SERVICE_QA_LIST_REVISION")
      && has(await rt(A.b, async (s) => writeVersion(s, A, L1, 5, {})), "SERVICE_QA_LIST_VERSION_NOT_CURRENT"));
  ok("V10 a revision without its REVISE event → SERVICE_QA_LIST_NOT_JOURNALED; an event naming an older version → refused",
    has(await revise(A, L1, { noEvent: true }), "SERVICE_QA_LIST_NOT_JOURNALED")
      && (await rt(A.b, async (s) => {
        await s.x(`UPDATE "ServiceQaList" SET revision = revision + 1, "currentVersion" = "currentVersion" + 1 WHERE id = $1`, L1);
        await writeVersion(s, A, L1, 3, {});
        await s.x(`INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
          VALUES ($1, $2, 3, 'REVISE', 2, 2, 1, 'OWNER_USER', $3, $4)`, A.b, L1, A.u, key());
      })).startsWith("ERR"));
  ok("V11 the head's identity is fixed: its origin template cannot change", has(await rt(A.b, (s) => s.x(`UPDATE "ServiceQaList" SET "sourceTemplateId" = 'EXCHANGE.v1', revision = revision + 1 WHERE id = $1`, L1)), "SERVICE_QA_LIST_IDENTITY_FIXED"));

  console.log("A — archive / restore");
  ok("A1 archive (one revision, ARCHIVE event) → written; the content version stays", (await setArchived(A, L1, true)) === "OK" && (await head(A, L1)).archived && (await head(A, L1)).version === 2);
  ok("A2 an archived list is not revised", has(await revise(A, L1), "SERVICE_QA_LIST_REVISION"));
  ok("A3 archive and a content change in one revision → refused", has(await setArchived(A, L1, false, { alsoContent: true }), "SERVICE_QA_LIST_REVISION"));
  ok("A4 an ARCHIVE event for a restore → refused", (await rt(A.b, async (s) => {
    await s.x(`UPDATE "ServiceQaList" SET revision = revision + 1, "archivedAt" = NULL WHERE id = $1`, L1);
    await s.x(`INSERT INTO "ServiceQaListEvent" ("businessId", "listId", revision, action, "listVersion", "itemCount", "requiredCount", actor, "actorUserId", "idempotencyKey")
      VALUES ($1, $2, (SELECT revision FROM "ServiceQaList" WHERE id = $2), 'ARCHIVE', 2, 2, 1, 'OWNER_USER', $3, $4)`, A.b, L1, A.u, key());
  })).startsWith("ERR"));
  const cArch = await open(A);
  await moveTo(A, cArch, "QA");
  ok("A5 a case cannot choose an archived list → SERVICE_CASE_QA_LIST_NOT_CURRENT", has(await choose(A, cArch, L1), "SERVICE_CASE_QA_LIST_NOT_CURRENT"));
  ok("A6 restore (RESTORE event) → written; then revisable again", (await setArchived(A, L1, false)) === "OK" && !(await head(A, L1)).archived);
  ok("A7 the case already on version 1 keeps it through archive / restore", (await caseRow(A, c1)).listVersion === 1);

  console.log("C — the case's choice");
  ok("C1 a case cannot be opened with a list (INSERT) → SERVICE_CASE_QA_LIST_AT_OPENING",
    has(await rt(A.b, (s) => s.x(`INSERT INTO "ServiceCase" ("businessId", "caseNumber", kind, "customerId", "problemDescription", "qaListId", "qaListVersion")
      VALUES ($1, 9999, 'FIELD', $2, 'x', $3, 2)`, A.b, A.cust, L1)), "SERVICE_CASE_QA_LIST_AT_OPENING"));
  const c2 = await open(A);
  ok("C2 an OPEN case chooses the current version (2) of an active list → written", (await choose(A, c2, L1)) === "OK" && (await caseRow(A, c2)).listVersion === 2);
  ok("C3 a choice of an older version (1) → SERVICE_CASE_QA_LIST_NOT_CURRENT", has(await choose(A, c2, L1, { version: 1 }), "SERVICE_CASE_QA_LIST_NOT_CURRENT"));
  ok("C4 a choice without its qa.list_chosen event → SERVICE_CASE_QA_LIST_NOT_JOURNALED (or the event FK)", (await choose(A, c2, L_OPT, { noEvent: true })).startsWith("ERR"));
  ok("C5 an event whose payload names another list → SERVICE_CASE_QA_LIST_NOT_JOURNALED",
    has(await choose(A, c2, L_OPT, { payload: { listId: L1, listVersion: 2 } }), "SERVICE_CASE_QA_LIST_NOT_JOURNALED"));
  ok("C6 a choice together with a status change → SERVICE_CASE_QA_LIST_FIXED", has(await choose(A, c2, L_OPT, { statusTo: "CHECKED_IN" }), "SERVICE_CASE_QA_LIST_FIXED"));
  ok("C7 a choice that skips a version number → SERVICE_CASE_QA_LIST_RECORD", has(await choose(A, c2, L_OPT, { extraVersion: 1 }), "SERVICE_CASE_QA_LIST_RECORD"));
  ok("C8 back to no list (journaled, payload null) → written", (await choose(A, c2, null)) === "OK" && (await caseRow(A, c2)).listId === null);
  const half = await rt(A.b, (s) => s.x(`UPDATE "ServiceCase" SET "qaListId" = $2, version = version + 1 WHERE id = $1`, c2, L1));
  ok("C9 half a choice (list without version) → refused (the guard, behind it ServiceCase_qa_list_pair)", has(half, "SERVICE_CASE_QA_LIST") || has(half, "qa_list_pair"), half);
  ok("C10 a CHOOSE_QA_LIST that moves the status → ServiceCaseEvent_qa_list_in_place",
    has(await rt(A.b, async (s) => {
      const c = await caseRow(A, c2);
      await s.x(`UPDATE "ServiceCase" SET status = 'CHECKED_IN', version = version + 1 WHERE id = $1`, c2);
      await s.x(evSql, A.b, c2, c.version + 1, "qa.list_chosen", "CHOOSE_QA_LIST", "OPEN", "CHECKED_IN", A.u, "{}", key());
    }), "qa_list_in_place"));
  ok("C11 an action paired with another's event type (CHOOSE_QA_LIST + qa.recorded) → refused",
    (await rt(A.b, async (s) => {
      const c = await caseRow(A, c2);
      await s.x(`UPDATE "ServiceCase" SET version = version + 1 WHERE id = $1`, c2);
      await s.x(evSql, A.b, c2, c.version + 1, "qa.recorded", "CHOOSE_QA_LIST", "OPEN", "OPEN", A.u, "{}", key());
    })).startsWith("ERR"));
  // a case that really reached READY: QA → READY via PASS_QA (the outcome rule needs an outcome on READY)
  const cReady = await open(A);
  await moveTo(A, cReady, "QA");
  const cr = await caseRow(A, cReady);
  const readyMove = await rt(A.b, async (s) => {
    await s.x(`UPDATE "ServiceCase" SET status = 'READY', outcome = 'REPAIRED', "readyAt" = now(), version = version + 1 WHERE id = $1`, cReady);
    await s.x(`INSERT INTO "ServiceCaseEvent" ("businessId", "caseId", seq, "eventType", action, "fromStatus", "toStatus", "cancellationRequestedBefore",
      "cancellationRequestedAfter", outcome, actor, "actorUserId", "idempotencyKey") VALUES ($1, $2, $3, 'qa.passed', 'PASS_QA', 'QA', 'READY', false, false, 'REPAIRED', 'OWNER_USER', $4, $5)`,
      A.b, cReady, cr.version + 1, A.u, key());
  });
  ok("C12 a READY case's choice is fixed → SERVICE_CASE_QA_LIST_FIXED", readyMove === "OK" && has(await choose(A, cReady, L1), "SERVICE_CASE_QA_LIST_FIXED"), readyMove);
  ok("C13 a choice that keeps a QA completion stamp → SERVICE_CASE_QA_LIST_RECORD",
    (await rt(A.b, (s) => s.x(`UPDATE "ServiceCase" SET "qaCompletedAt" = now() WHERE id = $1`, cArch))) === "OK"
      && has(await choose(A, cArch, L_OPT, { keepDone: true }), "SERVICE_CASE_QA_LIST_RECORD"));
  ok("C14 … and a choice resets it (the new checklist is unchecked)", (await choose(A, cArch, L_OPT)) === "OK" && !(await caseRow(A, cArch)).done);

  console.log("Q — results");
  const cq = await open(A);
  await moveTo(A, cq, "QA");
  await choose(A, cq, L1); // version 2: works (optional), photo (REQUIRED)
  const V2 = { id: L1, version: 2 };
  ok("Q1 a record before QA → SERVICE_CASE_QA_RECORD_NOT_IN_QA", has(await record(A, c2, [{ key: "works", result: "PASS", required: true }], { template: "FIELD.v1", itemCount: 4 }), "SERVICE_CASE_QA_RECORD_NOT_IN_QA"));
  ok("Q2 against another version than the case's (1) → SERVICE_CASE_QA_RECORD_CHECKLIST",
    has(await record(A, cq, [{ key: "works", result: "PASS", required: true }], { list: { id: L1, version: 1 }, itemCount: 3, requiredMissing: 1 }), "SERVICE_CASE_QA_RECORD_CHECKLIST"));
  ok("Q3 a built-in template while the case names a list → SERVICE_CASE_QA_RECORD_CHECKLIST",
    has(await record(A, cq, [{ key: "works", result: "PASS", required: true }], { list: null, template: "FIELD.v1", itemCount: 4 }), "SERVICE_CASE_QA_RECORD_CHECKLIST"));
  ok("Q4 a result for a check that is not in the version (shown was removed in v2) → refused (the check FK)",
    (await record(A, cq, [{ key: "shown", result: "PASS", required: true }], { itemCount: 2, requiredMissing: 1 })).startsWith("ERR"));
  ok("Q5 a result whose REQUIRED flag is not the version's → SERVICE_CASE_QA_RESULT_REQUIRED",
    has(await record(A, cq, [{ key: "photo", result: "PASS", required: false }], { itemCount: 2 }), "SERVICE_CASE_QA_RESULT_REQUIRED"));
  ok("Q6 the REQUIRED check missing, declared as none missing (completed) → SERVICE_CASE_QA_RECORD_VERSION at COMMIT",
    has(await record(A, cq, [{ key: "works", result: "PASS", required: false }], { itemCount: 2, requiredMissing: 0 }), "SERVICE_CASE_QA_RECORD_VERSION"));
  ok("Q7 counts that are not the rows' (pass / fail / results / required failed) → refused",
    has(await record(A, cq, [{ key: "works", result: "FAIL", required: false }, { key: "photo", result: "PASS", required: true }], { itemCount: 2, lie: { passCount: 2, failCount: 0 } }), "SERVICE_CASE_QA_RECORD_COUNTS")
      && has(await record(A, cq, [{ key: "photo", result: "FAIL", required: true }], { itemCount: 2, lie: { requiredFailed: 0, completed: true }, stamp: false }), "SERVICE_CASE_QA_RECORD_COUNTS")
      && has(await record(A, cq, [{ key: "photo", result: "PASS", required: true }, { key: "works", result: "PASS", required: false }], { itemCount: 2, skipResults: 1 }), "SERVICE_CASE_QA_RECORD_COUNTS"));
  ok("Q8 'completed' that contradicts the counts → ServiceCaseQaRecord_counts",
    has(await record(A, cq, [{ key: "photo", result: "FAIL", required: true }], { itemCount: 2, lie: { completed: true }, stamp: false }), "ServiceCaseQaRecord_counts"));
  ok("Q9 the number of checks that is not the version's → SERVICE_CASE_QA_RECORD_VERSION",
    has(await record(A, cq, [{ key: "photo", result: "PASS", required: true }], { itemCount: 3 }), "SERVICE_CASE_QA_RECORD_VERSION"));
  ok("Q10 a record without its RECORD_QA event → refused at COMMIT", (await record(A, cq, [{ key: "photo", result: "PASS", required: true }], { itemCount: 2, noEvent: true })).startsWith("ERR"));
  ok("Q11 a record by no user → SERVICE_CASE_QA_RECORD_NEW", has(await record(A, cq, [{ key: "photo", result: "PASS", required: true }], { itemCount: 2, user: null }), "SERVICE_CASE_QA_RECORD_NEW"));
  ok("Q12 a result naming another checklist than its record's → SERVICE_CASE_QA_RESULT_CHECKLIST",
    has(await record(A, cq, [{ key: "works", result: "PASS", required: true }], { itemCount: 2, resultList: { id: L1, version: 1 }, requiredMissing: 1 }), "SERVICE_CASE_QA_RESULT_CHECKLIST"));
  ok("Q13 a note over 500 characters → ServiceCaseQaItemResult_note",
    has(await record(A, cq, [{ key: "photo", result: "PASS", required: true, note: "ה".repeat(501) }], { itemCount: 2 }), "ServiceCaseQaItemResult_note"));
  ok("Q14 the REQUIRED check FAILED (optional PASS) → written, not complete; stamping it complete → SERVICE_CASE_QA_INCOMPLETE",
    (await record(A, cq, [{ key: "works", result: "PASS", required: false }, { key: "photo", result: "FAIL", required: true, note: "חסר צילום" }], { itemCount: 2 })) === "OK"
      && !(await caseRow(A, cq)).done
      && has(await rt(A.b, (s) => s.x(`UPDATE "ServiceCase" SET "qaCompletedAt" = now() WHERE id = $1`, cq)), "SERVICE_CASE_QA_INCOMPLETE"));
  const failedRecord = lastRecordId;
  ok("Q15 only the REQUIRED check, PASS (optional unrecorded) → complete, stamped",
    (await record(A, cq, [{ key: "photo", result: "PASS", required: true }], { itemCount: 2 })) === "OK" && (await caseRow(A, cq)).done);
  const stored = await own(A.b, `SELECT r.completed, r."requiredFailed", r."requiredMissing", r."listVersion", x."itemKey", x.result::text res, x.required, x.note
    FROM "ServiceCaseQaRecord" r JOIN "ServiceCaseQaItemResult" x ON x."recordId" = r.id WHERE r.id = $1 ORDER BY x."itemKey"`, failedRecord);
  ok("Q16 the failed record keeps each check's result, REQUIRED flag and note per item (stored in the case's history)",
    stored.length === 2 && stored[0].itemKey === "photo" && stored[0].res === "FAIL" && stored[0].required === true && stored[0].note === "חסר צילום"
      && stored[1].itemKey === "works" && stored[1].res === "PASS" && stored[0].completed === false && Number(stored[0].requiredFailed) === 1 && Number(stored[0].listVersion) === 2,
    JSON.stringify(stored));
  ok("Q17 a result added to a committed record → SERVICE_CASE_QA_RECORD_FIXED; results and records are not updatable",
    has(await rt(A.b, (s) => s.x(`INSERT INTO "ServiceCaseQaItemResult" ("businessId", "recordId", "listId", "listVersion", "itemKey", required, result) VALUES ($1, $2, $3, 2, 'works', false, 'PASS')`, A.b, failedRecord, L1)), "SERVICE_CASE_QA_RECORD_FIXED")
      && has(await rt(A.b, (s) => s.x(`UPDATE "ServiceCaseQaItemResult" SET result = 'PASS' WHERE "recordId" = $1`, failedRecord)), "permission denied")
      && has(await own(A.b, `UPDATE "ServiceCaseQaItemResult" SET result = 'PASS' WHERE "recordId" = ${failedRecord} RETURNING 1`).then(() => "OK", (e) => err(e)), "SERVICE_CASE_QA_RESULT_FIXED")
      && has(await own(A.b, `UPDATE "ServiceCaseQaRecord" SET completed = true WHERE id = ${failedRecord} RETURNING 1`).then(() => "OK", (e) => err(e)), "SERVICE_CASE_QA_RECORD_FIXED"));
  ok("Q18 a re-choice (same list, new version after a revision) resets the stamp; the stamp needs a complete record against THAT version",
    (await revise(A, L1, { items: NEW_ITEMS })) === "OK" && (await choose(A, cq, L1)) === "OK" && !(await caseRow(A, cq)).done
      && has(await rt(A.b, (s) => s.x(`UPDATE "ServiceCase" SET "qaCompletedAt" = now() WHERE id = $1`, cq)), "SERVICE_CASE_QA_INCOMPLETE"));
  ok("Q19 a list whose every check is optional: one optional PASS completes it", await (async () => {
    const c = await open(A); await moveTo(A, c, "QA"); await choose(A, c, L_OPT);
    return (await record(A, c, [{ key: "a", result: "PASS", required: false }], { itemCount: 1 })) === "OK" && (await caseRow(A, c)).done;
  })());
  ok("Q20 a case WITHOUT a list: the built-in template record (today's behaviour) is written and stamps completion as before",
    await (async () => {
      const c = await open(A); await moveTo(A, c, "QA");
      return (await record(A, c, [{ key: "system_tested", result: "PASS", required: true }], { list: null, template: "FIELD.v1", itemCount: 4, requiredMissing: 0 })) === "OK" && (await caseRow(A, c)).done
        && (await rt(A.b, (s) => s.x(`UPDATE "ServiceCase" SET "qaCompletedAt" = now() WHERE id = $1`, c))) === "OK";
    })());
  ok("Q21 a template id that is not a token → ServiceCaseQaRecord_checklist", await (async () => {
    const c = await open(A); await moveTo(A, c, "QA");
    return has(await record(A, c, [{ key: "a", result: "PASS", required: true }], { list: null, template: "field v1", itemCount: 1 }), "ServiceCaseQaRecord_checklist");
  })());
  void V2;

  console.log("P — idempotency");
  const dupKey = key();
  const p1a = await createList(A, { idem: dupKey });
  const p1b = await createList(A, { idem: dupKey });
  ok("P1 the lists journal holds one event per key per business (a reused key → refused by the unique key)", p1a === "OK" && p1b.startsWith("ERR") && (p1b.includes("idempotencyKey") || p1b.includes("23505")), p1b);
  const ck = key();
  const cP = await open(A);
  ok("P2 the case journal: a reused key for a second choice → refused (unique key)",
    (await choose(A, cP, L_OPT, { idem: ck })) === "OK" && (await choose(A, cP, null, { idem: ck })).startsWith("ERR"));
  ok("P3 B may reuse A's key (the key is per business)", (await createList(B, { idem: dupKey })) === "OK");
  const LB = lastListId;

  console.log("I — isolation");
  const seen = await rtRows(B.b, `SELECT (SELECT count(*) FROM "ServiceQaList" WHERE "businessId" = $1)::int l, (SELECT count(*) FROM "ServiceQaListItem" WHERE "businessId" = $1)::int i,
      (SELECT count(*) FROM "ServiceCaseQaRecord" WHERE "businessId" = $1)::int r, (SELECT count(*) FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1)::int x,
      (SELECT count(*) FROM "ServiceQaListEvent" WHERE "businessId" = $1)::int e, (SELECT count(*) FROM "ServiceQaListVersion" WHERE "businessId" = $1)::int v`, A.b);
  ok("I1 business B reads none of A's lists, versions, checks, journal, records or results", Object.values(seen[0]).every((n) => Number(n) === 0), JSON.stringify(seen));
  ok("I2 B cannot write a row in A's name (RLS WITH CHECK)", (await rt(B.b, (s) => s.x(`INSERT INTO "ServiceQaList" ("businessId", "currentVersion", revision) VALUES ($1, 1, 1)`, A.b))).includes("row-level security"));
  ok("I3 B cannot add a version to A's list under its own id (no such list in B)", (await rt(B.b, async (s) => writeVersion(s, B, L1, 4, {}))).startsWith("ERR"));
  const cB = await open(B);
  ok("I4 B's case cannot choose A's list (no such list / version in B)", (await choose(B, cB, L1, { version: 4 })).startsWith("ERR"));
  ok("I5 A's case cannot choose B's list", (await choose(A, c2, LB, { version: 1 })).startsWith("ERR"));
  ok("I6 a version / record naming a user of another business → SERVICE_USER_OTHER_BUSINESS",
    has(await createList(A, { user: B.u }), "SERVICE_USER_OTHER_BUSINESS") && has(await createList(A, { eventUser: B.u }), "SERVICE_USER_OTHER_BUSINESS"));
  ok("I7 B cannot archive A's list (invisible: 0 rows)", (await rt(B.b, (s) => s.x(`UPDATE "ServiceQaList" SET "archivedAt" = now(), revision = revision + 1 WHERE id = $1`, L1))) === "OK"
    && !(await head(A, L1)).archived);

  console.log("E — erasure");
  const early = await rt(A.b, (s) => s.q(`SELECT public.service_qa_lists_erase_business()`));
  ok("E1 erasure is refused while the business is not being deleted", has(early, "SERVICE_QA_ERASURE_NOT_DELETING"), early);
  const noCtx = await runtime.$queryRawUnsafe(`SELECT public.service_qa_lists_erase_business()`).then(() => "OK", (e) => err(e));
  ok("E2 … and without a tenant context", has(noCtx, "SERVICE_QA_ERASURE_NO_CONTEXT"), noCtx);
  const imitate = await rt(A.b, async (s) => { await s.q(`SELECT set_config('dubiz.service_qa_erasure', 'on', true)`); await s.x(`UPDATE "ServiceQaList" SET "sourceTemplateId" = NULL, revision = revision + 1 WHERE id = $1`, L1); });
  ok("E3 the runtime cannot imitate the scrub by setting the marker itself", imitate.startsWith("ERR"), imitate);
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, A.b);
  ok("E4 nothing new is written for a business being deleted", has(await createList(A), "SERVICE_UI_BUSINESS_DELETING"));
  const structBefore = await md5Of(A, `SELECT ("listId", version, "itemCount", "requiredCount")::text t FROM "ServiceQaListVersion" WHERE "businessId" = $1
      UNION ALL SELECT ("listId", "listVersion", position, "itemKey", required)::text FROM "ServiceQaListItem" WHERE "businessId" = $1
      UNION ALL SELECT ("recordId", "itemKey", required, result)::text FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1
      UNION ALL SELECT ("caseId", "caseVersion", "listId", "listVersion", "templateId", completed)::text FROM "ServiceCaseQaRecord" WHERE "businessId" = $1`, A.b);
  let n = -1; let out = "OK";
  try { n = Number((await rtRows(A.b, `SELECT public.service_qa_lists_erase_business() AS n`))[0].n); } catch (e) { out = err(e); }
  const left = (await own(A.b, `SELECT
      (SELECT count(*) FROM "ServiceQaListVersion" WHERE "businessId" = $1 AND (name IS NOT NULL OR "createdByUserId" IS NOT NULL OR "erasedAt" IS NULL))::int v,
      (SELECT count(*) FROM "ServiceQaListItem" WHERE "businessId" = $1 AND (label IS NOT NULL OR "erasedAt" IS NULL))::int i,
      (SELECT count(*) FROM "ServiceQaListEvent" WHERE "businessId" = $1 AND ("actorUserId" IS NOT NULL OR "requestDigest" IS NOT NULL))::int e,
      (SELECT count(*) FROM "ServiceCaseQaRecord" WHERE "businessId" = $1 AND ("actorUserId" IS NOT NULL OR "erasedAt" IS NULL))::int r,
      (SELECT count(*) FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1 AND (note IS NOT NULL OR "erasedAt" IS NULL))::int x,
      (SELECT count(*) FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1)::int xn`, A.b))[0];
  const structAfter = await md5Of(A, `SELECT ("listId", version, "itemCount", "requiredCount")::text t FROM "ServiceQaListVersion" WHERE "businessId" = $1
      UNION ALL SELECT ("listId", "listVersion", position, "itemKey", required)::text FROM "ServiceQaListItem" WHERE "businessId" = $1
      UNION ALL SELECT ("recordId", "itemKey", required, result)::text FROM "ServiceCaseQaItemResult" WHERE "businessId" = $1
      UNION ALL SELECT ("caseId", "caseVersion", "listId", "listVersion", "templateId", completed)::text FROM "ServiceCaseQaRecord" WHERE "businessId" = $1`, A.b);
  ok("E5 names, labels, notes and who acted are blanked in place; erasedAt stamped",
    out === "OK" && n > 0 && Number(left.v) === 0 && Number(left.i) === 0 && Number(left.e) === 0 && Number(left.r) === 0 && Number(left.x) === 0 && Number(left.xn) >= 5,
    `${out} ${n} ${JSON.stringify(left)}`);
  ok("E6 the structure stays: versions, keys, REQUIRED flags, results and counts are byte-identical", structBefore === structAfter);
  const again = Number((await rtRows(A.b, `SELECT public.service_qa_lists_erase_business() AS n`))[0].n);
  ok("E7 re-run safe (0 rows the second time)", again === 0, String(again));
  const bLeft = await own(B.b, `SELECT count(*)::int n FROM "ServiceQaListVersion" WHERE "businessId" = $1 AND name IS NOT NULL`, B.b);
  ok("E8 another business is untouched", Number(bLeft[0].n) === 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
