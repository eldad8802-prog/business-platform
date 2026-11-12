/**
 * The notification engine on a real database, AS THE RESTRICTED RUNTIME (NOSUPERUSER NOBYPASSRLS, a member of
 * app_runtime), over the real migration 20261210090000_notification_engine_foundation (built by
 * `.nte/lab.sh <db> --with-nte`). Push providers are FAKES (a fake fetch for FCM, a fake web push sender): no
 * network, no real key, no real device.
 *
 *   create → deliver   notify() writes one owed push; the worker sends it to the user's live device and records a
 *                      per-device SENT row; the lock screen gets the generic text; data = {notificationId, href,
 *                      category}.
 *   dedupe             a second notify() inside the cooldown writes nothing.
 *   claim / lease      two workers racing send once; a leased row is not touched until its lease ends.
 *   retry              a transient failure retries with backoff (1 m …) and then sends; 5 failures end it.
 *   invalid token      UNREGISTERED revokes the device ('gone').
 *   quiet hours        deferred to 07:00 business time and sent then; a user-set reminder bypasses them.
 *   settings           push off for a category / the master switch ⇒ pref_off; restore defaults ⇒ sent again.
 *   feature off        the category's feature unavailable ⇒ feature_off; the stored override is kept.
 *   two users          a whole-business push fans out, each user's own devices only.
 *   sessions           device logout / all devices / a session ended without the hook / a token-version bump /
 *                      account switch on the same device (same business and across businesses) / token rotation.
 *   two businesses     the global worker serves each in its own tenant; the engine OFF ⇒ nothing sent, the
 *                      writer's historical PENDING pushes expire (never sent), in an ON business too.
 *   writer             the snapshot writer's owed PUSH row now carries expiresAt.
 *   digest             08:00 business time, once a day, none when empty, never repeating what was pushed.
 *   read side          another user's personal notification is invisible; a category switched off in-app is hidden.
 *   isolation          settings / overrides of one business are invisible and unwritable from another.
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). Synthetic data only. Run: npx tsx lib/notifications/engine/notification-engine.db.test.ts
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FCM_PROJECT_ID = "dubiz-lab";
process.env.FCM_CLIENT_EMAIL = "push@dubiz-lab.iam.gserviceaccount.com";
process.env.FCM_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.VAPID_PUBLIC_KEY = "lab-public";
process.env.VAPID_PRIVATE_KEY = "lab-private";
process.env.VAPID_SUBJECT = "mailto:lab@example.test";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 600));
  }
}

/* ── fake providers ─────────────────────────────────────────────────────────────────────────────────────────── */
type Behaviour = "ok" | "unregistered" | "unavailable";
const behaviour = new Map<string, Behaviour>();
const fcmSends: { token: string; title: string; body: string; data: Record<string, string>; visibility: string; channel: string }[] = [];
const webSends: { endpoint: string; payload: Record<string, unknown> }[] = [];
const fakeFetch = async (url: string, init: { body: string }) => {
  if (url.startsWith("https://oauth2.googleapis.com/")) return { status: 200, text: async () => JSON.stringify({ access_token: "lab-access", expires_in: 3600 }) };
  const m = JSON.parse(init.body).message;
  const b = behaviour.get(m.token) ?? "ok";
  if (b === "unregistered") return { status: 404, text: async () => JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }) };
  if (b === "unavailable") return { status: 503, text: async () => JSON.stringify({ error: { status: "UNAVAILABLE" } }) };
  fcmSends.push({ token: m.token, title: m.notification.title, body: m.notification.body, data: m.data, visibility: m.android.notification.visibility, channel: m.android.notification.channel_id });
  return { status: 200, text: async () => "{}" };
};
const fakeWebPush = async (t: { endpoint: string }, p: unknown) => {
  webSends.push({ endpoint: t.endpoint, payload: p as Record<string, unknown> });
  return { ok: true as const, status: 201 };
};
const deps = { fetch: fakeFetch, webPush: fakeWebPush };
const tok = (tag: string) => `lab-${tag}:APA91b${randomBytes(24).toString("hex")}`;

