/**
 * Task reminders through the notification engine, on a real database, AS THE RESTRICTED RUNTIME (NOSUPERUSER
 * NOBYPASSRLS, a member of app_runtime), over every engine migration (`.nte2d/lab.sh <db> --with-nte2d`). Push
 * providers are FAKES (a fake fetch for FCM, a fake web push sender): no network, no key, no device.
 *
 *   engine ON    one reminder ⇒ the bell row (in-app SENT) + ONE owed push, sent by the worker to EVERY live device of
 *                the reminder's user: the Android app (FCM, urgent channel, data category tasks.reminder, the task's
 *                href) and the browser (web push) — each exactly once; another user's devices never; no legacy row.
 *   once         a second dispatch of the same reminder sends nothing; two racing dispatches send once.
 *   preference   the user switched phone push off for tasks.reminder ⇒ the bell row stays, no device, SUPPRESSED pref_off.
 *   quiet hours  23:00 business time ⇒ still sent (a reminder the owner set for an explicit time; catalog quietBypass).
 *   session      the FCM device's login session ended ⇒ that device is skipped (liveness), the browser still gets it.
 *   too old      a moment more than a day old ⇒ claimed, in the bell, no owed push, nothing sent.
 *   engine OFF   exactly the legacy path: web push to the user's https subscriptions only, the FCM device never, no
 *                owed engine row.
 *   isolation    a dispatch in one business never reaches a device of another.
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). Synthetic data only. Run: npx tsx lib/services/tasks/task-reminders-engine.db.test.ts
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
process.env.TASK_REQUEST_HMAC_KEY ??= "daily-tasks-lab-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID ??= "lab1";
delete process.env.QSTASH_TOKEN;

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 600));
  }
}

/* ── fake providers ── */
const fcmSends: { token: string; channel: string; data: Record<string, string> }[] = [];
const webSends: { endpoint: string; payload: Record<string, unknown> }[] = [];
const fakeFetch = async (url: string, init: { body: string }) => {
  if (url.startsWith("https://oauth2.googleapis.com/")) return { status: 200, text: async () => JSON.stringify({ access_token: "lab-access", expires_in: 3600 }) };
  const m = JSON.parse(init.body).message;
  fcmSends.push({ token: m.token, channel: m.android.notification.channel_id, data: m.data });
  return { status: 200, text: async () => "{}" };
};
const fakeWebPush = async (t: { endpoint: string }, p: unknown) => {
  webSends.push({ endpoint: t.endpoint, payload: p as Record<string, unknown> });
  return { ok: true as const, status: 201 };
};
const pushDeps = { fetch: fakeFetch, webPush: fakeWebPush } as never;
const tok = (tag: string) => `lab-${tag}:APA91b${randomBytes(24).toString("hex")}`;

