/**
 * Notification engine foundation — what migration 20261210090000_notification_engine_foundation does, measured with the
 * real role topology on a Production-shaped database (.nte/lab.sh <db> --with-nte, seeded with NTE_SEED=.nte/seed.sql):
 *   owner   (lab_owner: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (app_runtime_prod: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane),
 *   auth    (te_auth_login: NOSUPERUSER NOBYPASSRLS, member of app_auth — the sign-in plane; a lab login).
 *
 *   1. Backward compatibility: rows the application wrote BEFORE the release kept their values and got the defaults
 *      (provider WEB_PUSH, attempts 0, every new column NULL); then every write the CURRENT code issues on
 *      "PushSubscription", "Notification" and "NotificationDelivery" — through the generated Prisma client, with the
 *      same calls and shapes (subscribe / re-subscribe / revoke / push outcome / erasure; the writer's raw upsert and
 *      claim; the reminder and booking upserts; createMany / create of deliveries) — still works as the runtime.
 *   2. "PushSubscription": the provider-aware endpoint CHECK (https on WEB_PUSH, fcm:<token> on FCM, never crossed,
 *      erased:<id> on both), provider / revokedReason / appVersion shapes, the AuthSession key (SET NULL on delete).
 *   3. NotificationSettings / NotificationPreference as the runtime, four sides: no context → nothing visible and
 *      every write refused; own rows read / added / changed / removed; the other business's rows invisible and
 *      unchangeable; a row naming or moving to another business refused; TRUNCATE denied.
 *   4. Same-business user trigger on the two new tables, on Notification."userId" and NotificationDelivery."userId";
 *      the composite device key (a delivery can never name another business's device).
 *   5. CHECKs: preference key and delivery, settings minute ranges, attempts range.
 *   6. Catalog: FORCE RLS, per-command policies, the exact ACLs (app_runtime SELECT/INSERT/UPDATE/DELETE + sequence
 *      USAGE/SELECT, nothing for PUBLIC or any other role); the three functions SECURITY DEFINER, STABLE, search_path
 *      pinned, EXECUTE for app_runtime alone; the runtime cannot read "AuthSession" directly.
 *   7. Functions as the runtime WITHOUT a tenant context: notification_push_due (only PENDING PUSH, due, not leased,
 *      live businesses; order; limit clamp), notification_live_businesses (keyset pages, deleted / deletion-requested
 *      skipped), auth_sessions_live (only the ids passed in, not revoked, not idle / absolute expired, issued at the
 *      user's current token version); another role cannot EXECUTE them.
 *
 * env: OWNER_URL, RUNTIME_URL, AUTH_URL. Synthetic only. ZERO network. The generated client is the CURRENT one (the
 * migration PR ships no schema.prisma change), so the new columns are read and written with raw SQL only.
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
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const isErr = (r: unknown): r is string => typeof r === "string" && r.startsWith("ERR ");
const refused = (r: unknown, re: RegExp) => isErr(r) && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security/i;
const FK = /foreign key|23503/i;
const UNIQUE = /unique constraint|23505|Unique constraint failed/i;
const OTHER_USER = /TASK_USER_OTHER_BUSINESS|DZT03/;
const why = (r: unknown) => (isErr(r) ? r.slice(0, 220) : J(r).slice(0, 220));

const NOW = `timezone('UTC', now())::timestamp(3)`;
const FCM_TOKEN = "fGx1:APA91bH" + "a".repeat(40) + "_b-c.d:e" + "Z9".repeat(40);

async function main() {
  // ── Fixtures (owner, BYPASSRLS) ─────────────────────────────────────────────────────────────────────────────────
  const mk = async (sql: string, ...args: unknown[]) => Number(rows(await owner.$queryRawUnsafe(sql, ...args))[0].id);
  const biz = (name: string) => mk(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
  const bizA = await biz("nte-A");
  const bizB = await biz("nte-B");
  const bizD = await biz("nte-D");
  const bizE = await biz("nte-E");
  const user = (b: number, tag: string) =>
    mk(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}@nte.lab`, b);
  const userA = await user(bizA, "a"); const userA2 = await user(bizA, "a2");
  const userB = await user(bizB, "b"); await user(bizD, "d"); await user(bizE, "e");
  // D asked for its deletion, E is deleted (after its users exist, as in the account deletion flow).
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE "id" = $1`, bizD);
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now(), "deletedAt" = now() WHERE "id" = $1`, bizE);

  // ── 1. Backward compatibility ───────────────────────────────────────────────────────────────────────────────────
  console.log("1. backward compatibility");
  const seeded = rows(await owner.$queryRawUnsafe(
    `SELECT s."endpoint", s."provider", s."authSessionId", s."revokedReason", s."lastSeenAt", s."appVersion", s."platform"
       FROM "PushSubscription" s JOIN "Business" b ON b."id" = s."businessId" WHERE b."name" = 'nte-seed' ORDER BY s."id"`));
  ok("seeded subscriptions survived: the web push one and the erased one", seeded.length === 2
    && String(seeded[0].endpoint) === "https://fcm.googleapis.com/fcm/send/seed-web-1" && /^erased:\d+$/.test(String(seeded[1].endpoint)), J(seeded));
  ok("existing subscriptions got provider WEB_PUSH and NULL in every new column",
    seeded.every((s) => s.provider === "WEB_PUSH" && s.authSessionId === null && s.revokedReason === null && s.lastSeenAt === null && s.appVersion === null), J(seeded));
  const seededN = rows(await owner.$queryRawUnsafe(
    `SELECT n."userId" FROM "Notification" n JOIN "Business" b ON b."id" = n."businessId" WHERE b."name" = 'nte-seed'`));
  ok("existing notification: userId NULL (the whole business)", seededN.length === 1 && seededN[0].userId === null, J(seededN));
  const seededD = rows(await owner.$queryRawUnsafe(
    `SELECT d."channel"::text AS c, d."status"::text AS s, d."attempts", d."userId", d."subscriptionId", d."nextAttemptAt", d."leaseUntil", d."expiresAt", d."completedAt"
       FROM "NotificationDelivery" d JOIN "Business" b ON b."id" = d."businessId" WHERE b."name" = 'nte-seed' ORDER BY d."id"`));
  ok("existing deliveries: attempts 0, every worker column NULL", seededD.length === 4
    && seededD.every((d) => d.attempts === 0 && d.userId === null && d.subscriptionId === null && d.nextAttemptAt === null
      && d.leaseUntil === null && d.expiresAt === null && d.completedAt === null), J(seededD));

  const now = new Date();
  // app/api/push/subscriptions/route.ts — subscribe (create) then re-subscribe (findFirst + update).
  const endpointA = "https://fcm.googleapis.com/fcm/send/nte-a-1";
  const created = await inTx(runtime, bizA, (tx) => tx.pushSubscription.create({
    data: { businessId: bizA, userId: userA, endpoint: endpointA, p256dh: "BPk_test", auth: "au_test", platform: "android", updatedAt: now },
    select: { id: true } }));
  ok("app: pushSubscription.create (subscribe route) as the runtime", !isErr(created), why(created));
  const subA = isErr(created) ? NaN : (created as { id: number }).id;
  const resub = await inTx(runtime, bizA, async (tx) => {
    const existing = await tx.pushSubscription.findFirst({ where: { businessId: bizA, endpoint: endpointA }, select: { id: true } });
    return tx.pushSubscription.update({ where: { id: existing!.id },
      data: { userId: userA, p256dh: "BPk_new", auth: "au_new", platform: "android", revokedAt: null, failureCount: 0 }, select: { id: true } });
  });
  ok("app: findFirst + pushSubscription.update (re-subscribe) as the runtime", !isErr(resub), why(resub));
  // task-reminders / booking-notify — the push outcome bookkeeping; then the revoke route.
  const outcome = await inTx(runtime, bizA, async (tx) => {
    const a = await tx.pushSubscription.updateMany({ where: { id: subA, businessId: bizA }, data: { lastSuccessAt: now, failureCount: 0 } });
    const b = await tx.pushSubscription.updateMany({ where: { id: subA, businessId: bizA }, data: { lastFailureAt: now, failureCount: { increment: 1 } } });
    const subs = await tx.pushSubscription.findMany({ where: { businessId: bizA, revokedAt: null, userId: userA },
      select: { id: true, endpoint: true, p256dh: true, auth: true }, take: 20 });
    return a.count + b.count + subs.length;
  });
  ok("app: push outcome updateMany (success, failure increment) + findMany as the runtime", outcome === 3, why(outcome));
  const endpointA2 = "https://web.push.apple.com/nte-a-2";
  const revoke = await inTx(runtime, bizA, async (tx) => {
    await tx.pushSubscription.create({ data: { businessId: bizA, userId: userA, endpoint: endpointA2, p256dh: "k", auth: "a", platform: "ios", updatedAt: now }, select: { id: true } });
    return (await tx.pushSubscription.updateMany({ where: { businessId: bizA, endpoint: endpointA2, revokedAt: null }, data: { revokedAt: new Date() } })).count;
  });
  ok("app: revoke route updateMany as the runtime", revoke === 1, why(revoke));
  // account-deletion.prisma-store.ts — the in-place erasure.
  const erase = await inTx(runtime, bizA, async (tx) => {
    const sub = await tx.pushSubscription.findFirst({ where: { businessId: bizA, endpoint: endpointA2 }, select: { id: true } });
    return (await tx.pushSubscription.updateMany({ where: { id: sub!.id, businessId: bizA },
      data: { endpoint: `erased:${sub!.id}`, p256dh: "", auth: "", revokedAt: new Date() } })).count;
  });
  ok("app: in-place erasure (erased:<id>, empty keys) as the runtime", erase === 1, why(erase));
  const newRow = rows(await owner.$queryRawUnsafe(`SELECT "provider", "authSessionId", "lastSeenAt" FROM "PushSubscription" WHERE "id" = $1`, subA))[0];
  ok("a subscription the current code creates is WEB_PUSH with no session", newRow?.provider === "WEB_PUSH" && newRow?.authSessionId === null, J(newRow));

  // lib/notifications/notification-writer.ts — the raw upsert, the claim, createMany of deliveries (verbatim shapes).
  const utc = (instant: Date) => Prisma.sql`${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
  const channels = ["IN_APP", "PUSH"];
  const writer = await inTx(runtime, bizA, async (tx) => {
    const dedupeKey = `b${bizA}:inventory:critical:item:7`;
    const upserted = await tx.$queryRaw<Array<{ id: number; inserted: boolean; reopened: boolean | null }>>`
      WITH prev AS (SELECT "resolvedAt" FROM "Notification" WHERE "businessId" = ${bizA} AND "dedupeKey" = ${dedupeKey})
      INSERT INTO "Notification" (
        "businessId", "dedupeKey", "domain", "semanticCategory", "severity",
        "entityType", "entityId", "title", "summary", "href",
        "intendedChannels", "reason", "cooldownHours",
        "firstSurfacedAt", "lastSurfacedAt", "lastNotifiedAt", "createdAt", "updatedAt"
      ) VALUES (
        ${bizA}, ${dedupeKey}, ${"inventory"}, ${"ACTION_REQUIRED"}, ${"HIGH"},
        ${"item"}, ${7}, ${"t"}, ${null}, ${"/inventory"},
        ${channels}::text[]::"NotificationChannel"[], ${"policy"}, ${24},
        ${utc(now)}, ${utc(now)}, NULL, ${utc(now)}, ${utc(now)}
      )
      ON CONFLICT ("businessId", "dedupeKey") DO UPDATE SET
        "domain" = EXCLUDED."domain", "semanticCategory" = EXCLUDED."semanticCategory", "severity" = EXCLUDED."severity",
        "entityType" = EXCLUDED."entityType", "entityId" = EXCLUDED."entityId", "title" = EXCLUDED."title",
        "summary" = EXCLUDED."summary", "href" = EXCLUDED."href", "intendedChannels" = EXCLUDED."intendedChannels",
        "reason" = EXCLUDED."reason", "cooldownHours" = EXCLUDED."cooldownHours", "lastSurfacedAt" = EXCLUDED."lastSurfacedAt",
        "resolvedAt" = NULL, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING "id", (xmax = 0) AS "inserted", (SELECT "resolvedAt" IS NOT NULL FROM prev) AS "reopened"`;
    const id = upserted[0].id;
    const claimed = await tx.$executeRaw`
      UPDATE "Notification" SET "lastNotifiedAt" = ${utc(now)}, "readAt" = NULL, "dismissedAt" = NULL, "updatedAt" = ${utc(now)}
       WHERE "id" = ${id} AND "businessId" = ${bizA} AND ("lastNotifiedAt" IS NULL OR "lastNotifiedAt" <= ${utc(now)})`;
    const many = await tx.notificationDelivery.createMany({
      data: channels.map((channel) => ({ businessId: bizA, notificationId: id, channel: channel as "IN_APP" | "PUSH",
        status: channel === "IN_APP" ? "SENT" as const : "PENDING" as const, attemptedAt: now, createdAt: now })) });
    const again = await tx.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
        "title", "summary", "href", "intendedChannels", "reason", "cooldownHours", "firstSurfacedAt", "lastSurfacedAt", "lastNotifiedAt", "createdAt", "updatedAt")
      VALUES (${bizA}, ${dedupeKey}, 'inventory', 'ACTION_REQUIRED', 'HIGH', 'item', 7, 't2', NULL, '/inventory',
        ${channels}::text[]::"NotificationChannel"[], 'policy', 24, ${utc(now)}, ${utc(now)}, NULL, ${utc(now)}, ${utc(now)})
      ON CONFLICT ("businessId", "dedupeKey") DO UPDATE SET "title" = EXCLUDED."title", "resolvedAt" = NULL, "updatedAt" = EXCLUDED."updatedAt"
      RETURNING (xmax = 0) AS "inserted"`;
    return { id, inserted: upserted[0].inserted, claimed, many: many.count, againInserted: again[0].inserted };
  });
  ok("app: notification writer raw upsert + claim + deliveries createMany as the runtime",
    !isErr(writer) && (writer as { inserted: boolean }).inserted === true && (writer as { claimed: number }).claimed === 1
      && (writer as { many: number }).many === 2 && (writer as { againInserted: boolean }).againInserted === false, why(writer));
  const notifA = isErr(writer) ? NaN : (writer as { id: number }).id;

  // task-reminders.service.ts — typed upsert + IN_APP create + PUSH create (outcome); booking-notify — upsert + updateMany.
  const reminder = await inTx(runtime, bizA, async (tx) => {
    const dedupeKey = `task-reminder:1:${now.toISOString()}`;
    const n = await tx.notification.upsert({
      where: { businessId_dedupeKey: { businessId: bizA, dedupeKey } },
      create: { businessId: bizA, dedupeKey, domain: "tasks", semanticCategory: "REMINDER", severity: "MEDIUM", entityType: "task", entityId: 1,
        title: "תזכורת", summary: "s", href: "/tasks?task=1", intendedChannels: ["IN_APP", "PUSH"], reason: "owner_reminder", cooldownHours: 0,
        firstSurfacedAt: now, lastSurfacedAt: now, lastNotifiedAt: now },
      update: { lastSurfacedAt: now, resolvedAt: null }, select: { id: true } });
    await tx.notificationDelivery.create({ data: { businessId: bizA, notificationId: n.id, channel: "IN_APP", status: "SENT", attemptedAt: now, createdAt: now } });
    await tx.notificationDelivery.create({ data: { businessId: bizA, notificationId: n.id, channel: "PUSH", status: "FAILED", attemptedAt: now, createdAt: now, error: "push_410" } });
    const again = await tx.notification.upsert({
      where: { businessId_dedupeKey: { businessId: bizA, dedupeKey } },
      create: { businessId: bizA, dedupeKey, domain: "tasks", semanticCategory: "REMINDER", severity: "MEDIUM", entityType: "task", entityId: 1,
        title: "x", href: "/tasks", intendedChannels: ["IN_APP"], reason: "r", cooldownHours: 0 },
      update: { title: "updated", summary: "s2", lastSurfacedAt: now, readAt: null, resolvedAt: null }, select: { id: true } });
    const resolved = await tx.notification.updateMany({ where: { businessId: bizA, domain: "tasks", entityType: "task", entityId: 1, resolvedAt: null }, data: { resolvedAt: now } });
    const claim = await tx.notification.updateMany({ where: { businessId: bizA, dedupeKey, lastNotifiedAt: now }, data: { lastNotifiedAt: new Date(now.getTime() + 1), lastSurfacedAt: now, readAt: null } });
    return n.id === again.id && resolved.count === 1 && claim.count === 1;
  });
  ok("app: reminder / booking notification.upsert ×2, delivery.create IN_APP + PUSH, updateMany (resolve, claim) as the runtime", reminder === true, why(reminder));
  const newD = rows(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n, bool_and("attempts" = 0 AND "userId" IS NULL AND "subscriptionId" IS NULL) AS z
                                                   FROM "NotificationDelivery" WHERE "businessId" = $1`, bizA))[0];
  const newN = num(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Notification" WHERE "businessId" = $1 AND "userId" IS NULL`, bizA));
  ok("rows the current code writes: deliveries attempts 0 / no recipient / no device; notifications for the whole business",
    newD?.n === 4 && newD?.z === true && newN === 2, J({ newD, newN }));

  // ── 2. PushSubscription: provider, endpoint CHECK, shapes, session key ────────────────────────────────────────────
  console.log("2. PushSubscription");
  const insSub = (b: number, u: number, provider: string, endpoint: string, extra = "", extraV = "") =>
    q(runtime, b, `INSERT INTO "PushSubscription" ("businessId", "userId", "provider", "endpoint", "p256dh", "auth", "platform", "updatedAt"${extra})
                   VALUES ($1, $2, $3, $4, '', '', 'android', now()${extraV}) RETURNING "id"`, b, u, provider, endpoint);
  ok("WEB_PUSH + https endpoint accepted", !isErr(await insSub(bizA, userA, "WEB_PUSH", "https://push.example/nte-web")));
  const fcmIns = await insSub(bizA, userA, "FCM", `fcm:${FCM_TOKEN}`);
  ok("FCM + fcm:<token> accepted", !isErr(fcmIns), why(fcmIns));
  const subFcm = num(fcmIns, "id");
  ok("FCM + an https URL refused", refused(await insSub(bizA, userA, "FCM", "https://push.example/nte-fcm"), /PushSubscription_endpoint_shape/));
  ok("WEB_PUSH + an fcm token refused", refused(await insSub(bizA, userA, "WEB_PUSH", `fcm:${FCM_TOKEN}x`), /PushSubscription_endpoint_shape/));
  ok("FCM + a too-short token refused", refused(await insSub(bizA, userA, "FCM", "fcm:short"), /PushSubscription_endpoint_shape/));
  // (4096 is the CHECK's ceiling; a real token is ~160 characters. An incompressible endpoint above ~2.7 kB would be
  // refused by the (businessId, endpoint) btree index anyway, so the ceiling's upper end is not exercised here.)
  const mixed = (n: number) => Array.from({ length: n }, (_, i) => "AbC9_-:.xYz0QrS7"[(i * 7 + (i >> 3)) % 16]).join("");
  ok("FCM token bounds: 20 and 255 characters accepted, 19 and 4097 refused",
    !isErr(await insSub(bizA, userA, "FCM", "fcm:" + "t".repeat(20))) && !isErr(await insSub(bizA, userA, "FCM", "fcm:" + mixed(255)))
    && refused(await insSub(bizA, userA, "FCM", "fcm:" + "v".repeat(19)), /PushSubscription_endpoint_shape/)
    && refused(await insSub(bizA, userA, "FCM", "fcm:" + "w".repeat(4097)), /PushSubscription_endpoint_shape/));
  ok("FCM + a token with a space refused", refused(await insSub(bizA, userA, "FCM", `fcm:${FCM_TOKEN} x`), /PushSubscription_endpoint_shape/));
  ok("WEB_PUSH + plain http still refused", refused(await insSub(bizA, userA, "WEB_PUSH", "http://push.example/nte"), /PushSubscription_endpoint_shape/));
  ok("an unknown provider refused", refused(await insSub(bizA, userA, "APNS", "erased:999999"), /PushSubscription_provider/));
  const eraseFcm = await x(runtime, bizA, `UPDATE "PushSubscription" SET "endpoint" = 'erased:' || "id", "revokedAt" = now() WHERE "id" = $1`, subFcm);
  ok("erased:<id> accepted on an FCM row", eraseFcm === 1, why(eraseFcm));
  ok("erased:<id> accepted on a WEB_PUSH row", num(await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "PushSubscription" WHERE "provider" = 'WEB_PUSH' AND "endpoint" ~ '^erased:[0-9]+$' AND "businessId" = $1`, bizA)) === 1);
  ok("erased:<non-number> refused", refused(await x(runtime, bizA, `UPDATE "PushSubscription" SET "endpoint" = 'erased:x' WHERE "id" = $1`, subA), /PushSubscription_endpoint_shape/));
  ok("switching a web push row to FCM refused (its URL is not a token)",
    refused(await x(runtime, bizA, `UPDATE "PushSubscription" SET "provider" = 'FCM' WHERE "id" = $1`, subA), /PushSubscription_endpoint_shape/));
  ok("revokedReason shape: 'logout' ok, 'Logout!' refused",
    (await x(runtime, bizA, `UPDATE "PushSubscription" SET "revokedReason" = 'logout' WHERE "id" = $1`, subA)) === 1
    && refused(await x(runtime, bizA, `UPDATE "PushSubscription" SET "revokedReason" = 'Logout!' WHERE "id" = $1`, subA), /PushSubscription_revoked_reason_shape/));
  ok("appVersion shape: '1.4.2+51' ok, '1.4 beta' refused",
    (await x(runtime, bizA, `UPDATE "PushSubscription" SET "appVersion" = '1.4.2+51', "lastSeenAt" = now() WHERE "id" = $1`, subA)) === 1
    && refused(await x(runtime, bizA, `UPDATE "PushSubscription" SET "appVersion" = '1.4 beta' WHERE "id" = $1`, subA), /PushSubscription_app_version_shape/));
  ok("duplicate (businessId, endpoint) still refused", refused(await insSub(bizA, userA, "WEB_PUSH", "https://push.example/nte-web"), UNIQUE));
  // Sessions (owner): the runtime cannot read or write "AuthSession", but may reference one.
  const session = async (u: number, opts: { revoked?: boolean; idle?: string; abs?: string; ver?: number } = {}) =>
    String(rows(await owner.$queryRawUnsafe(
      `INSERT INTO "AuthSession" ("userId", "secretHash", "tokenVersionAtIssue", "createdAt", "lastUsedAt", "idleExpiresAt", "absoluteExpiresAt", "revokedAt")
       VALUES ($1, encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $2, ${NOW}, ${NOW}, ${NOW} + interval '${opts.idle ?? "1 day"}', ${NOW} + interval '${opts.abs ?? "30 days"}',
               ${opts.revoked ? NOW : "NULL"}) RETURNING "id"`, u, opts.ver ?? 0))[0].id);
  const sLive = await session(userA);
  ok("the runtime may attach its device to a session id (FK checked by the database)",
    (await x(runtime, bizA, `UPDATE "PushSubscription" SET "authSessionId" = $1::uuid WHERE "id" = $2`, sLive, subA)) === 1);
  ok("a session id that does not exist refused (FK)",
    refused(await x(runtime, bizA, `UPDATE "PushSubscription" SET "authSessionId" = gen_random_uuid() WHERE "id" = $1`, subA), FK));
  ok("the runtime cannot read \"AuthSession\" directly", refused(await q(runtime, bizA, `SELECT count(*) FROM "AuthSession"`), DENIED));
  const sGone = await session(userA);
  await x(runtime, bizA, `UPDATE "PushSubscription" SET "authSessionId" = $1::uuid WHERE "id" = $2`, sGone, subA);
  const gone = await x(auth, null, `DELETE FROM "AuthSession" WHERE "id" = $1::uuid`, sGone);
  ok("the sign-in plane (app_auth) deletes the session; the device is left with no session (SET NULL, under FORCE RLS)",
    gone === 1 && rows(await owner.$queryRawUnsafe(`SELECT "authSessionId" FROM "PushSubscription" WHERE "id" = $1`, subA))[0]?.authSessionId === null);

  // ── 3. NotificationSettings / NotificationPreference: four-sided isolation as the runtime ─────────────────────────
  console.log("3. tenant isolation of the new tables");
  const insSettings = (b: number, u: number, guc: number | null) =>
    q(runtime, guc, `INSERT INTO "NotificationSettings" ("businessId", "userId", "pushEnabled", "quietStartMinute", "quietEndMinute", "updatedAt")
                     VALUES ($1, $2, true, 1320, 420, now()) RETURNING "id"`, b, u);
  const insPref = (b: number, u: number, guc: number | null, key = "domain:inventory") =>
    q(runtime, guc, `INSERT INTO "NotificationPreference" ("businessId", "userId", "key", "push", "delivery", "updatedAt")
                     VALUES ($1, $2, $3, false, 'digest', now()) RETURNING "id"`, b, u, key);
  ok("settings: insert without tenant context refused (RLS)", refused(await insSettings(bizA, userA, null), RLS));
  ok("preference: insert without tenant context refused (RLS)", refused(await insPref(bizA, userA, null), RLS));
  const setA = num(await insSettings(bizA, userA, bizA), "id");
  const prefA = num(await insPref(bizA, userA, bizA), "id");
  const setB = num(await insSettings(bizB, userB, bizB), "id");
  const prefB = num(await insPref(bizB, userB, bizB), "id");
  ok("each business adds its own settings and preference", [setA, prefA, setB, prefB].every(Number.isFinite), J({ setA, prefA, setB, prefB }));
  for (const [t, idA, idB] of [["NotificationSettings", setA, setB], ["NotificationPreference", prefA, prefB]] as const) {
    ok(`${t}: no context sees nothing`, num(await q(runtime, null, `SELECT count(*)::int AS n FROM "${t}"`)) === 0);
    ok(`${t}: A sees exactly its own row`, J(rows(await q(runtime, bizA, `SELECT "id" FROM "${t}"`)).map((r) => r.id)) === J([idA]));
    ok(`${t}: A cannot see B's row by id`, num(await q(runtime, bizA, `SELECT count(*)::int AS n FROM "${t}" WHERE "id" = $1`, idB)) === 0);
    ok(`${t}: A's update of B's row changes nothing`, (await x(runtime, bizA, `UPDATE "${t}" SET "updatedAt" = now() WHERE "id" = $1`, idB)) === 0);
    ok(`${t}: A's delete of B's row removes nothing`, (await x(runtime, bizA, `DELETE FROM "${t}" WHERE "id" = $1`, idB)) === 0);
    ok(`${t}: no context updates / deletes nothing`, (await x(runtime, null, `UPDATE "${t}" SET "updatedAt" = now()`)) === 0
      && (await x(runtime, null, `DELETE FROM "${t}"`)) === 0);
    ok(`${t}: A changes its own row`, (await x(runtime, bizA, `UPDATE "${t}" SET "updatedAt" = now() WHERE "id" = $1`, idA)) === 1);
    ok(`${t}: moving A's row to B (with B's user) refused (RLS)`,
      refused(await x(runtime, bizA, `UPDATE "${t}" SET "businessId" = $1, "userId" = $2 WHERE "id" = $3`, bizB, userB, idA), RLS));
    ok(`${t}: moving A's row to B (user stays) refused`,
      refused(await x(runtime, bizA, `UPDATE "${t}" SET "businessId" = $1 WHERE "id" = $2`, bizB, idA), /row-level security|TASK_USER_OTHER_BUSINESS/));
    ok(`${t}: TRUNCATE denied`, refused(await x(runtime, bizA, `TRUNCATE "${t}"`), DENIED));
    ok(`${t}: B's row is untouched`, num(await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t}" WHERE "id" = $1 AND "businessId" = $2`, idB, bizB)) === 1);
  }
  ok("settings: A adding a row for business B refused (RLS)", refused(await insSettings(bizB, userB, bizA), RLS));
  ok("preference: A adding a row for business B refused (RLS)", refused(await insPref(bizB, userB, bizA, "domain:tasks"), RLS));
  ok("settings: one row per user (unique)", refused(await insSettings(bizA, userA, bizA), UNIQUE));
  ok("preference: one row per user per key (unique)", refused(await insPref(bizA, userA, bizA), UNIQUE));
  ok("settings: A removes its own row (restore defaults)", (await x(runtime, bizA, `DELETE FROM "NotificationSettings" WHERE "id" = $1`, setA)) === 1);
  ok("preference: A removes its own row", (await x(runtime, bizA, `DELETE FROM "NotificationPreference" WHERE "id" = $1`, prefA)) === 1);

  // ── 4. Same-business users and the composite device key ───────────────────────────────────────────────────────────
  console.log("4. cross-business references");
  ok("settings naming another business's user refused (trigger)", refused(await insSettings(bizA, userB, bizA), OTHER_USER));
  ok("preference naming another business's user refused (trigger)", refused(await insPref(bizA, userB, bizA, "category:inventory.critical_stock"), OTHER_USER));
  ok("settings: changing userId to another business's user refused (trigger)",
    refused(await x(runtime, bizB, `UPDATE "NotificationSettings" SET "userId" = $1 WHERE "id" = $2`, userA, setB), OTHER_USER));
  const insNotif = (b: number, u: number | null, key: string) =>
    q(runtime, b, `INSERT INTO "Notification" ("businessId", "userId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId",
                   "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
                   VALUES ($1, $2, $3, 'tasks', 'REMINDER', 'MEDIUM', 'task', 1, 't', '/tasks', ARRAY['IN_APP','PUSH']::"NotificationChannel"[], 'r', 0, now())
                   RETURNING "id"`, b, u, key);
  const notifUserA = num(await insNotif(bizA, userA, "nte:per-user:1"), "id");
  ok("Notification.userId: a user of the same business accepted", Number.isFinite(notifUserA));
  ok("Notification.userId: another business's user refused (trigger)", refused(await insNotif(bizA, userB, "nte:per-user:2"), OTHER_USER));
  ok("Notification.userId: changing it to another business's user refused (trigger)",
    refused(await x(runtime, bizA, `UPDATE "Notification" SET "userId" = $1 WHERE "id" = $2`, userB, notifUserA), OTHER_USER));
  const subB = num(await insSub(bizB, userB, "WEB_PUSH", "https://push.example/nte-b"), "id");
  const insDel = (b: number, n: number, u: number | null, s: number | null, extra = "", extraV = "") =>
    q(runtime, b, `INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "userId", "subscriptionId"${extra})
                   VALUES ($1, $2, 'PUSH', 'PENDING', $3, $4${extraV}) RETURNING "id"`, b, n, u, s);
  const delOwn = await insDel(bizA, notifUserA, userA, subA);
  ok("NotificationDelivery: own recipient + own device accepted", !isErr(delOwn), why(delOwn));
  ok("NotificationDelivery.userId: another business's user refused (trigger)", refused(await insDel(bizA, notifUserA, userB, null), OTHER_USER));
  ok("NotificationDelivery: another business's device refused (composite FK)", refused(await insDel(bizA, notifUserA, userA, subB), FK));
  ok("NotificationDelivery: re-pointing a delivery at another business's device refused (composite FK)",
    refused(await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "subscriptionId" = $1 WHERE "id" = $2`, subB, num(delOwn, "id")), FK));
  ok("the owner (BYPASSRLS) cannot cross either: composite FK holds for every role",
    refused(await q(owner, null, `INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "subscriptionId") VALUES ($1, $2, 'PUSH', 'PENDING', $3) RETURNING "id"`,
      bizA, notifUserA, subB), FK));

  // ── 5. CHECKs ────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("5. checks");
  for (const key of ["domain:inventory", "category:inventory.critical_stock", "domain:a", "category:" + "a".repeat(64)]) {
    const r = await insPref(bizA, userA2, bizA, key);
    ok(`preference key '${key.slice(0, 40)}' accepted`, !isErr(r), why(r));
  }
  for (const key of ["Domain:inventory", "domain:Inventory", "kind:inventory", "domain:", "domain:inv entory", "category:" + "a".repeat(65), "domain:inv-entory", "domain:inventory\n"]) {
    ok(`preference key ${J(key.slice(0, 40))} refused`, refused(await insPref(bizA, userA2, bizA, key), /NotificationPreference_key_shape|value too long/));
  }
  let pk = 0;
  const pDel = (d: string) => q(runtime, bizA, `INSERT INTO "NotificationPreference" ("businessId", "userId", "key", "delivery", "updatedAt")
                                                VALUES ($1, $2, $3, $4, now()) RETURNING "id"`, bizA, userA, `domain:delivery_${++pk}`, d);
  ok("preference delivery 'instant' and 'digest' accepted", !isErr(await pDel("instant")) && !isErr(await pDel("digest")));
  ok("preference delivery 'weekly' refused", refused(await pDel("weekly"), /NotificationPreference_delivery/));
  ok("preference delivery 'Instant' refused", refused(await pDel("Instant"), /NotificationPreference_delivery/));
  const sMin = (col: string, v: number) => q(runtime, bizA, `INSERT INTO "NotificationSettings" ("businessId", "userId", "${col}", "updatedAt") VALUES ($1, $2, $3, now()) RETURNING "id"`, bizA, userA2, v);
  for (const col of ["quietStartMinute", "quietEndMinute", "digestMinute"]) {
    for (const bad of [-1, 1440]) ok(`settings ${col} = ${bad} refused`, refused(await sMin(col, bad), /NotificationSettings_minutes/));
  }
  const s0 = await sMin("quietStartMinute", 0);
  ok("settings minute 0 accepted", !isErr(s0), why(s0));
  ok("settings minute 1439 accepted on every column", (await x(runtime, bizA,
    `UPDATE "NotificationSettings" SET "quietStartMinute" = 1439, "quietEndMinute" = 1439, "digestMinute" = 1439 WHERE "id" = $1`, num(s0, "id"))) === 1);
  const allNull = await q(runtime, bizA, `INSERT INTO "NotificationSettings" ("businessId", "userId", "updatedAt") VALUES ($1, $2, now()) RETURNING "id"`, bizA, userA);
  ok("settings: an all-NULL row (every product default) accepted", !isErr(allNull), why(allNull));
  const delId = num(delOwn, "id");
  ok("delivery attempts 50 accepted, 51 and -1 refused",
    (await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "attempts" = 50 WHERE "id" = $1`, delId)) === 1
    && refused(await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "attempts" = 51 WHERE "id" = $1`, delId), /NotificationDelivery_attempts_range/)
    && refused(await x(runtime, bizA, `UPDATE "NotificationDelivery" SET "attempts" = -1 WHERE "id" = $1`, delId), /NotificationDelivery_attempts_range/));

  // ── 6. Catalog ───────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("6. catalog");
  for (const t of ["NotificationSettings", "NotificationPreference"]) {
    const c = rows(await owner.$queryRawUnsafe(`SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE oid = $1::regclass`, `"${t}"`))[0];
    ok(`${t}: RLS ENABLED + FORCED`, c?.e === true && c?.f === true, J(c));
    const pols = rows(await owner.$queryRawUnsafe(
      `SELECT polcmd::text AS cmd, polpermissive AS p, polroles = ARRAY[0]::oid[] AS pub,
              pg_get_expr(polqual, polrelid) AS q, pg_get_expr(polwithcheck, polrelid) AS wc
         FROM pg_policy WHERE polrelid = $1::regclass ORDER BY polcmd`, `"${t}"`));
    const GUC = `("businessId" = (NULLIF(current_setting('app.current_business_id'::text, true), ''::text))::integer)`;
    const want: Record<string, [boolean, boolean]> = { r: [true, false], a: [false, true], w: [true, true], d: [true, false] };
    ok(`${t}: exactly four per-command policies (r, a, w, d), no FOR ALL, each on the tenant GUC`,
      pols.length === 4 && pols.every((p) => p.p === true && p.pub === true && want[String(p.cmd)]
        && (want[String(p.cmd)][0] ? p.q === GUC : p.q === null) && (want[String(p.cmd)][1] ? p.wc === GUC : p.wc === null)), J(pols));
    const acl = rows(await owner.$queryRawUnsafe(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p
         FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = $1::regclass AND a.grantee <> c.relowner GROUP BY 1 ORDER BY 1`, `"${t}"`));
    ok(`${t}: ACL exactly app_runtime DELETE, INSERT, SELECT, UPDATE (nothing for PUBLIC or another role)`,
      J(acl) === J([{ g: "app_runtime", p: "DELETE,INSERT,SELECT,UPDATE" }]), J(acl));
    const sacl = rows(await owner.$queryRawUnsafe(
      `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g, string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS p
         FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid = $1::regclass AND a.grantee <> c.relowner GROUP BY 1 ORDER BY 1`, `"${t}_id_seq"`));
    ok(`${t}_id_seq: ACL exactly app_runtime SELECT, USAGE`, J(sacl) === J([{ g: "app_runtime", p: "SELECT,USAGE" }]), J(sacl));
    ok(`${t}: no column-level privilege`, num(await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid = $1::regclass`, `"${t}"`)) === 0);
    ok(`${t}: app_auth holds nothing`, num(await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v WHERE has_table_privilege('app_auth', $1::regclass, v)`, `"${t}"`)) === 0);
    ok(`${t}: same-business trigger enabled`, num(await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid WHERE g.tgrelid = $1::regclass AND g.tgname = $2 AND g.tgenabled = 'O' AND p.proname = 'task_user_same_business'`,
      `"${t}"`, `${t}_user_same_business`)) === 1);
  }
  const fns = ["notification_push_due(timestamp(3), integer)", "notification_live_businesses(integer, integer)", "auth_sessions_live(uuid[], timestamp(3))"];
  for (const f of fns) {
    const p = rows(await owner.$queryRawUnsafe(
      `SELECT prosecdef AS d, provolatile::text AS v, proconfig AS c, pg_get_userbyid(proowner) AS o,
              (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY 1)
                 FROM aclexplode(proacl) a WHERE a.grantee <> proowner) AS acl
         FROM pg_proc WHERE oid = $1::regprocedure`, `public.${f}`))[0];
    ok(`${f}: SECURITY DEFINER, STABLE, search_path = pg_catalog, public, pg_temp, owned by the migration role`,
      p?.d === true && p?.v === "s" && J(p?.c) === J(["search_path=pg_catalog, public, pg_temp"]) && p?.o === "lab_owner", J(p));
    ok(`${f}: EXECUTE for app_runtime alone (no PUBLIC)`, p?.acl === "app_runtime:EXECUTE", J(p?.acl));
    ok(`${f}: app_auth cannot EXECUTE`, num(await owner.$queryRawUnsafe(
      `SELECT count(*)::int AS n WHERE has_function_privilege('app_auth', $1::regprocedure, 'EXECUTE')`, `public.${f}`)) === 0);
  }
  ok("an app_auth login is refused EXECUTE (real call)",
    refused(await q(auth, null, `SELECT * FROM public.notification_live_businesses(0, 10)`), DENIED));

  // ── 7. The three functions, as the runtime, with no tenant context ───────────────────────────────────────────────
  console.log("7. functions");
  const nA = notifA;
  const nB = num(await owner.$queryRawUnsafe(`INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId", "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, 'nte:b', 'tasks', 'REMINDER', 'MEDIUM', 'task', 1, 't', '/t', ARRAY['PUSH']::"NotificationChannel"[], 'r', 0, now()) RETURNING "id"`, bizB), "id");
  const nD = num(await owner.$queryRawUnsafe(`INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId", "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, 'nte:d', 'tasks', 'REMINDER', 'MEDIUM', 'task', 1, 't', '/t', ARRAY['PUSH']::"NotificationChannel"[], 'r', 0, now()) RETURNING "id"`, bizD), "id");
  const nE = num(await owner.$queryRawUnsafe(`INSERT INTO "Notification" ("businessId", "dedupeKey", "domain", "semanticCategory", "severity", "entityType", "entityId", "title", "href", "intendedChannels", "reason", "cooldownHours", "updatedAt")
    VALUES ($1, 'nte:e', 'tasks', 'REMINDER', 'MEDIUM', 'task', 1, 't', '/t', ARRAY['PUSH']::"NotificationChannel"[], 'r', 0, now()) RETURNING "id"`, bizE), "id");
  // What the current code has already left behind: the writer records every PUSH it intends as PENDING (it sends
  // nothing). Those rows are owed pushes to the worker the moment this migration lands — reported, not asserted.
  const legacy = num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.notification_push_due(${NOW}, 500)`));
  console.log(`  [INFO] PENDING PUSH rows written by the current code, due at once for a future worker: ${legacy}`);
  // Start from a known state: every owed push in the database is settled, then exactly these are created.
  await owner.$executeRawUnsafe(`UPDATE "NotificationDelivery" SET "status" = 'SUPPRESSED' WHERE "status" = 'PENDING' AND "channel" = 'PUSH'`);
  const del = (b: number, n: number, ch: string, st: string, next: string, lease: string) =>
    owner.$queryRawUnsafe(`INSERT INTO "NotificationDelivery" ("businessId", "notificationId", "channel", "status", "nextAttemptAt", "leaseUntil")
      VALUES ($1, $2, '${ch}', '${st}', ${next}, ${lease}) RETURNING "id"`, b, n).then((r) => Number(rows(r)[0].id));
  const past = `${NOW} - interval '1 minute'`, future = `${NOW} + interval '1 hour'`;
  const dDue = await del(bizA, nA, "PUSH", "PENDING", past, "NULL");
  const dNull = await del(bizB, nB, "PUSH", "PENDING", "NULL", "NULL");
  const dLeaseOver = await del(bizA, nA, "PUSH", "PENDING", `${NOW} - interval '2 minute'`, past);
  await del(bizA, nA, "PUSH", "PENDING", future, "NULL");                       // not due yet
  await del(bizA, nA, "PUSH", "PENDING", past, future);                         // leased
  await del(bizA, nA, "PUSH", "SENT", past, "NULL");                            // done
  await del(bizA, nA, "PUSH", "FAILED", past, "NULL");                          // done
  await del(bizA, nA, "IN_APP", "PENDING", past, "NULL");                       // not a push
  await del(bizD, nD, "PUSH", "PENDING", past, "NULL");                         // business in deletion
  await del(bizE, nE, "PUSH", "PENDING", past, "NULL");                         // business deleted
  const due = await q(runtime, null, `SELECT "businessId", "deliveryId" FROM public.notification_push_due(${NOW}, 100)`);
  const dueIds = rows(due).map((r) => Number(r.deliveryId));
  ok("notification_push_due: exactly the owed, due, unleased pushes of live businesses, NULL-first then by time, across tenants without a session",
    J(dueIds) === J([dNull, dLeaseOver, dDue]), `${J(dueIds)} want ${J([dNull, dLeaseOver, dDue])}`);
  ok("notification_push_due: each with its business", J(rows(due).map((r) => Number(r.businessId))) === J([bizB, bizA, bizA]), J(due));
  ok("notification_push_due: limit honoured, and clamped to at least 1 (0, NULL default)",
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.notification_push_due(${NOW}, 2)`)) === 2
    && num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.notification_push_due(${NOW}, 0)`)) === 1
    && num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.notification_push_due(${NOW}, NULL)`)) === 3);
  ok("notification_push_due: identifiers only (businessId, deliveryId)", J(Object.keys(rows(due)[0] ?? {}).sort()) === J(["businessId", "deliveryId"]));

  const live = rows(await owner.$queryRawUnsafe(`SELECT "id" FROM "Business" WHERE "deletionRequestedAt" IS NULL AND "deletedAt" IS NULL ORDER BY "id"`)).map((r) => Number(r.id));
  const pages: number[][] = [];
  let after = 0;
  for (let i = 0; i < 100; i++) {
    const page = rows(await q(runtime, null, `SELECT "businessId" FROM public.notification_live_businesses($1::int, 2)`, after)).map((r) => Number(r.businessId));
    if (page.length === 0) break;
    pages.push(page); after = page[page.length - 1];
  }
  const walked = pages.flat();
  ok("notification_live_businesses: keyset pages of 2 walk exactly the live businesses, in order, once each",
    J(walked) === J(live) && pages.every((p) => p.length <= 2), `${J(walked)} want ${J(live)}`);
  ok("notification_live_businesses: deletion-requested and deleted businesses skipped; A and B included",
    !walked.includes(bizD) && !walked.includes(bizE) && walked.includes(bizA) && walked.includes(bizB));
  ok("notification_live_businesses: NULL cursor = from the start, limit clamped to at least 1",
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.notification_live_businesses(NULL, 0)`)) === 1
    && Number(rows(await q(runtime, null, `SELECT "businessId" FROM public.notification_live_businesses(NULL, 1)`))[0]?.businessId) === live[0]);

  const sRevoked = await session(userA, { revoked: true });
  const sIdle = await session(userA, { idle: "-1 minute" });
  const sAbs = await session(userA, { abs: "-1 minute" });
  await owner.$executeRawUnsafe(`UPDATE "User" SET "tokenVersion" = 1 WHERE "id" = $1`, userA2);
  const sOldVer = await session(userA2, { ver: 0 });
  const sNewVer = await session(userA2, { ver: 1 });
  const sOtherLive = await session(userB);
  const asked = [sLive, sRevoked, sIdle, sAbs, sOldVer, sNewVer, "00000000-0000-4000-8000-000000000000"];
  const liveIds = rows(await q(runtime, null, `SELECT "id"::text AS id FROM public.auth_sessions_live($1::uuid[], ${NOW})`, asked)).map((r) => String(r.id)).sort();
  ok("auth_sessions_live: only the asked ids that are not revoked, not idle / absolute expired, at the user's token version",
    J(liveIds) === J([sLive, sNewVer].sort()), `${J(liveIds)} want ${J([sLive, sNewVer].sort())}`);
  ok("auth_sessions_live: never returns an id it was not given", !liveIds.includes(sOtherLive));
  ok("auth_sessions_live: NULL / empty input → nothing",
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.auth_sessions_live(NULL, ${NOW})`)) === 0
    && num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.auth_sessions_live(ARRAY[]::uuid[], ${NOW})`)) === 0);
  await owner.$executeRawUnsafe(`UPDATE "User" SET "tokenVersion" = "tokenVersion" + 1 WHERE "id" = $1`, userA);
  ok("auth_sessions_live: a \"log out of every device\" (tokenVersion bump) ends a live session",
    num(await q(runtime, null, `SELECT count(*)::int AS n FROM public.auth_sessions_live($1::uuid[], ${NOW})`, [sLive])) === 0);

  console.log(`\n${pass} PASS, ${failures.length} FAIL`);
  if (failures.length) { console.log("FAILED:\n  - " + failures.join("\n  - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => Promise.all([owner.$disconnect(), runtime.$disconnect(), auth.$disconnect()]));
