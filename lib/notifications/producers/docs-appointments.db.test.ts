/**
 * Stuck documents + personal appointment reminders, end to end on a real database AS THE RESTRICTED RUNTIME
 * (app_runtime_prod: NOSUPERUSER NOBYPASSRLS), over migration 20261213090000_notification_docs_stuck_appointment_lead
 * (`.nte2d/lab.sh <db> --with-nte2d`: "Document"."statusChangedAt" stamped by the database trigger,
 * "NotificationSettings"."appointmentReminderMinutes"). The status sweep and the push worker are the real ones; the
 * push providers are fakes (no network).
 *
 *   1. stuck documents  a document processing inside its attempt (4 min) is never flagged; 29 min ⇒ not yet; 31 min ⇒
 *                       ONE stuck row (deep link to the document, in-app, push owed but OFF by default ⇒ never sent);
 *                       a historical row (no stamp) processing for days ⇒ never; the retry (the app's own statement,
 *                       restamped by the trigger) resolves it and is not flagged while it runs; stuck again ⇒ a new
 *                       row; success (needs_review) ⇒ resolved; a failed document keeps its old key.
 *   2. per-user lead    one business, three users: 30 min, the day before (1440), and the default (60). A sweep every
 *                       15 min (off-grid) + a worker every 5 min (off-grid) across the two windows: each user gets
 *                       exactly ONE push, never before their moment, at most 5 minutes after it; nothing is created
 *                       earlier than one sweep interval before a moment (the bell is not filled ahead).
 *   3. cancel           a reminder created ahead, then the appointment cancelled ⇒ resolved, the owed push suppressed
 *                       ('resolved') at its moment, nothing sent.
 *   4. reschedule       moved two hours later ⇒ the old reminder resolves (nothing sent at the old moment); the new
 *                       start is a new reminder, sent at ITS moment.
 *   5. DST day          26 Mar 2027 (Jerusalem moves to UTC+3 at 02:00): the day-before reminder fires at the same
 *                       LOCAL time on the 25th (23 real hours earlier); the 60-min one 60 real minutes before.
 *   6. settings         round-trip through the session-actor store (30 → read back → effective); another user's row
 *                       untouched; another business cannot read or change it (RLS); the database CHECK refuses a
 *                       value the validator would refuse (45).
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login, OWNER_URL = the migration role (fixtures only). Synthetic only.
 * Run: npx tsx lib/notifications/producers/docs-appointments.db.test.ts
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FCM_PROJECT_ID = "dubiz-lab";
process.env.FCM_CLIENT_EMAIL = "push@dubiz-lab.iam.gserviceaccount.com";
process.env.FCM_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 900));
  }
}

/* ── fake FCM ───────────────────────────────────────────────────────────────────────────────────────────────── */
const sends: { token: string; at: number; notificationId: string }[] = [];
let clock = 0;
const fakeFetch = async (url: string, init: { body: string }) => {
  if (url.startsWith("https://oauth2.googleapis.com/")) return { status: 200, text: async () => JSON.stringify({ access_token: "lab-access", expires_in: 3600 }) };
  const m = JSON.parse(init.body).message;
  sends.push({ token: m.token, at: clock, notificationId: String(m.data?.notificationId ?? "") });
  return { status: 200, text: async () => "{}" };
};
const deps = { fetch: fakeFetch };