async function main() {
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { notify, NotifyRefusedError } = await import("./notify");
  const { runPushWorker } = await import("./push-worker");
  const { runDailyDigest, digestDedupeKey } = await import("./digest");
  const dev = await import("./devices");
  const store = await import("../preferences-store");
  const read = await import("../notification-read.service");
  const { persistSnapshotNotifications } = await import("../notification-writer");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const NOW = new Date("2026-12-01T10:00:00.000Z"); // Tuesday 12:00 Asia/Jerusalem (winter, UTC+2)
  const NIGHT = new Date("2026-12-01T21:00:00.000Z"); // 23:00
  const at = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);
  const run = (now: Date, businessId?: number, extra: Record<string, unknown> = {}) => runPushWorker(now, { businessId, deps, quiet: true, ...extra });

  // ── fixtures (owner) ────────────────────────────────────────────────────────────────────────────────────────
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
    VALUES ('notifications_engine', 'מנוע התראות', 'integrations', 'lab', false, true) ON CONFLICT ("key") DO NOTHING`);
  const biz = async (name: string, engine: boolean) => {
    const b = await owner.business.create({ data: { name } });
    if (engine) await owner.businessFeatureAccess.create({ data: { businessId: b.id, featureKey: "notifications_engine", state: "ENABLED" } });
    return b.id;
  };
  const A = await biz("nte3-A", true);
  const B = await biz("nte3-B", true);
  const C = await biz("nte3-C", false);
  const D = await biz("nte3-D", true);
  for (const b of [A, B, C, D]) {
    for (const k of ["daily_tasks", "inventory", "billing"]) {
      await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt")
        SELECT $1, $2, 'ENABLED', now() WHERE EXISTS (SELECT 1 FROM "PlatformFeatureDefinition" WHERE "key" = $2) ON CONFLICT DO NOTHING`, b, k);
    }
  }
  const stamp = Date.now();
  const user = async (b: number, tag: string) => (await owner.user.create({ data: { email: `${tag}-${stamp}@nte3.lab`, password: "x", businessId: b } })).id;
  const a1 = await user(A, "a1"); const a2 = await user(A, "a2");
  const b1 = await user(B, "b1"); const c1 = await user(C, "c1");
  const d1 = await user(D, "d1"); const d2 = await user(D, "d2");
  const session = async (userId: number) => {
    const u = await owner.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } });
    const s = await owner.authSession.create({
      data: {
        userId, secretHash: randomBytes(32).toString("hex"), tokenVersionAtIssue: u.tokenVersion,
        createdAt: at(NOW, -60), lastUsedAt: at(NOW, -1), idleExpiresAt: at(NOW, 30 * 24 * 60), absoluteExpiresAt: at(NOW, 60 * 24 * 60),
      },
      select: { id: true },
    });
    return s.id;
  };
  const register = (businessId: number, userId: number, sessionId: string, token: string) =>
    dev.registerFcmDevice({ businessId, userId, sessionId }, { token, platform: "android", appVersion: "1.4.0" }, NOW);
  const owed = (businessId: number, notificationId: number) =>
    owner.notificationDelivery.findMany({ where: { businessId, notificationId, channel: "PUSH" }, orderBy: { id: "asc" } });
  const event = (businessId: number, over: Record<string, unknown> = {}) => ({
    businessId, category: "inventory.critical_stock" as const, entity: { type: "inventory_item", id: Math.floor(Math.random() * 1e9) },
    title: "יוסי כהן — 3 יחידות", summary: "ספק: יוסי כהן", href: "/inventory", now: NOW, ...over,
  });
  // Earlier sections' pushes count against the per-user rate limit (4 / hour); a section that is not about the limit
  // starts as if a day had passed since them (the rows stay, only their send time moves back).
  const ageSends = () => owner.notificationDelivery.updateMany({
    where: { channel: "PUSH", status: "SENT", subscriptionId: { not: null }, attemptedAt: { gt: at(NOW, -2 * 24 * 60) } },
    data: { attemptedAt: at(NOW, -2 * 24 * 60) },
  });
  const notifyIn = (businessId: number, over: Record<string, unknown> = {}) =>
    tenantTx(businessId, (tx) => notify(tx, event(businessId, over) as Parameters<typeof notify>[1]));

  try {
    const sA1 = await session(a1);
    const tA1 = tok("a1");
    await register(A, a1, sA1, tA1);

    console.log("create → deliver");
    const n1 = await notifyIn(A, { userId: a1 });
    const before = await owed(A, n1.notificationId);
    ok("notify writes ONE owed push: PENDING, the user, expiresAt = now + TTL (6 h)", before.length === 1 && before[0].status === "PENDING" && before[0].userId === a1 &&
      before[0].subscriptionId === null && before[0].expiresAt?.getTime() === at(NOW, 360).getTime(), before);
    ok("…and nothing was sent by notify itself", fcmSends.length === 0);
    const r1 = await run(NOW, A);
    const after1 = await owed(A, n1.notificationId);
    const devRow = after1.find((d) => d.subscriptionId !== null);
    ok("the worker sent it: a per-device SENT row (device, user)", devRow?.status === "SENT" && devRow.userId === a1 && r1.devicesSent === 1, { r1, after1 });
    ok("the owed row is complete (SENT, completedAt, lease released)", after1[0].status === "SENT" && after1[0].completedAt !== null && after1[0].leaseUntil === null);
    const s1 = fcmSends.at(-1)!;
    ok("FCM: to the user's token, PRIVATE, urgent channel", s1.token === tA1 && s1.visibility === "PRIVATE" && s1.channel === "dubiz_urgent");
    ok("lock screen: the generic text, no name", s1.title === "דוביז" && !/יוסי/.test(s1.title + s1.body), s1);
    ok("data = { notificationId, href, category }", JSON.stringify(s1.data) === JSON.stringify({ notificationId: String(n1.notificationId), href: "/inventory", category: "inventory.critical_stock" }), s1.data);
    ok("a second pass sends nothing", (await run(at(NOW, 1), A)).devicesSent === 0);

    console.log("dedupe");
    const ent = { type: "inventory_item", id: 4242 };
    const d1n = await notifyIn(A, { entity: ent, userId: a1 });
    const d2n = await notifyIn(A, { entity: ent, userId: a1, now: at(NOW, 5) });
    ok("same fact inside the cooldown: second notify writes nothing", d1n.notified && !d2n.notified && d1n.notificationId === d2n.notificationId && d2n.owedDeliveryId === null);
    ok("one owed push only", (await owed(A, d1n.notificationId)).filter((d) => d.subscriptionId === null).length === 1);
    await run(NOW, A);
    let refused = "";
    try { await notifyIn(A, { href: "https://evil.example/inventory" }); } catch (e) { refused = e instanceof NotifyRefusedError ? e.code : String(e); }
    ok("an href outside the category is refused", refused === "INVALID_HREF", refused);

    console.log("claim / lease");
    const race = await notifyIn(A, { userId: a1 });
    const sentBefore = fcmSends.length;
    await Promise.all([run(NOW, A), run(NOW, A), run(NOW)]);
    ok("three racing workers: ONE send", fcmSends.length - sentBefore === 1 && (await owed(A, race.notificationId)).filter((d) => d.status === "SENT" && d.subscriptionId !== null).length === 1);
    const leased = await notifyIn(A, { userId: a1 });
    await owner.notificationDelivery.update({ where: { id: leased.owedDeliveryId! }, data: { leaseUntil: at(NOW, 2) } });
    ok("a leased row (a crashed attempt) is not touched while the lease runs", (await run(at(NOW, 1), A)).claimed === 0 && (await owed(A, leased.notificationId)).length === 1);
    ok("…and is retried once the lease has run out", (await run(at(NOW, 3), A)).devicesSent === 1);

    console.log("transient retry");
    await ageSends();
    behaviour.set(tA1, "unavailable");
    const tr = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    let rows = await owed(A, tr.notificationId);
    const owedRow = rows.find((d) => d.subscriptionId === null)!;
    ok("503 ⇒ owed stays PENDING, attempts 1, next attempt +1 min", owedRow.status === "PENDING" && owedRow.attempts === 1 && owedRow.nextAttemptAt?.getTime() === at(NOW, 1).getTime(), owedRow);
    ok("…the device attempt is recorded FAILED transient", rows.some((d) => d.subscriptionId !== null && d.status === "FAILED" && d.error?.startsWith("transient:")));
    ok("not due before its backoff", (await run(at(NOW, 0.5), A)).claimed === 0);
    behaviour.set(tA1, "ok");
    await run(at(NOW, 1.1), A);
    rows = await owed(A, tr.notificationId);
    ok("after the backoff it is sent", rows.find((d) => d.subscriptionId === null)!.status === "SENT" && rows.some((d) => d.subscriptionId !== null && d.status === "SENT"));
    behaviour.set(tA1, "unavailable");
    const ex = await notifyIn(A, { userId: a1 });
    let t = NOW;
    for (const step of [0, 1, 5, 15, 60]) { t = at(t, step + 0.1); await run(t, A); }
    const exOwed = (await owed(A, ex.notificationId)).find((d) => d.subscriptionId === null)!;
    ok("five transient failures end it: FAILED retries_exhausted", exOwed.status === "FAILED" && exOwed.error === "retries_exhausted" && exOwed.attempts === 5, exOwed);
    behaviour.set(tA1, "ok");

    console.log("invalid token");
    await ageSends();
    const sGone = await session(a1);
    const tGone = tok("gone");
    const goneDev = await register(A, a1, sGone, tGone);
    behaviour.set(tGone, "unregistered");
    await run(NOW, A, {});
    const gn = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    const goneRow = await owner.pushSubscription.findUniqueOrThrow({ where: { id: goneDev.id } });
    ok("UNREGISTERED ⇒ the device is revoked 'gone'", goneRow.revokedAt !== null && goneRow.revokedReason === "gone", goneRow);
    ok("…while the other device still received it", (await owed(A, gn.notificationId)).some((d) => d.status === "SENT" && d.subscriptionId !== null));

    console.log("rate limit");
    await ageSends();
    const rl: number[] = [];
    for (let i = 0; i < 5; i++) rl.push((await notifyIn(A, { userId: a1 })).notificationId);
    for (const id of rl) { void id; }
    await run(NOW, A);
    const rlStates = await Promise.all(rl.map(async (id) => (await owed(A, id)).find((d) => d.subscriptionId === null)!));
    ok("4 pushes in an hour go out, the 5th is held: SUPPRESSED rate_limited", rlStates.filter((d) => d.status === "SENT").length === 4 && rlStates.filter((d) => d.error === "rate_limited").length === 1, rlStates.map((d) => d.error ?? d.status));
    const exempt = await tenantTx(A, (tx) => notify(tx, { businessId: A, category: "tasks.reminder", entity: { type: "task", id: 78 }, title: "x", href: "/tasks", userId: a1, now: NOW }));
    await run(NOW, A);
    ok("…a user-set reminder is exempt and still goes out", (await owed(A, exempt.notificationId)).some((d) => d.status === "SENT" && d.subscriptionId !== null));

    console.log("quiet hours");
    await ageSends();
    // billing.failure: TTL 12 h, so the end of the night is before the expiry (a 6 h TTL would be held for the digest).
    const q = await notifyIn(A, { userId: a1, now: NIGHT, category: "billing.failure", entity: { type: "billing_document", id: 31 }, href: "/billing/31" });
    await run(NIGHT, A);
    const qOwed = (await owed(A, q.notificationId))[0];
    ok("23:00 ⇒ deferred to 07:00 Jerusalem (05:00Z), nothing sent", qOwed.status === "PENDING" && qOwed.nextAttemptAt?.toISOString() === "2026-12-02T05:00:00.000Z", qOwed);
    ok("…not due at 06:59", (await run(new Date("2026-12-02T04:59:00Z"), A)).claimed === 0);
    await run(new Date("2026-12-02T05:00:30Z"), A);
    ok("…sent at 07:00", (await owed(A, q.notificationId)).some((d) => d.status === "SENT" && d.subscriptionId !== null));
    const qShort = await notifyIn(A, { userId: a1, now: NIGHT });
    await run(NIGHT, A);
    ok("a 6 h TTL ending before 07:00: held for the digest (SUPPRESSED quiet)", (await owed(A, qShort.notificationId))[0].error === "quiet");
    const rem = await tenantTx(A, (tx) => notify(tx, { businessId: A, category: "tasks.reminder", entity: { type: "task", id: 77 }, title: "להתקשר", href: "/tasks?task=77", userId: a1, now: NIGHT }));
    await run(NIGHT, A);
    ok("a user-set reminder bypasses quiet hours", (await owed(A, rem.notificationId)).some((d) => d.status === "SENT" && d.subscriptionId !== null));

    console.log("settings");
    await ageSends();
    const actorA1 = { businessId: A, userId: a1 };
    await store.putPreference(actorA1, "category:inventory.critical_stock", { inApp: null, push: false, delivery: null }, NOW);
    const p1 = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("push off for the category ⇒ SUPPRESSED pref_off", (await owed(A, p1.notificationId))[0].error === "pref_off");
    await store.resetPreferences(actorA1);
    const p2 = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("restore defaults ⇒ sent again", (await owed(A, p2.notificationId)).some((d) => d.status === "SENT" && d.subscriptionId !== null));
    await store.patchSettings(actorA1, { pushEnabled: false }, NOW);
    const p3 = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("the master switch off ⇒ pref_off", (await owed(A, p3.notificationId))[0].error === "pref_off");
    const removed = await store.resetPreferences(actorA1);
    ok("reset deletes the user's own rows only", removed.settings === 1 && removed.preferences === 0);
    await store.patchSettings(actorA1, { lockScreenDetails: true }, NOW);
    await run(NOW, A);
    const det = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("lockScreenDetails ON ⇒ the stored title is shown", fcmSends.at(-1)!.title.startsWith("יוסי") && (await owed(A, det.notificationId)).some((d) => d.status === "SENT"));
    await store.resetPreferences(actorA1);

    console.log("feature off");
    await ageSends();
    await store.putPreference(actorA1, "domain:inventory", { inApp: null, push: true, delivery: null }, NOW);
    await owner.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED' WHERE "businessId" = $1 AND "featureKey" = 'inventory'`, A);
    const f1 = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("inventory unavailable ⇒ SUPPRESSED feature_off", (await owed(A, f1.notificationId))[0].error === "feature_off");
    ok("…and the stored override is kept", (await owner.notificationPreference.count({ where: { businessId: A, userId: a1, key: "domain:inventory" } })) === 1);
    await owner.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'ENABLED' WHERE "businessId" = $1 AND "featureKey" = 'inventory'`, A);
    await store.resetPreferences(actorA1);

    console.log("two users, one business");
    await ageSends();
    const sA2 = await session(a2);
    const tA2 = tok("a2");
    await register(A, a2, sA2, tA2);
    const whole = await notifyIn(A, {});
    const sends0 = fcmSends.length;
    const rw = await run(NOW, A);
    const wRows = await owed(A, whole.notificationId);
    ok("the whole-business row is fanned out (SUPPRESSED fanned_out)", wRows[0].userId === null && wRows[0].status === "SUPPRESSED" && wRows[0].error === "fanned_out" && rw.fannedOut === 1);
    ok("one owed row per user of the business", wRows.filter((d) => d.userId !== null && d.subscriptionId === null).map((d) => d.userId).sort().join() === [a1, a2].sort().join());
    const tokens = fcmSends.slice(sends0).map((s) => s.token).sort();
    ok("each user's own device only", JSON.stringify(tokens) === JSON.stringify([tA1, tA2].sort()), tokens);

    console.log("sessions");
    await ageSends();
    await dev.revokeSessionDevicesBestEffort(A, sA1, "logout", a1);
    const lo = await owner.pushSubscription.findFirstOrThrow({ where: { businessId: A, endpoint: `fcm:${tA1}` } });
    ok("device logout ⇒ the session's device revoked 'logout'", lo.revokedAt !== null && lo.revokedReason === "logout");
    const afterLogout = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("…and a push for that user finds no device", (await owed(A, afterLogout.notificationId))[0].error === "no_device");
    const sA1b = await session(a1);
    await register(A, a1, sA1b, tA1);
    await owner.authSession.update({ where: { id: sA1b }, data: { revokedAt: NOW, revokedReason: "lab" } });
    const deadSess = await notifyIn(A, { userId: a1 });
    await run(NOW, A);
    ok("a session ended WITHOUT the hook: the worker still never pushes to its device (liveness)", (await owed(A, deadSess.notificationId))[0].error === "no_device");
    const sA1c = await session(a1);
    await register(A, a1, sA1c, tA1);
    await owner.pushSubscription.create({ data: { businessId: A, userId: a1, endpoint: `https://fcm.googleapis.com/fcm/send/legacy-${stamp}`, p256dh: "BPk", auth: "au", platform: "desktop" } });
    await dev.revokeUserDevicesBestEffort(A, a1, "logout_all");
    const allA1 = await owner.pushSubscription.findMany({ where: { businessId: A, userId: a1, revokedAt: null } });
    ok("log out of every device ⇒ every device of the user revoked (legacy web push included)", allA1.length === 0);
    ok("…reason logout_all", (await owner.pushSubscription.count({ where: { businessId: A, userId: a1, revokedReason: "logout_all" } })) >= 2);
    // account switch on the same phone, same business
    const shared = tok("shared");
    const sA1d = await session(a1);
    await register(A, a1, sA1d, shared);
    const sA2b = await session(a2);
    await register(A, a2, sA2b, shared);
    const sharedRow = await owner.pushSubscription.findFirstOrThrow({ where: { businessId: A, endpoint: `fcm:${shared}` } });
    ok("account switch: the device row now belongs to the new user and session", sharedRow.userId === a2 && sharedRow.authSessionId === sA2b && sharedRow.revokedAt === null);
    const toA1 = await notifyIn(A, { userId: a1 });
    const n0 = fcmSends.length;
    await run(NOW, A);
    ok("…a push for the previous user never reaches it", !fcmSends.slice(n0).some((s) => s.token === shared) && (await owed(A, toA1.notificationId))[0].error === "no_device");
    const toA2 = await notifyIn(A, { userId: a2 });
    const n1s = fcmSends.length;
    await run(NOW, A);
    ok("…a push for the new user does", fcmSends.slice(n1s).some((s) => s.token === shared) && (await owed(A, toA2.notificationId)).some((d) => d.status === "SENT"));
    // token rotation on the same session
    const rotated = tok("rot");
    const rot = await register(A, a2, sA2b, rotated);
    ok("token rotation: the session's previous token is revoked 'replaced'", rot.replaced === 1 &&
      (await owner.pushSubscription.findFirstOrThrow({ where: { businessId: A, endpoint: `fcm:${shared}` } })).revokedReason === "replaced");
    // across businesses: the same phone token signed in to A (a1) and B (b1)
    const cross = tok("cross");
    const sA1e = await session(a1);
    await register(A, a1, sA1e, cross);
    const sB1 = await session(b1);
    await register(B, b1, sB1, cross);
    await owner.authSession.update({ where: { id: sA1e }, data: { revokedAt: NOW, revokedReason: "lab" } });
    const crossA = await notifyIn(A, { userId: a1 });
    const crossB = await notifyIn(B, { userId: b1 });
    const n2s = fcmSends.length;
    await run(NOW, A); await run(NOW, B);
    ok("account switch across businesses: B's user is reached, A's ended session is not",
      fcmSends.slice(n2s).filter((s) => s.token === cross).length === 1 &&
      (await owed(A, crossA.notificationId))[0].error === "no_device" && (await owed(B, crossB.notificationId)).some((d) => d.status === "SENT"));
    // a token-version bump (log out of every device elsewhere) kills every session of the user
    await owner.user.update({ where: { id: a2 }, data: { tokenVersion: { increment: 1 } } });
    const bump = await notifyIn(A, { userId: a2 });
    await run(NOW, A);
    ok("a token-version bump: no session of the user is live, nothing sent", (await owed(A, bump.notificationId))[0].error === "no_device");

    console.log("two businesses, engine OFF, historical rows");
    await ageSends();
    const sC1 = await session(c1);
    const tC1 = tok("c1");
    await owner.pushSubscription.create({ data: { businessId: C, userId: c1, endpoint: `fcm:${tC1}`, provider: "FCM", p256dh: "", auth: "", platform: "android", authSessionId: sC1 } });
    const histNote = async (b: number, key: string) => (await owner.notification.create({ data: {
      businessId: b, dedupeKey: key, domain: "inventory", semanticCategory: "ALERT", severity: "CRITICAL", entityType: "inventory_item", entityId: 1,
      title: "old", href: "/inventory", intendedChannels: ["IN_APP", "PUSH"], reason: "seed", cooldownHours: 24,
    } })).id;
    const hc = await histNote(C, `hist-c-${stamp}`);
    const histC = await owner.notificationDelivery.create({ data: { businessId: C, notificationId: hc, channel: "PUSH", status: "PENDING", createdAt: at(NOW, -7 * 24 * 60), attemptedAt: at(NOW, -7 * 24 * 60) } });
    const freshC = await owner.notificationDelivery.create({ data: { businessId: C, notificationId: hc, channel: "PUSH", status: "PENDING", userId: c1, createdAt: NOW, attemptedAt: NOW, expiresAt: at(NOW, 360) } });
    const ha = await histNote(A, `hist-a-${stamp}`);
    const histA = await owner.notificationDelivery.create({ data: { businessId: A, notificationId: ha, channel: "PUSH", status: "PENDING", createdAt: at(NOW, -3 * 24 * 60), attemptedAt: at(NOW, -3 * 24 * 60) } });
    const bOnly = await notifyIn(B, { userId: b1 });
    const n3s = fcmSends.length;
    const g = await run(NOW);
    const hC = await owner.notificationDelivery.findUniqueOrThrow({ where: { id: histC.id } });
    const fC = await owner.notificationDelivery.findUniqueOrThrow({ where: { id: freshC.id } });
    const hA = await owner.notificationDelivery.findUniqueOrThrow({ where: { id: histA.id } });
    ok("the global worker serves business B in its own tenant", (await owed(B, bOnly.notificationId)).some((d) => d.status === "SENT" && d.subscriptionId !== null), g);
    ok("engine OFF (C): nothing sent to its device", !fcmSends.slice(n3s).some((s) => s.token === tC1));
    ok("engine OFF: the writer's week-old PENDING push is closed FAILED expired", hC.status === "FAILED" && hC.error === "expired", hC);
    ok("engine OFF: a fresh owed push is untouched (PENDING, re-checked in 30 min, never claimed)", fC.status === "PENDING" && fC.attempts === 0 && fC.nextAttemptAt?.getTime() === at(NOW, 30).getTime() && fC.leaseUntil === null, fC);
    ok("engine ON (A): a historical PENDING push (no expiresAt, 3 days old) EXPIRES — never sent", hA.status === "FAILED" && hA.error === "expired" && !(await owed(A, ha)).some((d) => d.status === "SENT"), hA);

    console.log("writer");
    const item = {
      itemId: "inventory:x", domain: "inventory", semanticCategory: "ALERT", severity: "CRITICAL", title: "מלאי קריטי", summary: null,
      priorityScore: 1, entityRef: { type: "inventory_item", id: 999_001 }, state: "open", createdAt: NOW.toISOString(),
      primaryAction: { kind: "navigate", label: "x", href: "/inventory" }, sourceEngine: "lab",
    };
    const out = await runWithTenantContext({ businessId: A }, () => persistSnapshotNotifications(A, [item as never], NOW));
    const wPush = await owner.notificationDelivery.findFirst({ where: { businessId: A, notificationId: out[0].notificationId, channel: "PUSH" } });
    ok("the snapshot writer's owed PUSH row carries expiresAt = now + 6 h (userId NULL)", wPush?.status === "PENDING" && wPush.expiresAt?.getTime() === at(NOW, 360).getTime() && wPush.userId === null, wPush);

    console.log("digest");
    await ageSends();
    const sD1 = await session(d1); const tD1 = tok("d1"); await register(D, d1, sD1, tD1);
    const sD2 = await session(d2); const tD2 = tok("d2"); await register(D, d2, sD2, tD2);
    await store.putPreference({ businessId: D, userId: d1 }, "domain:billing", { inApp: null, push: null, delivery: "digest" }, NOW);
    const bill = await tenantTx(D, (tx) => notify(tx, { businessId: D, category: "billing.failure", entity: { type: "billing_document", id: 5 }, title: "חשבונית 5", href: "/billing/5", now: NOW }));
    await run(NOW, D);
    const billRows = await owed(D, bill.notificationId);
    ok("d1 (billing in digest mode): held to_digest; d2: pushed", billRows.some((r) => r.userId === d1 && r.error === "to_digest") && billRows.some((r) => r.userId === d2 && r.status === "SENT" && r.subscriptionId !== null), billRows);
    const MORNING_EARLY = new Date("2026-12-02T05:59:00Z"); // 07:59 Jerusalem
    const MORNING = new Date("2026-12-02T06:00:00Z"); // 08:00
    ok("07:59: no digest yet", (await runDailyDigest(MORNING_EARLY, { businessIds: [D], quiet: true })).digests === 0);
    const dg = await runDailyDigest(MORNING, { businessIds: [D], quiet: true });
    const dKey = digestDedupeKey(d1, "2026-12-02");
    const dNote = await owner.notification.findFirst({ where: { businessId: D, dedupeKey: dKey } });
    ok("08:00: ONE digest, for d1 only (d2's only item was already pushed ⇒ none)", dg.digests === 1 && dNote?.userId === d1 &&
      (await owner.notification.count({ where: { businessId: D, dedupeKey: digestDedupeKey(d2, "2026-12-02") } })) === 0, dg);
    ok("the digest text counts, names nobody", dNote?.summary === "סיכום יומי: 1 עניינים מחכים לך" && dNote?.semanticCategory === "digest.daily");
    ok("a second run the same day writes nothing", (await runDailyDigest(at(MORNING, 30), { businessIds: [D], quiet: true })).digests === 0 &&
      (await owner.notification.count({ where: { businessId: D, semanticCategory: "digest.daily" } })) === 1);
    const n4s = fcmSends.length;
    await run(MORNING, D);
    const dSend = fcmSends.slice(n4s);
    ok("the digest push reaches d1's device with the count-only text", dSend.length === 1 && dSend[0].token === tD1 && dSend[0].body === "סיכום יומי: 1 עניינים מחכים לך" && dSend[0].data.category === "digest.daily", dSend);
    ok("an empty day writes no digest", (await runDailyDigest(new Date("2026-12-04T06:30:00Z"), { businessIds: [D], quiet: true })).digests === 0);
    ok("engine OFF: no digest", (await runDailyDigest(MORNING, { businessIds: [C], quiet: true })).engineOff === 1);

    console.log("read side");
    const listA = async (userId: number) => (await read.listNotifications(A, { limit: 50, cursor: null, unreadOnly: false, viewer: { userId } })).notifications.map((n) => n.id);
    const personal = await notifyIn(A, { userId: a1, category: "system.test", entity: { type: "test", id: a1 }, href: "/notifications", title: "בדיקה" });
    ok("a1 sees their own notification", (await listA(a1)).includes(personal.notificationId));
    ok("a2 does not", !(await listA(a2)).includes(personal.notificationId));
    ok("a2 cannot mark it read (not found)", !(await read.markNotificationRead(A, personal.notificationId, NOW, { userId: a2 })).found);
    ok("the whole-business row is visible to both", (await listA(a1)).includes(whole.notificationId) && (await listA(a2)).includes(whole.notificationId));
    const attn = await notifyIn(A, { category: "inventory.attention" });
    await store.putPreference(actorA1, "category:inventory.attention", { inApp: false, push: null, delivery: null }, NOW);
    ok("a category switched off in-app is hidden from that user only", !(await listA(a1)).includes(attn.notificationId) && (await listA(a2)).includes(attn.notificationId));
    const unreadList = async (userId: number) => (await read.listNotifications(A, { limit: 50, cursor: null, unreadOnly: true, viewer: { userId } })).notifications.map((n) => n.id);
    const [u1, u2] = [await unreadList(a1), await unreadList(a2)];
    ok("the unread count is exactly the viewer's unread list (a1, a2)",
      (await read.countUnread(A, { userId: a1 })) === u1.length && (await read.countUnread(A, { userId: a2 })) === u2.length && u1.length < 50 && u2.length < 50, { u1: u1.length, u2: u2.length });
    ok("…a1's count excludes the hidden category, a2's excludes a1's personal row", !u1.includes(attn.notificationId) && u2.includes(attn.notificationId) && !u2.includes(personal.notificationId));
    ok("without a viewer the business-wide predicate is unchanged", (await read.listNotifications(A, { limit: 50, cursor: null, unreadOnly: false })).notifications.some((n) => n.id === personal.notificationId));

    console.log("isolation");
    const crossRead = await tenantTx(B, (tx) => tx.notificationPreference.count({ where: { userId: a1 } }));
    ok("business B sees none of A's overrides", crossRead === 0);
    let crossWrite = "";
    try {
      await tenantTx(B, (tx) => tx.notificationSettings.create({ data: { businessId: A, userId: a1, pushEnabled: false }, select: { id: true } }));
      crossWrite = "WROTE";
    } catch (e) { crossWrite = e instanceof Error ? e.message.slice(0, 80) : "ERR"; }
    ok("business B cannot write A's settings", crossWrite !== "WROTE", crossWrite);
    let otherUser = "";
    try {
      await store.patchSettings({ businessId: B, userId: a1 }, { pushEnabled: false }, NOW);
      otherUser = "WROTE";
    } catch (e) { otherUser = e instanceof Error ? e.message.slice(0, 80) : "ERR"; }
    ok("a user of another business cannot be written into B (same-business trigger)", otherUser !== "WROTE", otherUser);
    ok("devices of B are invisible from A", (await tenantTx(A, (tx) => tx.pushSubscription.count({ where: { businessId: B } }))) === 0);
  } finally {
    await owner.$disconnect();
  }
  console.log(`\n[notification-engine db] ${checks - failed}/${checks} PASS`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
