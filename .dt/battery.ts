/**
 * Daily Tasks foundation — what migration 20261018090000_daily_tasks_foundation does, measured with the real
 * role topology on a Production-shaped database:
 *   owner   (lab_owner: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   maint   (dt_maint_login: NOSUPERUSER NOBYPASSRLS, member of task_maintenance — the retention path; a lab
 *            login only, Production has none).
 *
 *   1. Catalog: FORCE RLS on every task table; per-command policies only; the exact ACL of every table and
 *      sequence (G4: "Task" = app_runtime SELECT/INSERT/UPDATE and nothing else); PUBLIC holds nothing;
 *      EXECUTE on the retention functions = task_maintenance only; the flag is OFF; Supplier's tenant key.
 *   2. Isolation, four sides, per table, as the runtime: no context → nothing visible and every write
 *      refused; own rows visible; the other business's rows invisible and unchangeable; a write naming the
 *      other business refused; DELETE refused everywhere (the fingerprint ledger: own business only).
 *   3. Cross-business references are refused by the database: series, entity links (customer, supplier,
 *      lead, document), users (trigger), journal → task / series.
 *   4. D6: one OPEN occurrence per series (partial unique index), and (seriesId, sequence) unique.
 *   5. The journal is append-only: runtime UPDATE / DELETE denied; the OWNER's UPDATE / DELETE / TRUNCATE
 *      refused by the trigger; a session marker set by the runtime opens nothing; free text in payload is
 *      refused; a deleted user's actorUserId is nulled by the FK action; a business deletion cascades.
 *   6. Retention: the runtime cannot EXECUTE; the operational functions remove exactly what is past 7 days;
 *      the three H3 functions REFUSE and change nothing while their period is NULL; with a period set (lab
 *      simulation of an approval) they touch only closed / old business-item rows and never the owner's
 *      own task history; the retention role can read or change no table directly.
 *
 * env: OWNER_URL, RUNTIME_URL, MAINT_URL. Synthetic only. ZERO network. Raw SQL only: the migration PR ships
 * no schema.prisma change (migration-first), so the generated client knows nothing of the new objects.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const maint = new PrismaClient({ datasourceUrl: process.env.MAINT_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;

async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security|violates row-level security/i;
const CHECK = /check constraint|23514/i;
const FK = /foreign key|23503/i;
const UNIQUE = /unique constraint|23505/i;
const APPEND_ONLY = /TASK_EVENT_APPEND_ONLY/;
const NOT_APPROVED = /TASK_RETENTION_NOT_APPROVED/;
const OTHER_USER = /TASK_USER_OTHER_BUSINESS/;

const GUC = `NULLIF(current_setting('app.current_business_id', true), '')::int`;
const TENANT_TABLES = ["Task", "TaskSeries", "TaskSourceState", "TaskEvent", "TaskPreferences", "TaskRequestLedger"];

let keySeq = 0;
const key = (p = "k") => `${p}${Date.now().toString(36)}${(++keySeq).toString().padStart(4, "0")}`;

async function main() {
  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const bizA = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('dt-A', now()) RETURNING "id"`);
  const bizB = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('dt-B', now()) RETURNING "id"`);
  const user = (b: number, tag: string) =>
    mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${key()}@dt.lab`, b);
  const userA = await user(bizA, "a"); const userB = await user(bizB, "b");
  const ent = async (b: number) => ({
    customer: await mk(`INSERT INTO "Customer" ("businessId", "name", "updatedAt") VALUES ($1, 'c', now()) RETURNING "id"`, b),
    supplier: await mk(`INSERT INTO "Supplier" ("businessId", "name", "updatedAt") VALUES ($1, 's', now()) RETURNING "id"`, b),
    lead: await mk(`INSERT INTO "Lead" ("businessId", "updatedAt") VALUES ($1, now()) RETURNING "id"`, b),
    document: await mk(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status") VALUES ($1, 'lab://d', 'lab', 'application/pdf', 'NEW') RETURNING "id"`, b),
  });
  const eA = await ent(bizA); const eB = await ent(bizB);
  const seriesSql = `INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "startOn", "updatedAt") VALUES ($1, 'weekly', 'DAILY', DATE '2026-10-12', now()) RETURNING "id"`;
  const seriesB = await mk(seriesSql, bizB);
  const taskB = await mk(`INSERT INTO "Task" ("businessId", "title", "updatedAt") VALUES ($1, 'b-task', now()) RETURNING "id"`, bizB);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt", "updatedAt") VALUES ($1, 'lead', 'lead:1', 'c1', 'v1', now(), now())`, bizB);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "taskId", "eventType", "actor", "idempotencyKey") VALUES ($1, $2, 'TASK_CREATED', 'SYSTEM', $3)`, bizB, taskB, key("ev"));
  await owner.$executeRawUnsafe(`INSERT INTO "TaskPreferences" ("businessId", "updatedAt") VALUES ($1, now())`, bizB);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskRequestLedger" ("businessId", "idempotencyKey", "requestDigest", "digestKeyId", "resultRef") VALUES ($1, $2, repeat('a', 64), 'k1', '{"taskId": 1}')`, bizB, key("rq"));

  // ── 1. Catalog ─────────────────────────────────────────────────────────────────────────────────
  console.log("1. catalog");
  const acl = async (rel: string) => String(rows(await owner.$queryRawUnsafe(
    `SELECT coalesce((SELECT string_agg(pg_get_userbyid(x.grantee) || '=' || x.privilege_type, ',' ORDER BY pg_get_userbyid(x.grantee) || '=' || x.privilege_type)
       FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE c.oid = $1::regclass AND x.grantee <> c.relowner), '') AS a`, rel))[0].a);
  const expectAcl: Record<string, string> = {
    '"Task"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"Task_id_seq"': "app_runtime=SELECT,app_runtime=USAGE",
    '"TaskSeries"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"TaskSourceState"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"TaskEvent"': "app_runtime=INSERT,app_runtime=SELECT",
    '"TaskPreferences"': "app_runtime=INSERT,app_runtime=SELECT,app_runtime=UPDATE",
    '"TaskRequestLedger"': "app_runtime=DELETE,app_runtime=INSERT,app_runtime=SELECT",
    '"TaskRetentionPolicy"': "",
  };
  for (const [rel, want] of Object.entries(expectAcl)) {
    const got = await acl(rel);
    ok(`ACL ${rel} is exactly {${want || "owner only"}}`, got === want, got);
  }
  const colGrants = num(await owner.$queryRawUnsafe(
    `SELECT count(*) AS n FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
      WHERE a.attrelid = ANY(ARRAY['"Task"','"TaskEvent"','"TaskSeries"','"TaskRequestLedger"']::regclass[])`));
  ok("no column-level grant on any task table", colGrants === 0, String(colGrants));
  for (const t of TENANT_TABLES) {
    const r = rows(await owner.$queryRawUnsafe(
      `SELECT c.relrowsecurity AS e, c.relforcerowsecurity AS f,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polcmd = '*') AS all_cmd,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polroles <> ARRAY[0]::oid[]) AS role_scoped,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid
                 AND coalesce(pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) NOT LIKE '%app.current_business_id%') AS off_guc
         FROM pg_class c WHERE c.oid = $1::regclass`, `"${t}"`))[0];
    ok(`${t}: RLS enabled + forced, no FOR ALL policy, every policy on the tenant GUC`,
      r.e === true && r.f === true && Number(r.all_cmd) === 0 && Number(r.role_scoped) === 0 && Number(r.off_guc) === 0,
      J(r));
  }
  const p7 = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM pg_policy WHERE polrelid = '"Task"'::regclass AND polname = 'p7w1_tenant'`));
  ok('"Task": the wave 1 FOR ALL policy p7w1_tenant is gone', p7 === 0);
  const exec = String(rows(await owner.$queryRawUnsafe(
    `SELECT coalesce(string_agg(DISTINCT pg_get_userbyid(x.grantee), ',' ORDER BY pg_get_userbyid(x.grantee)), '') AS g
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
      WHERE p.proname LIKE 'task\\_retention\\_%' AND x.grantee <> p.proowner`))[0].g);
  ok("EXECUTE on the retention functions: task_maintenance, plus app_runtime on the erasure entry point", exec === "app_runtime,task_maintenance", exec);
  const execSplit = rows(await owner.$queryRawUnsafe(
    `SELECT p.proname AS f, string_agg(pg_get_userbyid(x.grantee), ',' ORDER BY pg_get_userbyid(x.grantee)) AS g
       FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
      WHERE p.proname LIKE 'task\\_retention\\_%' AND x.grantee <> p.proowner GROUP BY p.proname ORDER BY 1`));
  ok("…exactly: the five retention entry points → task_maintenance; task_retention_erase_business → app_runtime",
    J(execSplit) === J([
      { f: "task_retention_clear_event_digests", g: "task_maintenance" },
      { f: "task_retention_clear_source_identifiers", g: "task_maintenance" },
      { f: "task_retention_erase_business", g: "app_runtime" },
      { f: "task_retention_purge_learning_events", g: "task_maintenance" },
      { f: "task_retention_purge_request_ledger", g: "task_maintenance" },
      { f: "task_retention_purge_source_state", g: "task_maintenance" },
    ]), J(execSplit));
  const runtimeExec = num(await owner.$queryRawUnsafe(
    `SELECT count(*) AS n FROM pg_proc p WHERE p.proname LIKE 'task\\_%' AND has_function_privilege('app_runtime_prod', p.oid, 'EXECUTE')
        AND p.proname LIKE 'task\\_retention\\_%' AND p.proname <> 'task_retention_erase_business'`));
  ok("app_runtime_prod cannot EXECUTE any retention function (the erasure entry point aside)", runtimeExec === 0, String(runtimeExec));
  const role = rows(await owner.$queryRawUnsafe(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'task_maintenance'`))[0];
  ok("task_maintenance is NOLOGIN NOSUPERUSER NOBYPASSRLS", role?.rolcanlogin === false && role?.rolsuper === false && role?.rolbypassrls === false);
  const flag = rows(await owner.$queryRawUnsafe(
    `SELECT d."defaultEnabled" AS d, p."globalEnabled" AS g, p."emergencyDisabled" AS e
       FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" = 'daily_tasks'`))[0];
  ok("flag daily_tasks exists and is OFF (default and global)", flag?.d === false && flag?.g === false && flag?.e === false, J(flag));
  const supKey = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'Supplier_businessId_id_key' AND contype = 'u'`));
  ok('"Supplier" carries UNIQUE ("businessId", "id")', supKey === 1);
  const policyRows = rows(await owner.$queryRawUnsafe(`SELECT "kind", "days", "basis" FROM "TaskRetentionPolicy" ORDER BY "kind"`));
  ok("retention policy: only the two operational periods are set (7 days); the three H3 periods are NULL",
    J(policyRows) === J([
      { kind: "EVENT_DIGEST", days: 7, basis: "OPERATIONAL" },
      { kind: "LEARNING_EVENTS", days: null, basis: "H3_PENDING" },
      { kind: "REQUEST_LEDGER", days: 7, basis: "OPERATIONAL" },
      { kind: "SOURCE_IDENTIFIERS", days: null, basis: "H3_PENDING" },
      { kind: "SOURCE_STATE", days: null, basis: "H3_PENDING" },
    ]), J(policyRows));

  // ── 2. Isolation (four sides), as the runtime ─────────────────────────────────────────────────
  console.log("2. isolation");
  const insertA: Record<string, [string, unknown[]]> = {
    Task: [`INSERT INTO "Task" ("businessId", "title", "updatedAt", "createdByUserId") VALUES ($1, 'mine', now(), $2) RETURNING "id"`, [bizA, userA]],
    TaskSeries: [`INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "ruleWeekdays", "startOn", "updatedAt") VALUES ($1, 'mine', 'WEEKDAYS', ARRAY[0,3], DATE '2026-10-12', now()) RETURNING "id"`, [bizA]],
    TaskSourceState: [`INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt", "updatedAt") VALUES ($1, 'lead', 'lead:7', 'c1', 'v1', now(), now()) RETURNING "id"`, [bizA]],
    TaskEvent: [`INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey", "payload") VALUES ($1, 'PREFERENCES_CHANGED', 'OWNER_USER', $2, '${key("ev")}', '{"sources": ["lead"], "count": 1}') RETURNING "id"`, [bizA, userA]],
    TaskPreferences: [`INSERT INTO "TaskPreferences" ("businessId", "updatedAt") VALUES ($1, now()) RETURNING "businessId" AS "id"`, [bizA]],
    TaskRequestLedger: [`INSERT INTO "TaskRequestLedger" ("businessId", "idempotencyKey", "requestDigest", "digestKeyId", "resultRef") VALUES ($1, '${key("rq")}', repeat('b', 64), 'k1', '{"taskId": 2}') RETURNING "id"`, [bizA]],
  };
  const idA: Record<string, number> = {};
  for (const t of TENANT_TABLES) {
    const [sql, args] = insertA[t];
    const noCtx = await q(runtime, null, sql, ...args);
    ok(`${t}: INSERT without a tenant context is refused`, refused(noCtx, RLS), String(noCtx).slice(0, 120));
    // The same row, naming business B, from A's context (a user of A where the row names one: the
    // RLS refusal must come first, before any reference check could).
    const cross = await q(runtime, bizA, sql, bizB, ...args.slice(1));
    ok(`${t}: INSERT naming the other business is refused (WITH CHECK)`, refused(cross, RLS) || refused(cross, OTHER_USER),
      String(cross).slice(0, 120));
    const mine = await q(runtime, bizA, sql, ...args);
    idA[t] = Number(rows(mine)[0]?.id);
    ok(`${t}: INSERT into the own business succeeds`, Number.isFinite(idA[t]), String(mine).slice(0, 160));
    const seenNoCtx = await q(runtime, null, `SELECT count(*) AS n FROM "${t}"`);
    ok(`${t}: nothing is visible without a context`, num(seenNoCtx) === 0, J(seenNoCtx));
    const seenA = await q(runtime, bizA, `SELECT count(*) AS n, count(*) FILTER (WHERE "businessId" <> $1) AS other FROM "${t}"`, bizA);
    ok(`${t}: inside A, A's rows are visible and B's are not`, num(seenA) >= 1 && num(seenA, "other") === 0, J(seenA));
    const delOwn = await x(runtime, bizA, `DELETE FROM "${t}" WHERE "businessId" = $1`, bizA);
    if (t === "TaskRequestLedger") ok(`${t}: the runtime may remove its own business's fingerprints (erasure)`, typeof delOwn === "number" && delOwn >= 1, String(delOwn));
    else ok(`${t}: DELETE is refused (no privilege)`, refused(delOwn, DENIED), String(delOwn).slice(0, 120));
  }
  const crossInsert = await x(runtime, bizA, `INSERT INTO "Task" ("businessId", "title", "updatedAt") VALUES ($1, 'x', now())`, bizB);
  ok('"Task": a plain INSERT for business B inside A\'s context is refused by RLS', refused(crossInsert, RLS), String(crossInsert).slice(0, 120));
  for (const t of ["Task", "TaskSeries", "TaskSourceState", "TaskPreferences"]) {
    const upB = await x(runtime, bizA, `UPDATE "${t}" SET "updatedAt" = now() WHERE "businessId" = $1`, bizB);
    ok(`${t}: an UPDATE aimed at B's rows changes nothing from A's context`, upB === 0, String(upB));
    const move = await x(runtime, bizA, `UPDATE "${t}" SET "businessId" = $2 WHERE "businessId" = $1`, bizA, bizB);
    ok(`${t}: moving an A row to business B is refused (WITH CHECK)`, refused(move, RLS) || refused(move, FK) || refused(move, /TASK_USER_OTHER_BUSINESS/), String(move).slice(0, 120));
  }
  const delLedgerB = await x(runtime, bizA, `DELETE FROM "TaskRequestLedger" WHERE "businessId" = $1`, bizB);
  ok("TaskRequestLedger: A's context cannot remove B's fingerprints", delLedgerB === 0, String(delLedgerB));
  for (const t of TENANT_TABLES) {
    const tr = await x(runtime, bizA, `TRUNCATE "${t}"`);
    ok(`${t}: TRUNCATE is refused for the runtime`, refused(tr, DENIED), String(tr).slice(0, 100));
  }
  const pol = await q(runtime, bizA, `SELECT * FROM "TaskRetentionPolicy"`);
  ok("the runtime cannot read the retention policy", refused(pol, DENIED), String(pol).slice(0, 100));

  // ── 3. Cross-business references are refused by the database ─────────────────────────────────
  console.log("3. references");
  const seriesA = idA.TaskSeries;
  const taskInsert = (cols: string, vals: string, ...args: unknown[]) =>
    x(runtime, bizA, `INSERT INTO "Task" ("businessId", "title", "updatedAt", ${cols}) VALUES ($1, 't', now(), ${vals})`, bizA, ...args);
  ok("Task → a series of business B is refused (composite FK)", refused(await taskInsert(`"seriesId", "sequence"`, `$2, 1`, seriesB), FK));
  for (const [col, idB, idOwn] of [["customerId", eB.customer, eA.customer], ["supplierId", eB.supplier, eA.supplier], ["leadId", eB.lead, eA.lead], ["documentId", eB.document, eA.document]] as const) {
    ok(`Task → ${col} of business B is refused (composite FK)`, refused(await taskInsert(`"${col}"`, `$2`, idB), FK));
    const own = await taskInsert(`"${col}"`, `$2`, idOwn);
    ok(`Task → ${col} of the own business is accepted`, own === 1, String(own).slice(0, 120));
    ok(`TaskSeries → ${col} of business B is refused (composite FK)`, refused(await x(runtime, bizA,
      `INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "startOn", "updatedAt", "${col}") VALUES ($1, 's', 'DAILY', DATE '2026-10-12', now(), $2)`, bizA, idB), FK));
  }
  ok("Task: two entity links at once are refused", refused(await taskInsert(`"customerId", "leadId"`, `$2, $3`, eA.customer, eA.lead), CHECK));
  ok("Task → a user of business B is refused (trigger)", refused(await taskInsert(`"createdByUserId"`, `$2`, userB), OTHER_USER));
  ok("Task → completedByUserId of business B is refused on UPDATE too",
    refused(await x(runtime, bizA, `UPDATE "Task" SET "completedByUserId" = $2 WHERE "id" = $1`, idA.Task, userB), OTHER_USER));
  ok("TaskSeries → a user of business B is refused (trigger)", refused(await x(runtime, bizA,
    `INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "startOn", "updatedAt", "createdByUserId") VALUES ($1, 's', 'DAILY', DATE '2026-10-12', now(), $2)`, bizA, userB), OTHER_USER));
  const evIns = (cols: string, vals: string, ...args: unknown[]) => x(runtime, bizA,
    `INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "idempotencyKey", ${cols}) VALUES ($1, 'TASK_EDITED', 'OWNER_USER', '${key("ev")}', ${vals})`, bizA, ...args);
  ok("TaskEvent → a task of business B is refused (composite FK)", refused(await evIns(`"taskId"`, `$2`, taskB), FK));
  ok("TaskEvent → a series of business B is refused (composite FK)", refused(await evIns(`"seriesId"`, `$2`, seriesB), FK));
  ok("TaskEvent → an actor of business B is refused (trigger)", refused(await evIns(`"actorUserId"`, `$2`, userB), OTHER_USER));
  ok("TaskEvent: a SYSTEM event cannot name a user", refused(await x(runtime, bizA,
    `INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey") VALUES ($1, 'SOURCE_CLOSED_OBSERVED', 'SYSTEM', $2, '${key("ev")}')`, bizA, userA), CHECK));
  ok("TaskSeries: an empty weekday list counts as none (the way Prisma writes a DAILY rule)", (await x(runtime, bizA,
    `INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "ruleWeekdays", "startOn", "updatedAt") VALUES ($1, 's', 'DAILY', '{}', DATE '2026-10-12', now())`, bizA)) === 1);
  ok("TaskSeries: a weekday rule with no day is refused", refused(await x(runtime, bizA,
    `INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "ruleWeekdays", "startOn", "updatedAt") VALUES ($1, 's', 'WEEKDAYS', '{}', DATE '2026-10-12', now())`, bizA), CHECK));
  ok("account erasure may blank a task's and a series' text in place (title '', note NULL)",
    (await x(runtime, bizA, `UPDATE "Task" SET "title" = '', "description" = NULL, "erasedAt" = now() WHERE "id" = $1`, idA.Task)) === 1
    && (await x(runtime, bizA, `UPDATE "TaskSeries" SET "title" = '', "note" = NULL, "erasedAt" = now() WHERE "id" = $1`, idA.TaskSeries)) === 1);
  ok("a title over 200 characters is refused", refused(await x(runtime, bizA, `UPDATE "Task" SET "title" = repeat('x', 201) WHERE "id" = $1`, idA.Task), CHECK));
  ok("TaskSeries: a malformed rule is refused", refused(await x(runtime, bizA,
    `INSERT INTO "TaskSeries" ("businessId", "title", "ruleKind", "ruleMonthDay", "startOn", "updatedAt") VALUES ($1, 's', 'WEEKDAYS', 5, DATE '2026-10-12', now())`, bizA), CHECK));
  ok("TaskSourceState: a key with free text is refused", refused(await x(runtime, bizA,
    `INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt", "updatedAt") VALUES ($1, 'lead', 'lead:Dana Cohen', 'c1', 'v1', now(), now())`, bizA), CHECK));

  // ── 4. D6: one open occurrence per series ─────────────────────────────────────────────────────
  console.log("4. series");
  const occ = (seq: number, status = "OPEN") => x(runtime, bizA,
    `INSERT INTO "Task" ("businessId", "title", "updatedAt", "seriesId", "sequence", "status") VALUES ($1, 'occ', now(), $2, $3, '${status}')`, bizA, seriesA, seq);
  ok("first OPEN occurrence is accepted", (await occ(1)) === 1);
  ok("a second OPEN occurrence of the same series is refused (partial unique index)", refused(await occ(2), UNIQUE));
  ok("a DONE occurrence beside the open one is accepted", (await occ(3, "DONE")) === 1);
  ok("(seriesId, sequence) is unique", refused(await occ(1, "CANCELED"), UNIQUE));
  ok("an occurrence without a sequence is refused", refused(await x(runtime, bizA,
    `INSERT INTO "Task" ("businessId", "title", "updatedAt", "seriesId") VALUES ($1, 'occ', now(), $2)`, bizA, seriesA), CHECK));

  // ── 5. The journal is append-only ─────────────────────────────────────────────────────────────
  console.log("5. journal");
  const ev = idA.TaskEvent;
  ok("runtime UPDATE on TaskEvent is denied", refused(await x(runtime, bizA, `UPDATE "TaskEvent" SET "payload" = '{}' WHERE "id" = $1`, ev), DENIED));
  ok("runtime with the retention marker still cannot UPDATE", refused(await inTx(runtime, bizA, async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('dubiz.task_retention', 'on', true)`);
    return tx.$executeRawUnsafe(`UPDATE "TaskEvent" SET "actorUserId" = NULL WHERE "id" = $1`, ev);
  }), DENIED));
  ok("OWNER UPDATE of payload is refused by the trigger", refused(await x(owner, null, `UPDATE "TaskEvent" SET "payload" = '{"a": 1}' WHERE "id" = $1`, ev), APPEND_ONLY));
  ok("OWNER nulling an identifying column outside the retention path is refused", refused(await x(owner, null, `UPDATE "TaskEvent" SET "actorUserId" = NULL WHERE "id" = $1`, ev), APPEND_ONLY));
  ok("OWNER DELETE is refused by the trigger", refused(await x(owner, null, `DELETE FROM "TaskEvent" WHERE "id" = $1`, ev), APPEND_ONLY));
  ok("OWNER TRUNCATE is refused by the trigger", refused(await x(owner, null, `TRUNCATE "TaskEvent" CASCADE`), APPEND_ONLY));
  ok("free text in payload is refused", refused(await evIns(`"payload"`, `'{"title": "call Dana about the invoice"}'`), CHECK));
  ok("a nested free-text string is refused too", refused(await evIns(`"payload"`, `'{"dates": ["2026-10-01", "not a token"]}'`), CHECK));
  ok("a payload that is not an object is refused", refused(await evIns(`"payload"`, `'[1, 2]'`), CHECK));
  ok("a token payload (enums, ids, day keys, counts) is accepted", (await evIns(`"payload"`, `'{"missed": 2, "dates": ["2026-10-01", "2026-10-02"], "reason": "SKIPPED"}'`)) === 1);
  const dupKey = key("ev");
  await evIns(`"payload"`, `'{}'`).then(() => undefined);
  const k1 = await x(runtime, bizA, `INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "idempotencyKey") VALUES ($1, 'TASK_EDITED', 'SYSTEM', $2)`, bizA, dupKey);
  const k2 = await x(runtime, bizA, `INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "idempotencyKey") VALUES ($1, 'TASK_EDITED', 'SYSTEM', $2)`, bizA, dupKey);
  ok("(businessId, idempotencyKey) is unique on the journal", k1 === 1 && refused(k2, UNIQUE));
  // FK action: deleting a user nulls actorUserId — the one non-retention UPDATE the trigger lets through.
  const doomed = await user(bizA, "doomed");
  await x(runtime, bizA, `INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey") VALUES ($1, 'TASK_EDITED', 'OWNER_USER', $2, '${key("ev")}')`, bizA, doomed);
  const delUser = await x(owner, null, `DELETE FROM "User" WHERE "id" = $1`, doomed);
  const left = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskEvent" WHERE "actorUserId" = $1`, doomed));
  const kept = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskEvent" WHERE "businessId" = $1 AND "eventType" = 'TASK_EDITED' AND "actor" = 'OWNER_USER' AND "actorUserId" IS NULL`, bizA));
  ok("deleting a user nulls its actorUserId (FK SET NULL) and keeps the events", delUser === 1 && left === 0 && kept >= 1, `${delUser}/${left}/${kept}`);
  // Business deletion cascades through every task table, journal included.
  const bizC = await mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ('dt-C', now()) RETURNING "id"`);
  const taskC = await mk(`INSERT INTO "Task" ("businessId", "title", "updatedAt") VALUES ($1, 'c', now()) RETURNING "id"`, bizC);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "taskId", "eventType", "actor", "idempotencyKey") VALUES ($1, $2, 'TASK_CREATED', 'SYSTEM', $3)`, bizC, taskC, key("ev"));
  await owner.$executeRawUnsafe(`INSERT INTO "TaskRequestLedger" ("businessId", "idempotencyKey", "requestDigest", "digestKeyId", "resultRef") VALUES ($1, $2, repeat('c', 64), 'k1', '{}')`, bizC, key("rq"));
  const delBiz = await x(owner, null, `DELETE FROM "Business" WHERE "id" = $1`, bizC);
  const residue = num(await owner.$queryRawUnsafe(
    `SELECT (SELECT count(*) FROM "Task" WHERE "businessId" = $1) + (SELECT count(*) FROM "TaskEvent" WHERE "businessId" = $1)
          + (SELECT count(*) FROM "TaskRequestLedger" WHERE "businessId" = $1) AS n`, bizC));
  ok("deleting a business cascades through tasks, journal and fingerprints (the trigger does not block it)", delBiz === 1 && residue === 0, `${delBiz}/${residue}`);

  // ── 6. Retention ─────────────────────────────────────────────────────────────────────────────
  console.log("6. retention");
  for (const fn of ["task_retention_purge_request_ledger", "task_retention_clear_event_digests", "task_retention_clear_source_identifiers", "task_retention_purge_learning_events", "task_retention_purge_source_state"]) {
    ok(`runtime cannot EXECUTE ${fn}`, refused(await q(runtime, bizA, `SELECT public.${fn}() AS n`), DENIED));
  }
  ok("the retention role cannot read the journal directly", refused(await q(maint, null, `SELECT count(*) FROM "TaskEvent"`), DENIED));
  ok("the retention role cannot change the journal directly", refused(await x(maint, null, `UPDATE "TaskEvent" SET "actorUserId" = NULL`), DENIED));
  ok("the retention role cannot read or change the policy", refused(await x(maint, null, `UPDATE "TaskRetentionPolicy" SET "days" = 1`), DENIED));
  // Operational: fingerprints and digests older than 7 days go; younger ones and everything else stay.
  const oldKey = key("rq"), newKey = key("rq");
  await owner.$executeRawUnsafe(`INSERT INTO "TaskRequestLedger" ("businessId", "idempotencyKey", "requestDigest", "digestKeyId", "resultRef", "createdAt") VALUES ($1, $2, repeat('d', 64), 'k1', '{}', now() - interval '8 days')`, bizA, oldKey);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskRequestLedger" ("businessId", "idempotencyKey", "requestDigest", "digestKeyId", "resultRef", "createdAt") VALUES ($1, $2, repeat('e', 64), 'k1', '{}', now() - interval '6 days 23 hours')`, bizA, newKey);
  const purged = num(await maint.$queryRawUnsafe(`SELECT public.task_retention_purge_request_ledger() AS n`));
  const stillOld = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskRequestLedger" WHERE "idempotencyKey" = $1`, oldKey));
  const stillNew = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskRequestLedger" WHERE "idempotencyKey" = $1`, newKey));
  ok("fingerprints older than 7 days are removed; a 6-day-23-hour one stays", purged >= 1 && stillOld === 0 && stillNew === 1, `${purged}/${stillOld}/${stillNew}`);
  const dOld = key("ev"), dNew = key("ev");
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId", "occurredAt") VALUES ($1, 'TASK_EDITED', 'OWNER_USER', $2, $3, repeat('f', 64), 'k1', now() - interval '8 days')`, bizA, userA, dOld);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId", "occurredAt") VALUES ($1, 'TASK_EDITED', 'OWNER_USER', $2, $3, repeat('f', 64), 'k1', now() - interval '1 day')`, bizA, userA, dNew);
  const before = rows(await owner.$queryRawUnsafe(`SELECT to_jsonb(e) - 'requestDigest' - 'digestKeyId' AS j FROM "TaskEvent" e WHERE "idempotencyKey" = $1`, dOld))[0].j;
  const cleared = num(await maint.$queryRawUnsafe(`SELECT public.task_retention_clear_event_digests() AS n`));
  const after = rows(await owner.$queryRawUnsafe(`SELECT "requestDigest" AS d, to_jsonb(e) - 'requestDigest' - 'digestKeyId' AS j FROM "TaskEvent" e WHERE "idempotencyKey" = $1`, dOld))[0];
  const young = rows(await owner.$queryRawUnsafe(`SELECT "requestDigest" AS d FROM "TaskEvent" WHERE "idempotencyKey" = $1`, dNew))[0];
  ok("an 8-day-old event loses its digest and nothing else; a 1-day-old one keeps it",
    cleared >= 1 && after.d === null && J(after.j) === J(before) && young.d !== null, `${cleared}`);
  // H3: the three history functions refuse while their period is NULL, and change nothing.
  const snapshot = async () => String(rows(await owner.$queryRawUnsafe(
    `SELECT md5(coalesce((SELECT string_agg(to_jsonb(e)::text, '|' ORDER BY "id") FROM "TaskEvent" e), '')
              || coalesce((SELECT string_agg(to_jsonb(s)::text, '|' ORDER BY "id") FROM "TaskSourceState" s), '')) AS h`))[0].h);
  const closedOld = key("cy");
  await owner.$executeRawUnsafe(`INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt", "closedObservedAt", "updatedAt") VALUES ($1, 'lead', 'lead:90', $2, 'v1', now() - interval '400 days', now() - interval '200 days', now())`, bizA, closedOld);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskSourceState" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "evidenceVersion", "firstSeenAt", "updatedAt") VALUES ($1, 'lead', 'lead:91', 'open1', 'v1', now() - interval '400 days', now())`, bizA);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "eventType", "actor", "actorUserId", "idempotencyKey", "occurredAt") VALUES ($1, 'lead', 'lead:90', $2, 'SOURCE_ITEM_SNOOZED', 'OWNER_USER', $3, $4, now() - interval '400 days')`, bizA, closedOld, userA, key("ev"));
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "sourceKind", "dedupeKey", "cycleKey", "eventType", "actor", "actorUserId", "idempotencyKey", "occurredAt") VALUES ($1, 'lead', 'lead:91', 'open1', 'SOURCE_ITEM_SNOOZED', 'OWNER_USER', $2, $3, now() - interval '400 days')`, bizA, userA, key("ev"));
  const manualOld = key("ev");
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "taskId", "eventType", "actor", "actorUserId", "idempotencyKey", "occurredAt") VALUES ($1, $2, 'TASK_COMPLETED', 'OWNER_USER', $3, $4, now() - interval '400 days')`, bizA, idA.Task, userA, manualOld);
  const h0 = await snapshot();
  for (const fn of ["task_retention_clear_source_identifiers", "task_retention_purge_learning_events", "task_retention_purge_source_state"]) {
    ok(`${fn} REFUSES while its H3 period is not approved`, refused(await q(maint, null, `SELECT public.${fn}() AS n`), NOT_APPROVED));
  }
  ok("…and nothing changed", (await snapshot()) === h0);
  // Lab-only simulation of an approval, to prove WHAT the functions would touch. Reset afterwards.
  await owner.$executeRawUnsafe(`UPDATE "TaskRetentionPolicy" SET "days" = 90 WHERE "kind" IN ('SOURCE_IDENTIFIERS', 'SOURCE_STATE')`);
  await owner.$executeRawUnsafe(`UPDATE "TaskRetentionPolicy" SET "days" = 365 WHERE "kind" = 'LEARNING_EVENTS'`);
  const ids = num(await maint.$queryRawUnsafe(`SELECT public.task_retention_clear_source_identifiers() AS n`));
  const closedEv = rows(await owner.$queryRawUnsafe(`SELECT "dedupeKey" AS d, "cycleKey" AS c, "actorUserId" AS u, "sourceKind" AS k, "eventType" AS t FROM "TaskEvent" WHERE "cycleKey" IS NULL AND "sourceKind" = 'lead' AND "businessId" = $1`, bizA));
  const openEv = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskEvent" WHERE "dedupeKey" = 'lead:91' AND "cycleKey" = 'open1' AND "actorUserId" IS NOT NULL`));
  ok("identifiers: a cycle closed > 90 days ago loses dedupeKey / cycleKey / actorUserId, keeps kind and type",
    ids === 1 && closedEv.length === 1 && closedEv[0].k === "lead" && closedEv[0].t === "SOURCE_ITEM_SNOOZED" && closedEv[0].u === null, `${ids} ${J(closedEv)}`);
  ok("identifiers: an open cycle is not touched, however old", openEv === 1);
  const learn = num(await maint.$queryRawUnsafe(`SELECT public.task_retention_purge_learning_events() AS n`));
  const manualKept = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskEvent" WHERE "idempotencyKey" = $1`, manualOld));
  const sourceLeft = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskEvent" WHERE "businessId" = $1 AND "sourceKind" IS NOT NULL AND "occurredAt" < now() - interval '365 days'`, bizA));
  ok("learning: business-item events older than the period are removed; the owner's own task event of the same age is kept",
    learn === 2 && manualKept === 1 && sourceLeft === 0, `${learn}/${manualKept}/${sourceLeft}`);
  const st = num(await maint.$queryRawUnsafe(`SELECT public.task_retention_purge_source_state() AS n`));
  const openState = num(await owner.$queryRawUnsafe(`SELECT count(*) AS n FROM "TaskSourceState" WHERE "cycleKey" = 'open1'`));
  ok("source state: a cycle closed > 90 days ago is removed; an open one stays", st === 1 && openState === 1, `${st}/${openState}`);
  await owner.$executeRawUnsafe(`UPDATE "TaskRetentionPolicy" SET "days" = NULL WHERE "basis" = 'H3_PENDING'`);

  // ── 7. Account erasure: the runtime's one path into the journal ──────────────────────────────
  console.log("7. account erasure");
  const erase = (guc: number | null) => q(runtime, guc, `SELECT public.task_retention_erase_business() AS n`);
  ok("erasure without a tenant context is refused", refused(await erase(null), /TASK_ERASURE_NO_CONTEXT/));
  ok("erasure of an ACTIVE business is refused", refused(await erase(bizA), /TASK_ERASURE_NOT_DELETING/));
  const keyA = key("ev"), keyB = key("ev");
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId", "payload") VALUES ($1, 'TASK_EDITED', 'OWNER_USER', $2, $3, repeat('a', 64), 'k1', '{"fields": ["title"]}')`, bizA, userA, keyA);
  await owner.$executeRawUnsafe(`INSERT INTO "TaskEvent" ("businessId", "eventType", "actor", "actorUserId", "idempotencyKey", "requestDigest", "digestKeyId") VALUES ($1, 'TASK_EDITED', 'OWNER_USER', $2, $3, repeat('b', 64), 'k1')`, bizB, userB, keyB);
  const beforeA = rows(await owner.$queryRawUnsafe(`SELECT to_jsonb(e) - 'actorUserId' - 'requestDigest' - 'digestKeyId' AS j FROM "TaskEvent" e WHERE "idempotencyKey" = $1`, keyA))[0].j;
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" = $1`, bizA);
  const erased = num(await erase(bizA));
  const afterA = rows(await owner.$queryRawUnsafe(`SELECT "actorUserId" AS u, "requestDigest" AS d, "digestKeyId" AS k, to_jsonb(e) - 'actorUserId' - 'requestDigest' - 'digestKeyId' AS j FROM "TaskEvent" e WHERE "idempotencyKey" = $1`, keyA))[0];
  const otherB = rows(await owner.$queryRawUnsafe(`SELECT "actorUserId" AS u, "requestDigest" AS d FROM "TaskEvent" WHERE "idempotencyKey" = $1`, keyB))[0];
  ok("erasure of a business being deleted nulls actorUserId and the digest, and nothing else",
    erased >= 1 && afterA.u === null && afterA.d === null && afterA.k === null && J(afterA.j) === J(beforeA), `${erased}`);
  ok("erasure never reaches another business", otherB.u === userB && otherB.d !== null);
  ok("A's context cannot erase B (B is active): refused", refused(await erase(bizB), /TASK_ERASURE_NOT_DELETING/));
  ok("the runtime still cannot change the journal directly, even for a business being deleted",
    refused(await x(runtime, bizA, `UPDATE "TaskEvent" SET "payload" = '{}' WHERE "businessId" = $1`, bizA), DENIED));
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = NULL WHERE "id" = $1`, bizA);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  - " + failures.join("\n  - ")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), runtime.$disconnect(), maint.$disconnect()]); });