async function main() {
  const { runStatusSweep } = await import("./status-sweep");
  const { runPushWorker } = await import("../engine/push-worker");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const dev = await import("../engine/devices");
  const store = await import("../preferences-store");
  const { effectiveSettings, validateSettingsPatch } = await import("../preferences");
  const { DOCUMENT_STUCK_MS } = await import("./state-facts");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const q = { quiet: true, concurrency: 1 } as const;
  const stamp = Date.now();

  /* ── fixtures (owner) ──────────────────────────────────────────────────────────────────────────────────────── */
  for (const [key, def] of [["notifications_engine", false], ["documents", true], ["appointments", true]] as const) {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
      VALUES ($1, $1, 'lab', 'lab', $2, true) ON CONFLICT ("key") DO NOTHING`, key, def);
  }
  const biz = async (name: string, tz?: string) => {
    const b = await owner.business.create({ data: { name: `${name}-${stamp}` } });
    // The engine switched ON before every simulated moment (the activation trigger records the stamped time).
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt")
      VALUES ($1, 'notifications_engine', 'ENABLED', TIMESTAMP '2026-11-01 00:00:00')`, b.id);
    for (const k of ["documents", "appointments"]) {
      await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'ENABLED', now())`, b.id, k);
    }
    if (tz) await owner.bookingSettings.create({ data: { businessId: b.id, timeZone: tz } as never });
    return b.id;
  };
  const user = async (b: number, tag: string) => (await owner.user.create({ data: { email: `${tag}-${stamp}@nte9.lab`, password: "x", businessId: b } })).id;
  const tokenOf = new Map<string, number>();
  const device = async (businessId: number, userId: number) => {
    const u = await owner.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } });
    const s = await owner.authSession.create({
      data: {
        userId, secretHash: randomBytes(32).toString("hex"), tokenVersionAtIssue: u.tokenVersion,
        createdAt: new Date(), lastUsedAt: new Date(), idleExpiresAt: new Date(Date.now() + 400 * DAY), absoluteExpiresAt: new Date(Date.now() + 400 * DAY),
      },
      select: { id: true },
    });
    const token = `lab-${userId}:APA91b${randomBytes(24).toString("hex")}`;
    tokenOf.set(token, userId);
    await dev.registerFcmDevice({ businessId, userId, sessionId: s.id }, { token, platform: "android", appVersion: "1.5.0" }, new Date());
  };
  const appt = (businessId: number, startsAt: Date, status = "CONFIRMED") =>
    owner.appointment.create({ data: { businessId, status, startsAt, durationMinutes: 30, createdByActor: "CUSTOMER", sourceChannel: "PUBLIC_BOOKING", kind: "CUSTOMER" } as never, select: { id: true } });
  const rowsOf = (businessId: number, category: string) =>
    owner.notification.findMany({ where: { businessId, semanticCategory: category }, orderBy: { id: "asc" } });
  const sweep = (now: Date, businessId: number) => runStatusSweep(now, { ...q, businessIds: [businessId] });
  const work = (now: Date, businessId: number) => { clock = now.getTime(); return runPushWorker(now, { businessId, deps, quiet: true }); };
  // Set a document's stamp by hand (fixtures only): the trigger owns the column, so it is paused for this one write.
  const setStamp = async (id: number, at: Date | null) => {
    await owner.$executeRawUnsafe(`ALTER TABLE "Document" DISABLE TRIGGER "Document_status_changed_at"`);
    await owner.$executeRawUnsafe(`UPDATE "Document" SET "statusChangedAt" = $1::timestamp(3) WHERE "id" = $2`, at ? at.toISOString().replace("T", " ").replace("Z", "") : null, id);
    await owner.$executeRawUnsafe(`ALTER TABLE "Document" ENABLE TRIGGER "Document_status_changed_at"`);
  };

  /* ── 1. stuck documents ────────────────────────────────────────────────────────────────────────────────────── */
  console.log("1. stuck documents");
  const A = await biz("dd-A");
  await user(A, "a1");
  const T0 = new Date();
  // The upload's own statement, as the runtime: the trigger stamps it.
  const newDoc = async (status = "processing") => (await tenantTx(A, (tx) => tx.document.create({
    data: { businessId: A, fileUrl: "lab.pdf", source: "upload", mimeType: "application/pdf", status }, select: { id: true, statusChangedAt: true },
  })));
  const running = await newDoc();
  ok("the upload INSERT is stamped by the database (no application write)", running.statusChangedAt !== null && Math.abs(running.statusChangedAt.getTime() - Date.now()) < 60_000, running);
  await setStamp(running.id, new Date(T0.getTime() - 4 * MIN));
  const stuck = await newDoc();
  await setStamp(stuck.id, new Date(T0.getTime() - 29 * MIN));
  const hist = await newDoc();
  await setStamp(hist.id, null); // a row older than the migration: processing since forever, never stamped
  const failedDoc = await newDoc("failed");
  const docRows = () => rowsOf(A, "documents.processing_failed");
  const openKeys = async () => (await docRows()).filter((n) => n.resolvedAt === null).map((n) => n.dedupeKey).sort();

  await sweep(T0, A);
  ok("inside an attempt (4 min) and at 29 min: not flagged; the failed one is (old key)",
    JSON.stringify(await openKeys()) === JSON.stringify([`st:documents.processing_failed:document_processing:${failedDoc.id}`]), await openKeys());
  const t31 = new Date(T0.getTime() + 2 * MIN); // the 29-min document is now at 31 min
  await sweep(t31, A);
  const stuckStamp = (await owner.document.findUniqueOrThrow({ where: { id: stuck.id }, select: { statusChangedAt: true } })).statusChangedAt!;
  const stuckKey = `st:documents.processing_failed:document_processing:${stuck.id}:stuck:${stuckStamp.toISOString()}`;
  ok("past the threshold (31 min) ⇒ ONE stuck row; the 6-min attempt and the unstamped history are not",
    JSON.stringify(await openKeys()) === JSON.stringify([`st:documents.processing_failed:document_processing:${failedDoc.id}`, stuckKey].sort()), await openKeys());
  const stuckRow = (await docRows()).find((n) => n.dedupeKey === stuckKey)!;
  ok("…deep link to the document's screen, whole business, generic stored text", stuckRow.href === `/documents/review/${stuck.id}` && stuckRow.userId === null && !/[0-9]/.test(stuckRow.title));
  const del = await owner.notificationDelivery.findMany({ where: { notificationId: stuckRow.id }, orderBy: { id: "asc" } });
  ok("…in-app delivered; push owed but OFF by default (the worker ends it pref_off — never sent)", del.some((d) => d.channel === "IN_APP" && d.status === "SENT") && del.some((d) => d.channel === "PUSH" && d.status === "PENDING"));
  await device(A, (await owner.user.findFirstOrThrow({ where: { businessId: A }, select: { id: true } })).id);
  const wr = await work(t31, A);
  const pushAfter = await owner.notificationDelivery.findMany({ where: { notificationId: stuckRow.id, channel: "PUSH" }, orderBy: { id: "asc" } });
  ok("worker: the stuck document's push is suppressed by the default preference, nothing sent", sends.length === 0 && pushAfter.some((d) => d.status === "SUPPRESSED" && d.error === "pref_off"), { wr, pushAfter: pushAfter.map((d) => [d.userId, d.status, d.error]) });
  await sweep(new Date(T0.getTime() + 5 * DAY), A);
  ok("days later: the unstamped historical row is still never flagged", !(await openKeys()).some((k) => k.includes(`:${hist.id}:`)));

  // The retry: the app's own statement (processing → processing) — the trigger restamps; the attempt is not flagged.
  await tenantTx(A, (tx) => tx.document.updateMany({ where: { id: stuck.id, businessId: A }, data: { status: "processing" } }));
  const retriedAt = (await owner.document.findUniqueOrThrow({ where: { id: stuck.id }, select: { statusChangedAt: true } })).statusChangedAt!;
  ok("the retry restamps the attempt's start (trigger)", retriedAt.getTime() > stuckStamp.getTime());
  await sweep(new Date(retriedAt.getTime() + 3 * MIN), A);
  ok("…and while it runs it is not flagged: the old stuck row resolves", (await docRows()).find((n) => n.dedupeKey === stuckKey)?.resolvedAt !== null && !(await openKeys()).some((k) => k.includes(`:${stuck.id}:stuck`)));
  await sweep(new Date(retriedAt.getTime() + DOCUMENT_STUCK_MS + 5 * MIN), A);
  const again = (await openKeys()).filter((k) => k.includes(`:${stuck.id}:stuck`));
  ok("stuck again (the retry also died) ⇒ a NEW row (new key)", again.length === 1 && again[0] !== stuckKey, again);
  await tenantTx(A, (tx) => tx.document.updateMany({ where: { id: stuck.id, businessId: A }, data: { status: "needs_review" } }));
  await sweep(new Date(retriedAt.getTime() + DOCUMENT_STUCK_MS + 10 * MIN), A);
  ok("success (needs_review) ⇒ resolved", !(await openKeys()).some((k) => k.includes(`:${stuck.id}:`)));

  /* ── 2. per-user lead times, precision ─────────────────────────────────────────────────────────────────────── */
  console.log("2. per-user lead times (one business, three users), 15-min sweep + 5-min worker");
  const E = await biz("dd-E");
  const e30 = await user(E, "e30");
  const eDay = await user(E, "eday");
  const eDef = await user(E, "edef");
  for (const u of [e30, eDay, eDef]) await device(E, u);
  await store.patchSettings({ businessId: E, userId: e30 }, { appointmentReminderMinutes: 30 }, new Date());
  await store.patchSettings({ businessId: E, userId: eDay }, { appointmentReminderMinutes: 1440 }, new Date());
  // 14:00 Jerusalem (UTC+2) two days ahead: every moment (13:30, 13:00, 14:00 the day before) is outside quiet hours.
  const day2 = new Date(Date.now() + 2 * DAY);
  const S = new Date(Date.UTC(day2.getUTCFullYear(), day2.getUTCMonth(), day2.getUTCDate(), 12, 0, 0));
  const eAppt = await appt(E, S);
  const moments = new Map<number, number>([[e30, S.getTime() - 30 * MIN], [eDef, S.getTime() - 60 * MIN], [eDay, S.getTime() - DAY]]);
  sends.length = 0;
  // Interleave: sweeps on a 15-min grid shifted 7 min, the worker on a 5-min grid shifted 2 min.
  const ticks: { at: number; kind: "sweep" | "work" }[] = [];
  const windows = [[S.getTime() - DAY - 50 * MIN, S.getTime() - DAY + 20 * MIN], [S.getTime() - 100 * MIN, S.getTime()]];
  for (const [from, to] of windows) {
    for (let t = Math.floor(from / (15 * MIN)) * 15 * MIN + 7 * MIN; t < to; t += 15 * MIN) ticks.push({ at: t, kind: "sweep" });
    for (let t = Math.floor(from / (5 * MIN)) * 5 * MIN + 2 * MIN; t < to; t += 5 * MIN) ticks.push({ at: t, kind: "work" });
  }
  ticks.sort((x, y) => x.at - y.at || (x.kind === "sweep" ? -1 : 1));
  let earliestCreate: Record<number, number> = {};
  for (const tk of ticks) {
    if (tk.kind === "sweep") {
      await sweep(new Date(tk.at), E);
      for (const n of await rowsOf(E, "appointments.upcoming")) if (n.userId !== null && earliestCreate[n.userId] === undefined) earliestCreate[n.userId] = n.createdAt.getTime();
    } else {
      await work(new Date(tk.at), E);
    }
  }
  const byUser = new Map<number, number[]>();
  for (const s of sends) { const u = tokenOf.get(s.token)!; byUser.set(u, [...(byUser.get(u) ?? []), s.at]); }
  for (const [u, label] of [[e30, "30 min"], [eDef, "default (60 min)"], [eDay, "the day before"]] as const) {
    const got = byUser.get(u) ?? [];
    const m = moments.get(u)!;
    ok(`${label}: exactly one push, not before its moment, within 5 minutes after it`, got.length === 1 && got[0]! >= m && got[0]! - m < 5 * MIN,
      { got: got.map((x) => new Date(x).toISOString()), moment: new Date(m).toISOString() });
    ok(`${label}: created no earlier than one sweep interval before its moment (the bell is not filled ahead)`,
      earliestCreate[u] !== undefined && earliestCreate[u]! >= m - 15 * MIN, { created: earliestCreate[u] && new Date(earliestCreate[u]!).toISOString() });
  }
  const eRows = await rowsOf(E, "appointments.upcoming");
  ok("one reminder row per user per appointment start (three rows, three users, the leads in the keys)",
    eRows.length === 3 && new Set(eRows.map((n) => n.userId)).size === 3 && eRows.every((n) => n.dedupeKey.includes(`appointment:${eAppt.id}:${S.toISOString()}:u${n.userId}:l`)), eRows.map((n) => n.dedupeKey));
  const owedRows = await owner.notificationDelivery.findMany({ where: { businessId: E, channel: "PUSH", subscriptionId: null, notificationId: { in: eRows.map((n) => n.id) } } });
  ok("each owed push was due at its user's moment and expired at the start", owedRows.length === 3 && owedRows.every((d) => {
    const m = moments.get(d.userId!)!;
    return d.expiresAt?.getTime() === S.getTime() && d.nextAttemptAt !== null && d.nextAttemptAt.getTime() >= m && d.nextAttemptAt.getTime() - m < 15 * MIN;
  }), owedRows.map((d) => [d.userId, d.nextAttemptAt, d.expiresAt, d.status]));
  await sweep(new Date(S.getTime() + MIN), E);
  ok("after the start: all three resolved", (await rowsOf(E, "appointments.upcoming")).every((n) => n.resolvedAt !== null));

  /* ── 3. cancel ─────────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("3. cancel");
  const S3 = new Date(S.getTime() + DAY + 2 * HOUR); // 16:00 local
  const c = await appt(E, S3);
  sends.length = 0;
  await sweep(new Date(S3.getTime() - 70 * MIN), E); // the default user's window is open (moment −60, interval 15)
  const cRows = (await rowsOf(E, "appointments.upcoming")).filter((n) => n.entityId === c.id);
  ok("created ahead for the default user only (30-min window not open, the day before past its grace)", cRows.length === 1 && cRows[0]!.userId === eDef, cRows.map((n) => n.userId));
  await owner.appointment.update({ where: { id: c.id }, data: { status: "CANCELED" } });
  await sweep(new Date(S3.getTime() - 65 * MIN), E);
  ok("cancelled ⇒ resolved", (await rowsOf(E, "appointments.upcoming")).filter((n) => n.entityId === c.id).every((n) => n.resolvedAt !== null));
  await work(new Date(S3.getTime() - 60 * MIN), E);
  const cOwed = await owner.notificationDelivery.findMany({ where: { notificationId: cRows[0]!.id, channel: "PUSH" } });
  ok("…at its moment the owed push is suppressed ('resolved') and nothing is sent", sends.length === 0 && cOwed.some((d) => d.status === "SUPPRESSED" && d.error === "resolved"), cOwed.map((d) => [d.status, d.error]));

  /* ── 4. reschedule ─────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("4. reschedule");
  const S4 = new Date(S.getTime() + 2 * DAY); // 14:00 local
  const r = await appt(E, S4);
  sends.length = 0;
  await sweep(new Date(S4.getTime() - 70 * MIN), E);
  const oldRow = (await rowsOf(E, "appointments.upcoming")).find((n) => n.entityId === r.id && n.userId === eDef)!;
  ok("reminder created ahead for the original start", oldRow !== undefined && oldRow.dedupeKey.includes(S4.toISOString()));
  const S4b = new Date(S4.getTime() + 2 * HOUR);
  await owner.appointment.update({ where: { id: r.id }, data: { startsAt: S4b } });
  await sweep(new Date(S4.getTime() - 65 * MIN), E);
  await work(new Date(S4.getTime() - 60 * MIN), E);
  ok("moved ⇒ the old reminder resolves; nothing sent at the old moment", (await owner.notification.findUniqueOrThrow({ where: { id: oldRow.id } })).resolvedAt !== null && sends.length === 0);
  await sweep(new Date(S4b.getTime() - 68 * MIN), E);
  await work(new Date(S4b.getTime() - 58 * MIN), E);
  const newRow = (await rowsOf(E, "appointments.upcoming")).find((n) => n.entityId === r.id && n.userId === eDef && n.dedupeKey.includes(S4b.toISOString()));
  ok("the new start is a new reminder, sent once at ITS moment", newRow !== undefined && sends.filter((s) => tokenOf.get(s.token) === eDef).length === 1 && sends[0]!.at >= S4b.getTime() - 60 * MIN, sends.map((s) => new Date(s.at).toISOString()));

  /* ── 5. DST day ────────────────────────────────────────────────────────────────────────────────────────────── */
  console.log("5. the March 2027 clock change (Asia/Jerusalem)");
  const J = await biz("dd-J", "Asia/Jerusalem");
  const jDay = await user(J, "jday");
  const jDef = await user(J, "jdef");
  for (const u of [jDay, jDef]) await device(J, u);
  await store.patchSettings({ businessId: J, userId: jDay }, { appointmentReminderMinutes: 1440 }, new Date());
  const SJ = new Date("2027-03-26T07:00:00Z"); // 10:00 local, after the 02:00 → 03:00 jump that morning
  await appt(J, SJ);
  sends.length = 0;
  const dayMoment = new Date("2027-03-25T08:00:00Z"); // 10:00 local on the 25th (UTC+2): 23 real hours before
  await sweep(new Date(dayMoment.getTime() - 10 * MIN), J);
  await work(dayMoment, J);
  ok("the day before = 25 Mar 10:00 local (08:00Z, 23 real hours earlier), sent at that moment",
    sends.length === 1 && tokenOf.get(sends[0]!.token) === jDay && sends[0]!.at === dayMoment.getTime(), sends.map((s) => [tokenOf.get(s.token), new Date(s.at).toISOString()]));
  const jOwed = await owner.notificationDelivery.findFirst({ where: { businessId: J, channel: "PUSH", subscriptionId: null, userId: jDay } });
  ok("…its owed push was due exactly then", jOwed?.nextAttemptAt?.toISOString() === dayMoment.toISOString(), jOwed?.nextAttemptAt);
  sends.length = 0;
  await sweep(new Date("2027-03-26T05:50:00Z"), J);
  await work(new Date("2027-03-26T06:00:00Z"), J);
  ok("the default 60 min = 06:00Z (09:00 local after the jump), 60 real minutes before", sends.length === 1 && tokenOf.get(sends[0]!.token) === jDef);
  const jSummary = (await rowsOf(J, "appointments.upcoming")).find((n) => n.userId === jDay)?.summary;
  ok("the day-before reminder names the local date and time (26.3, 10:00)", jSummary === "התור ב-26.3 בשעה 10:00.", jSummary);

  /* ── 6. settings round-trip + permission ───────────────────────────────────────────────────────────────────── */
  console.log("6. settings round-trip and permission");
  const back = await store.loadPreferences({ businessId: E, userId: e30 });
  ok("the session actor's own choice reads back (30) and is what the producer uses", back.settings?.appointmentReminderMinutes === 30 && effectiveSettings(back.settings).appointmentReminderMinutes === 30);
  await store.patchSettings({ businessId: E, userId: e30 }, { appointmentReminderMinutes: 120 }, new Date());
  const other = await store.loadPreferences({ businessId: E, userId: eDay });
  ok("changing one user's lead leaves another user's untouched", (await store.loadPreferences({ businessId: E, userId: e30 })).settings?.appointmentReminderMinutes === 120 && other.settings?.appointmentReminderMinutes === 1440);
  const defUser = await store.loadPreferences({ businessId: E, userId: eDef });
  ok("a user who never chose reads the default (60)", defUser.settings === null && effectiveSettings(defUser.settings).appointmentReminderMinutes === 60);
  const crossRead = await tenantTx(J, (tx) => tx.notificationSettings.count({ where: { userId: e30 } }));
  const crossWrite = await tenantTx(J, (tx) => tx.notificationSettings.updateMany({ where: { userId: e30 }, data: { appointmentReminderMinutes: 30 } }));
  ok("another business cannot read or change it (RLS)", crossRead === 0 && crossWrite.count === 0 && (await store.loadPreferences({ businessId: E, userId: e30 })).settings?.appointmentReminderMinutes === 120);
  const crossUser = await store.patchSettings({ businessId: J, userId: e30 }, { appointmentReminderMinutes: 30 }, new Date()).then(() => "written", (e: Error) => e.name);
  ok("a forged actor (business J, a user of E) is refused by the database (same-business trigger / RLS)", crossUser !== "written", crossUser);
  ok("the API refuses a user id in the body (the actor is the session's)", !validateSettingsPatch({ appointmentReminderMinutes: 30, userId: eDay }).ok);
  const bad = await store.patchSettings({ businessId: E, userId: e30 }, { appointmentReminderMinutes: 45 } as never, new Date()).then(() => "written", (e: Error) => String(e.message));
  ok("the database CHECK refuses 45 even past the validator", bad !== "written" && /appointment_reminder|check/i.test(bad), bad.slice(0, 200));

  await owner.$disconnect();
  console.log(`\n[docs-appointments.db] checks=${checks} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
