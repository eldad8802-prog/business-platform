/**
 * Notification engine follow-up — what migration 20261211090000_notification_engine_followup does, measured with the
 * real role topology on a Production-shaped database (.nte2/lab.sh <db> --with-nte2, which chains the foundation lab
 * .nte/lab.sh --with-nte):
 *   owner   (lab_owner: the migration role, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth).
 *
 *   1. task_reminders_due_excluding as the runtime WITHOUT a tenant context: identifiers only; exactly
 *      task_reminders_due()'s rows when nothing is excluded (same conditions, same order); the excluded businesses
 *      left out — and with them the starvation: 150 earlier reminders of a flag-off business no longer hide another
 *      business's reminder; deleted / deletion-requested businesses, done / sent / erased / future reminders never;
 *      NULL exclude = none; the LIMIT clamp (1..500); another role cannot EXECUTE it.
 *   2. Catalog: SECURITY DEFINER, STABLE, search_path pinned, EXECUTE for app_runtime alone.
 *   3. The owed-push index in notification_push_due()'s order: NULLS FIRST, partial; the planner can serve the due
 *      query's ORDER BY from it without a sort; the foundation's index is kept.
 *   4. The cascade indexes exist and the cascades still work (a device deleted takes its deliveries; a user deleted
 *      takes their notifications and deliveries).
 *   5. The feature notifications_engine: defined OFF, policy OFF; a per-business override can now be written (its
 *      foreign key to the definition is satisfied) and the runtime reads policy + its own override in its tenant.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network.
 */
import { PrismaClient, Prisma } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });

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
  }).catch((e: Error) => `ERR ${e.message}`);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const isErr = (r: unknown): r is string => typeof r === "string" && r.startsWith("ERR ");
const why = (r: unknown) => (isErr(r) ? r.slice(0, 220) : J(r).slice(0, 220));

const NOW = "2026-12-15 10:00:00";
const due = (client: PrismaClient, limit: number, exclude: string) =>
  q(client, null, `SELECT "businessId", "taskId", "remindAt" FROM public.task_reminders_due_excluding('${NOW}'::timestamp(3), ${limit}, ${exclude})`);
const plain = (limit: number) =>
  q(runtime, null, `SELECT "businessId", "taskId", "remindAt" FROM public.task_reminders_due('${NOW}'::timestamp(3), ${limit})`);