async function main() {
  const rem = await import("./task-reminders.service");
  const dev = await import("@/lib/notifications/engine/devices");
  const store = await import("@/lib/notifications/preferences-store");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const NOW = new Date("2026-12-01T10:00:00.000Z"); // Tuesday 12:00 Asia/Jerusalem
  const NIGHT = new Date("2026-12-01T21:00:00.000Z"); // 23:00
  const at = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
    VALUES ('notifications_engine', 'מנוע התראות', 'integrations', 'lab', false, true) ON CONFLICT ("key") DO NOTHING`);
  await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeaturePolicy" ("featureKey", "globalEnabled", "emergencyDisabled", "updatedAt")
    VALUES ('notifications_engine', false, false, now()) ON CONFLICT ("featureKey") DO NOTHING`);
  const biz = async (name: string, engine: boolean) => {
    const b = await owner.business.create({ data: { name } });
    if (engine) {
      await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt")
        VALUES ($1, 'notifications_engine', 'ENABLED', TIMESTAMP '2026-11-01 00:00:00')`, b.id);
    }
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt")
      VALUES ($1, 'daily_tasks', 'ENABLED', now()) ON CONFLICT DO NOTHING`, b.id);
    return b.id;
  };
  const E = await biz("trpe-E", true);
  const L = await biz("trpe-L", false);
  const stamp = Date.now();
  const user = async (b: number, tag: string) => (await owner.user.create({ data: { email: `${tag}-${stamp}@trpe.lab`, password: "x", businessId: b } })).id;
  const e1 = await user(E, "e1");
  const e2 = await user(E, "e2");
  const l1 = await user(L, "l1");
  const session = async (userId: number) => {
    const u = await owner.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } });
    return (await owner.authSession.create({
      data: {
        userId, secretHash: randomBytes(32).toString("hex"), tokenVersionAtIssue: u.tokenVersion,
        createdAt: at(NOW, -60), lastUsedAt: at(NOW, -1), idleExpiresAt: at(NOW, 30 * 24 * 60), absoluteExpiresAt: at(NOW, 60 * 24 * 60),
      },
      select: { id: true },
    })).id;
  };
  const web = (b: number, u: number, tag: string) =>
    owner.pushSubscription.create({ data: { businessId: b, userId: u, endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-${stamp}`, p256dh: "BPk", auth: "au", platform: "desktop" } });

  // devices: e1 = phone (FCM, live session) + browser; e2 = phone; l1 (engine OFF) = phone + browser
  const sE1 = await session(e1);
  const tE1 = tok("e1");
  await dev.registerFcmDevice({ businessId: E, userId: e1, sessionId: sE1 }, { token: tE1, platform: "android", appVersion: "1.1.0+2" }, NOW);
  const wE1 = await web(E, e1, "e1");
  const tE2 = tok("e2");
  await dev.registerFcmDevice({ businessId: E, userId: e2, sessionId: await session(e2) }, { token: tE2, platform: "android", appVersion: "1.1.0+2" }, NOW);
  const tL1 = tok("l1");
  await dev.registerFcmDevice({ businessId: L, userId: l1, sessionId: await session(l1) }, { token: tL1, platform: "android", appVersion: "1.1.0+2" }, NOW);
  const wL1 = await web(L, l1, "l1");

  let n = 0;
  const task = async (businessId: number, userId: number, remindAt: Date) =>
    (await owner.task.create({ data: { businessId, title: `תזכורת ${++n}`, createdByUserId: userId, remindAt }, select: { id: true } })).id;
  const dispatch = (businessId: number, taskId: number, remindAt: Date, now = NOW) =>
    rem.dispatchReminder({ businessId, taskId, remindAt }, now, { pushDeps });
  const push = (businessId: number, taskId: number) =>
    owner.notificationDelivery.findMany({
      where: { businessId, channel: "PUSH", notification: { entityType: "task", entityId: taskId } },
      orderBy: { id: "asc" },
    });
  const bell = (businessId: number, taskId: number) =>
    owner.notification.findFirst({ where: { businessId, domain: "tasks", entityType: "task", entityId: taskId } });
  const mark = () => ({ f: fcmSends.length, w: webSends.length });
  const since = (m: { f: number; w: number }) => ({ fcm: fcmSends.slice(m.f), web: webSends.slice(m.w) });

  try {
    console.log("engine ON — one reminder, every live device of the user, once");
    const r1 = at(NOW, -1);
    const t1 = await task(E, e1, r1);
    let m = mark();
    const out1 = await dispatch(E, t1, r1);
    let s = since(m);
    ok("dispatch: sent, two devices", out1.result === "sent" && out1.result === "sent" && (out1 as { pushed: number }).pushed === 2, out1);
    ok("the phone (FCM) got it once, urgent channel", s.fcm.length === 1 && s.fcm[0].token === tE1 && s.fcm[0].channel === "dubiz_urgent", s.fcm.map((x) => x.channel));
    ok("…with the task's link and the category", s.fcm[0]?.data.href === `/tasks?task=${t1}` && s.fcm[0]?.data.category === "tasks.reminder", s.fcm[0]?.data);
    ok("the browser (web push) got it once", s.web.length === 1 && s.web[0].endpoint === wE1.endpoint);
    ok("another user's phone never", !s.fcm.some((x) => x.token === tE2));
    const b1 = await bell(E, t1);
    ok("the bell keeps the reminder (in-app row)", b1 !== null && (await owner.notificationDelivery.count({ where: { notificationId: b1!.id, channel: "IN_APP", status: "SENT" } })) === 1);
    const rows1 = await push(E, t1);
    const owed1 = rows1.filter((r) => r.subscriptionId === null);
    ok("ONE owed engine row, SENT, for the reminder's user", owed1.length === 1 && owed1[0].status === "SENT" && owed1[0].userId === e1, owed1);
    ok("per-device rows: exactly the two sends, no legacy push_ row", rows1.filter((r) => r.subscriptionId !== null).length === 2 && rows1.every((r) => !(r.error ?? "").startsWith("push_")), rows1);
    ok("the owed row expires a day after the moment", owed1[0]?.expiresAt?.getTime() === at(r1, 24 * 60).getTime());

    console.log("once");
    m = mark();
    const again = await dispatch(E, t1, r1, at(NOW, 1));
    ok("a second dispatch of the same reminder: NOT_CLAIMED, nothing sent", again.result === "skipped" && since(m).fcm.length === 0 && since(m).web.length === 0, again);
    const t2 = await task(E, e1, r1);
    m = mark();
    const race = await Promise.all([dispatch(E, t2, r1), dispatch(E, t2, r1), dispatch(E, t2, r1)]);
    s = since(m);
    ok("three racing dispatches: one claim, one send per device", race.filter((x) => x.result === "sent").length === 1 && s.fcm.length === 1 && s.web.length === 1, { race, s: { f: s.fcm.length, w: s.web.length } });

    console.log("preference");
    await store.putPreference({ businessId: E, userId: e1 }, "category:tasks.reminder", { inApp: null, push: false, delivery: null }, NOW);
    const t3 = await task(E, e1, r1);
    m = mark();
    await dispatch(E, t3, r1);
    s = since(m);
    const owed3 = (await push(E, t3)).filter((r) => r.subscriptionId === null);
    ok("push off for tasks.reminder: no device reached", s.fcm.length === 0 && s.web.length === 0);
    ok("…owed row SUPPRESSED pref_off; the bell still has it", owed3[0]?.status === "SUPPRESSED" && owed3[0]?.error === "pref_off" && (await bell(E, t3)) !== null, owed3);
    await store.resetPreferences({ businessId: E, userId: e1 });

    console.log("session");
    await owner.authSession.update({ where: { id: sE1 }, data: { revokedAt: NOW, revokedReason: "lab" } });
    const t5 = await task(E, e1, r1);
    m = mark();
    await dispatch(E, t5, r1, at(NOW, 5));
    s = since(m);
    const owed5 = (await push(E, t5)).map((r) => ({ sub: r.subscriptionId !== null, status: r.status, error: r.error }));
    ok("the phone's session ended: the phone is skipped, the browser still gets it", s.fcm.length === 0 && s.web.length === 1, { f: s.fcm.length, w: s.web.length, owed5 });

    console.log("too old");
    const old = at(NOW, -25 * 60);
    const t6 = await task(E, e1, old);
    m = mark();
    const outOld = await dispatch(E, t6, old);
    ok("a moment more than a day old: claimed, in the bell, no owed push, nothing sent", outOld.result === "sent" && (await push(E, t6)).length === 0 && (await bell(E, t6)) !== null && since(m).fcm.length + since(m).web.length === 0);

    console.log("quiet hours");
    // A new login on the phone (the earlier session ended above): the device is bound to it again.
    await dev.registerFcmDevice({ businessId: E, userId: e1, sessionId: await session(e1) }, { token: tE1, platform: "android", appVersion: "1.1.0+2" }, NOW);
    const rn = at(NIGHT, -1);
    const t4 = await task(E, e1, rn);
    m = mark();
    await dispatch(E, t4, rn, NIGHT);
    ok("23:00 business time: still sent (a reminder bypasses quiet hours)", since(m).fcm.length === 1 && since(m).web.length === 1);

    console.log("engine OFF — the legacy path, unchanged");
    const t7 = await task(L, l1, r1);
    m = mark();
    const out7 = await dispatch(L, t7, r1);
    s = since(m);
    ok("web push to the user's https subscription only", s.web.length === 1 && s.web[0].endpoint === wL1.endpoint, s.web);
    ok("the FCM device of that business is never pushed", s.fcm.length === 0);
    const rows7 = await push(L, t7);
    ok("no owed engine row; the legacy delivery row (SENT, subscription-less)", rows7.length === 1 && rows7[0].status === "SENT" && rows7[0].userId === null && out7.result === "sent", rows7);

    console.log("isolation");
    ok("no dispatch in E ever reached L's devices, nor L's in E", !fcmSends.some((x) => x.token === tL1) && webSends.filter((x) => x.endpoint === wL1.endpoint).length === 1 && webSends.every((x) => x.endpoint === wE1.endpoint || x.endpoint === wL1.endpoint));
  } finally {
    await owner.$disconnect();
  }
  console.log(`\n[task-reminders-engine] checks=${checks} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