async function main() {
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const biz = (name: string) => mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
  const bizOn = await biz("nte2-on");
  const bizOff = await biz("nte2-off");
  const bizDel = await biz("nte2-deleted");
  const bizReq = await biz("nte2-deletion-requested");
  const userOn = await mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ('on@nte2.lab', 'x', $1, now()) RETURNING "id"`, bizOn);
  const task = (b: number, title: string, remindAt: string) =>
    mk(`INSERT INTO "Task" ("businessId", "title", "status", "remindAt", "updatedAt") VALUES ($1, $2, 'OPEN', $3::timestamp(3), now()) RETURNING "id"`, b, title, remindAt);

  // ── 1. the function's behaviour ────────────────────────────────────────────────────────────────────────────────
  console.log("1. task_reminders_due_excluding as the runtime, no tenant context");
  await owner.$executeRawUnsafe(`INSERT INTO "Task" ("businessId", "title", "status", "remindAt", "updatedAt")
    SELECT $1, 'off-' || g, 'OPEN', '2026-12-15 08:00:00'::timestamp(3), now() FROM generate_series(1, 150) g`, bizOff);
  const onTask = await task(bizOn, "on-due", "2026-12-15 09:59:00");
  await task(bizOn, "on-future", "2026-12-15 10:01:00");
  const sent = await task(bizOn, "on-sent", "2026-12-15 09:00:00");
  await owner.$executeRawUnsafe(`UPDATE "Task" SET "reminderSentAt" = now() WHERE "id" = $1`, sent);
  const doneT = await task(bizOn, "on-done", "2026-12-15 09:00:00");
  await owner.$executeRawUnsafe(`UPDATE "Task" SET "status" = 'DONE' WHERE "id" = $1`, doneT);
  await task(bizDel, "del-due", "2026-12-15 07:00:00");
  await task(bizReq, "req-due", "2026-12-15 07:00:00");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now(), "deletedAt" = now() WHERE "id" = $1`, bizDel);
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" = $1`, bizReq);

  const p100 = await plain(100);
  ok("(the gap) the plain task_reminders_due top 100 is all the flag-off business's", rows(p100).length === 100 && rows(p100).every((r) => Number(r.businessId) === bizOff), why(p100));
  const e100 = await due(runtime, 100, `ARRAY[${bizOff}]::int[]`);
  ok("excluding it: the other business's due reminder is found", rows(e100).some((r) => Number(r.taskId) === onTask), why(e100));
  ok("excluding it: none of the excluded business's rows", rows(e100).every((r) => Number(r.businessId) !== bizOff));
  ok("identifiers only: exactly businessId, taskId, remindAt", rows(e100).length > 0 && J(Object.keys(rows(e100)[0]).sort()) === J(["businessId", "remindAt", "taskId"]));
  const all500 = await due(runtime, 500, `ARRAY[]::int[]`);
  const plain500 = await plain(500);
  ok("nothing excluded ⇒ exactly task_reminders_due()'s rows, same order", !isErr(all500) && J(all500) === J(plain500), why(all500));
  const nul = await due(runtime, 500, `NULL`);
  ok("NULL exclude ⇒ nothing excluded", J(nul) === J(plain500));
  const ids = rows(all500).map((r) => Number(r.taskId));
  ok("future, sent and done reminders never listed", !ids.includes(sent) && !ids.includes(doneT) && rows(all500).every((r) => new Date(String(r.remindAt instanceof Date ? r.remindAt.toISOString() : r.remindAt)).getTime() <= Date.parse("2026-12-15T10:00:00Z")), why(all500));
  ok("deleted / deletion-requested businesses never listed", rows(all500).every((r) => ![bizDel, bizReq].includes(Number(r.businessId))));
  const order = rows(all500).map((r) => `${(r.remindAt instanceof Date ? r.remindAt : new Date(String(r.remindAt))).toISOString()}|${String(r.taskId).padStart(10, "0")}`);
  ok("ordered by remindAt, id", J(order) === J([...order].sort()));
  ok("LIMIT clamp: 0 → 1", rows(await due(runtime, 0, `NULL`)).length === 1);
  ok("LIMIT clamp: 10000 → at most 500", rows(await due(runtime, 10000, `NULL`)).length <= 500);
  const denied = await due(auth, 10, `NULL`);
  ok("another role (app_auth) cannot EXECUTE it", isErr(denied) && /permission denied/i.test(denied), why(denied));

  // ── 2. catalog ─────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("2. catalog");
  const fn = rows(await owner.$queryRawUnsafe(`SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
      (SELECT array_agg(pg_get_userbyid(x.grantee)::text ORDER BY 1) FROM aclexplode(p.proacl) x WHERE x.privilege_type = 'EXECUTE' AND x.grantee <> p.proowner) AS execs
    FROM pg_proc p WHERE p.proname = 'task_reminders_due_excluding'`));
  ok("SECURITY DEFINER, STABLE, search_path pg_catalog, public, pg_temp, owned by the migration role",
    fn.length === 1 && fn[0].prosecdef === true && fn[0].provolatile === "s" && J(fn[0].proconfig) === J(["search_path=pg_catalog, public, pg_temp"]) && fn[0].owner === "lab_owner", J(fn));
  ok("EXECUTE for app_runtime alone (no PUBLIC)", J(fn[0]?.execs) === J(["app_runtime"]), J(fn[0]?.execs));

  // ── 3. owed-push index ────────────────────────────────────────────────────────────────────────────────────────
  console.log("3. the owed-push index in the worker's order");
  const idx = rows(await owner.$queryRawUnsafe(`SELECT c.relname, pg_get_indexdef(c.oid) AS def FROM pg_class c
    WHERE c.relname IN ('NotificationDelivery_push_owed_due_idx', 'NotificationDelivery_push_owed_idx') ORDER BY 1`));
  ok("the new index: (nextAttemptAt NULLS FIRST, id) WHERE PENDING PUSH", idx.some((i) => i.relname === "NotificationDelivery_push_owed_due_idx"
    && /\("nextAttemptAt" NULLS FIRST, id\) WHERE \(\(status = 'PENDING'::"NotificationDeliveryStatus"\) AND \(channel = 'PUSH'::"NotificationChannel"\)\)/.test(String(i.def))), J(idx));
  ok("the foundation's index is kept", idx.some((i) => i.relname === "NotificationDelivery_push_owed_idx"));
  const plan = await inTx(owner, null, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
    await tx.$executeRawUnsafe(`SET LOCAL enable_bitmapscan = off`);
    return tx.$queryRawUnsafe(`EXPLAIN SELECT d."businessId", d."id" FROM "NotificationDelivery" d
      WHERE d."status" = 'PENDING' AND d."channel" = 'PUSH' AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= '${NOW}'::timestamp(3))
        AND (d."leaseUntil" IS NULL OR d."leaseUntil" < '${NOW}'::timestamp(3))
      ORDER BY d."nextAttemptAt" NULLS FIRST, d."id" LIMIT 100`) as Promise<Rows>;
  });
  const planText = rows(plan).map((r) => String(r["QUERY PLAN"])).join("\n");
  ok("the due query's ORDER BY is served by the new index, no sort", /NotificationDelivery_push_owed_due_idx/.test(planText) && !/\bSort\b/.test(planText), planText.slice(0, 300));

  // ── 4. cascade indexes, cascades ──────────────────────────────────────────────────────────────────────────────
  console.log("4. cascade indexes");
  const cas = rows(await owner.$queryRawUnsafe(`SELECT c.relname, pg_get_indexdef(c.oid) AS def FROM pg_class c
    WHERE c.relname IN ('NotificationDelivery_subscriptionId_idx', 'NotificationDelivery_userId_idx', 'Notification_userId_idx') ORDER BY 1`));
  ok("the three partial cascade indexes", cas.length === 3 && cas.every((i) => /WHERE \("?(subscriptionId|userId)"? IS NOT NULL\)/.test(String(i.def))), J(cas));
  const sub = await mk(`INSERT INTO "PushSubscription" ("businessId", "userId", "endpoint", "p256dh", "auth", "platform", "updatedAt")
    VALUES ($1, $2, 'https://fcm.googleapis.com/fcm/send/nte2-1', 'k', 'a', 'android', now()) RETURNING "id"`, bizOn, userOn);
  const note = await mk(`INSERT INTO "Notification" ("businessId", "userId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
      "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, $2, 'nte2:1', 'tasks', 'tasks.reminder', 'REMINDER', 'task', 1, 't', '/tasks', ARRAY['IN_APP','PUSH']::"NotificationChannel"[], 'lab', 0, now()) RETURNING "id"`, bizOn, userOn);
  await owner.$executeRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "userId", "subscriptionId")
    VALUES ($1, $2, 'PUSH', 'SENT', $3, $4), ($1, $2, 'PUSH', 'PENDING', $3, NULL)`, bizOn, note, userOn, sub);
  await owner.$executeRawUnsafe(`DELETE FROM "PushSubscription" WHERE "id" = $1`, sub);
  const left = Number(rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "NotificationDelivery" WHERE "notificationId" = $1`, note))[0].n);
  ok("a device deleted takes its delivery rows (cascade), the owed row stays", left === 1, String(left));
  await owner.$executeRawUnsafe(`DELETE FROM "Task" WHERE "businessId" = $1`, bizOn);
  await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userOn);
  const gone = Number(rows(await owner.$queryRawUnsafe(`SELECT (SELECT count(*) FROM "Notification" WHERE "id" = $1) + (SELECT count(*) FROM "NotificationDelivery" WHERE "notificationId" = $1) AS n`, note))[0].n);
  ok("a user deleted takes their notification and deliveries (cascade)", gone === 0, String(gone));

  // ── 5. the feature ─────────────────────────────────────────────────────────────────────────────────────────────
  console.log("5. the feature notifications_engine");
  const def = rows(await owner.$queryRawUnsafe(`SELECT d."defaultEnabled", d."mutable", d."category", p."globalEnabled", p."emergencyDisabled"
    FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" = 'notifications_engine'`));
  ok("defined OFF (defaultEnabled false, mutable), policy OFF (globalEnabled false, not emergency-disabled)",
    def.length === 1 && def[0].defaultEnabled === false && def[0].mutable === true && def[0].globalEnabled === false && def[0].emergencyDisabled === false, J(def));
  const ovr = await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'notifications_engine', 'ENABLED', now())`, bizOff)
    .then(() => "ok").catch((e: Error) => `ERR ${e.message}`);
  ok("a per-business override can now be written (the definition row satisfies its key)", ovr === "ok", ovr);
  const seen = await q(runtime, bizOff, `SELECT (SELECT count(*)::int FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine') AS o,
      (SELECT count(*)::int FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'notifications_engine') AS p,
      (SELECT max("updatedAt") FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine') AS at`);
  ok("the runtime, in that business's tenant, reads the policy and its own override (the engine's cutover inputs)",
    !isErr(seen) && rows(seen)[0].o === 1 && rows(seen)[0].p === 1 && rows(seen)[0].at !== null, why(seen));
  const other = await q(runtime, bizReq, `SELECT count(*)::int AS o FROM "BusinessFeatureAccess" WHERE "featureKey" = 'notifications_engine'`);
  ok("…and not another business's override", !isErr(other) && rows(other)[0].o === 0, why(other));

  console.log(`\nnotification engine follow-up battery: ${pass} PASS, ${failures.length} FAIL`);
  await Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : e); process.exit(1); });
