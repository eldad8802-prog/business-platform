/**
 * Task reminders — on a real database, AS THE RESTRICTED RUNTIME (NOSUPERUSER NOBYPASSRLS, a member of app_runtime),
 * over the real migrations (20261018090000 + 20261022090000, built by .trp/lab.sh). Owner-approved plan 2026-10-21.
 *
 *   Moment:    a task with a day, a time and a reminder gets remindAt = Israeli wall clock − offset; a moment set in
 *              the past is marked handled (no stale send).
 *   Due:       task_reminders_due() lists it only once the moment has come; identifiers only.
 *   Once:      the dispatcher claims, records the bell notification (IN_APP delivery) and attempts push to the
 *              user's live subscriptions (each attempt recorded); a second dispatch, or a parallel one, sends nothing.
 *   Snooze:    the reminder moves; a dispatch for the OLD moment sends nothing; the new moment is sent once.
 *   Close:     a task completed or cancelled before its moment is never sent, and its bell reminder is resolved.
 *   Change:    rescheduling after a send moves the moment and re-arms it.
 *   Recurring: a series with a time and a reminder gives every occurrence its own moment; completing one creates
 *              the next with the next day's moment.
 *   Flag:      a business without daily_tasks is never claimed.
 *   Isolation: a due record naming another business claims nothing; B never sees A's reminders.
 *   Personal:  the personal agenda has only the owner's tasks (no business items) and reaches beyond a week.
 *   Reliability: the in-app poll reads its own business in its tenant tx (another business's 101 earlier reminders
 *              cannot crowd it out); the lagged backstop picks up only reminders already 7+ minutes late; QStash,
 *              the backstop and the poll racing on one reminder still produce one bell row and one delivery.
 *   Starvation: 150 due reminders of a business with daily_tasks OFF (all earlier) do not delay another business's
 *              reminder in the GLOBAL pass (re-read through task_reminders_due_excluding, migration 20261211090000);
 *              the flag-off business's reminders are not claimed, not written and stay due.
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). VAPID is NOT configured here: push attempts are recorded as FAILED without any network call. Synthetic
 * data only. Run: npx tsx lib/services/tasks/task-reminders.db.test.ts
 */
import { PrismaClient } from "@prisma/client";

process.env.TASK_REQUEST_HMAC_KEY ??= "daily-tasks-lab-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID ??= "lab1";
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
delete process.env.VAPID_SUBJECT;
delete process.env.QSTASH_TOKEN;

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra ?? "");
  }
}

async function main() {
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { jerusalemDayKey, addCalendarDays, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const { uuidV7 } = await import("./task-idempotency");
  const svc = await import("./task.service");
  const { getAgenda } = await import("./agenda.service");
  const rem = await import("./task-reminders.service");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const NOW = new Date();
  const TODAY = jerusalemDayKey(NOW);
  const TOMORROW = addCalendarDays(TODAY, 1);
  let tick = 0;
  const key = () => uuidV7(new Date(NOW.getTime() - 5000 + ++tick));
  const as = <T>(businessId: number, fn: () => Promise<T>) => runWithTenantContext({ businessId }, fn);
  // The key is minted relative to the moment the request carries (the server refuses a key older than 24 h).
  const req = (now = NOW) => ({ idempotencyKey: uuidV7(new Date(now.getTime() - 5000 + ++tick)), now });
  const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
  const dueIds = async (at: Date) => (await rem.dueReminders(at, 500)).map((d) => d.taskId);

  const bizA = await owner.business.create({ data: { name: "trp-A" } });
  const bizB = await owner.business.create({ data: { name: "trp-B" } });
  const uA = await owner.user.create({ data: { email: `ra-${Date.now()}@trp.lab`, password: "x", businessId: bizA.id } });
  const uB = await owner.user.create({ data: { email: `rb-${Date.now()}@trp.lab`, password: "x", businessId: bizB.id } });
  const A = { businessId: bizA.id, userId: uA.id };
  const B = { businessId: bizB.id, userId: uB.id };
  await owner.businessFeatureAccess.create({ data: { businessId: A.businessId, featureKey: "daily_tasks", state: "ENABLED" } });

  try {
    console.log("moment");
    const r1 = await as(A.businessId, () => svc.createTask(A, req(), { title: "להתקשר לספק", dueOn: TOMORROW, dueMinute: 600, remindOffsetMinutes: 15 }));
    const t1 = r1.task!;
    const expected = new Date(jerusalemInstantAt(TOMORROW, 10, 0).getTime() - 15 * 60_000);
    ok("remindAt = tomorrow 10:00 Israel − 15 minutes", t1.remindAt?.getTime() === expected.getTime(), { got: t1.remindAt, expected });
    ok("not yet claimed", t1.reminderSentAt === null && t1.dueMinute === 600 && t1.remindOffsetMinutes === 15);
    const past = await as(A.businessId, () => svc.createTask(A, req(), { title: "כבר עבר", dueOn: TODAY, dueMinute: 0, remindOffsetMinutes: 0 }));
    ok("a moment already passed is marked handled (no stale send)", past.task!.reminderSentAt !== null);
    ok("an invalid shape is refused by the service", (await as(A.businessId, () => svc.createTask(A, req(), { title: "x", dueOn: null, dueMinute: 600 })).then(() => "OK", (e) => e.code)) === "INVALID_INPUT");

    console.log("due and once");
    const at1 = t1.remindAt!;
    ok("not due a minute before its moment", !(await dueIds(plus(at1, -1))).includes(t1.id));
    ok("due at its moment", (await dueIds(plus(at1, 1))).includes(t1.id));
    await owner.pushSubscription.create({ data: { businessId: A.businessId, userId: A.userId, endpoint: "https://fcm.googleapis.com/fcm/send/trp-lab", p256dh: "BPk_lab", auth: "au_lab", platform: "android", updatedAt: NOW } });
    const due1 = (await rem.dueReminders(plus(at1, 1), 500)).find((d) => d.taskId === t1.id)!;
    const [a, b] = await Promise.all([rem.dispatchReminder(due1, plus(at1, 1)), rem.dispatchReminder(due1, plus(at1, 1))]);
    const sentCount = [a, b].filter((x) => x.result === "sent").length;
    ok("two parallel dispatches: exactly one sends", sentCount === 1, [a, b]);
    const notes = await owner.notification.findMany({ where: { businessId: A.businessId, entityType: "task", entityId: t1.id } });
    ok("one bell notification for the reminder", notes.length === 1 && notes[0].dedupeKey === rem.reminderDedupeKey(t1.id, at1) && notes[0].href === `/tasks?task=${t1.id}`);
    const deliveries = await owner.notificationDelivery.findMany({ where: { notificationId: notes[0].id } });
    ok("the in-app delivery is SENT; the push attempt is recorded (FAILED: no VAPID in the lab)",
      deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT") && deliveries.some((d) => d.channel === "PUSH" && d.status === "FAILED"), deliveries);
    ok("a third dispatch sends nothing", (await rem.dispatchReminder(due1, plus(at1, 2))).result === "skipped");
    ok("no longer due once sent", !(await dueIds(plus(at1, 5))).includes(t1.id));
    const unseen = await rem.unseenReminders(A.businessId, plus(at1, 1));
    ok("the owner sees it until read", unseen.some((u) => u.taskId === t1.id));

    console.log("snooze");
    const r2 = await as(A.businessId, () => svc.createTask(A, req(), { title: "לחדש ביטוח", dueOn: TOMORROW, dueMinute: 540, remindOffsetMinutes: 0 }));
    const t2 = r2.task!;
    const oldDue = { businessId: A.businessId, taskId: t2.id, remindAt: t2.remindAt! };
    const newAt = plus(t2.remindAt!, 60);
    const s2 = await as(A.businessId, () => svc.snoozeReminder(A, req(), t2.id, { expectedVersion: t2.version, until: newAt.toISOString() }));
    ok("snooze moves the moment and re-arms it", s2.task!.remindAt?.getTime() === newAt.getTime() && s2.task!.reminderSentAt === null);
    ok("the OLD moment sends nothing (stale)", (await rem.dispatchReminder(oldDue, plus(oldDue.remindAt, 1))).result === "skipped");
    ok("not due at the old moment", !(await dueIds(plus(oldDue.remindAt, 1))).includes(t2.id));
    const newDue = (await rem.dueReminders(plus(newAt, 1), 500)).find((d) => d.taskId === t2.id);
    ok("due at the new moment, and sent once", !!newDue && (await rem.dispatchReminder(newDue, plus(newAt, 1))).result === "sent");
    const ev = await owner.taskEvent.findFirst({ where: { businessId: A.businessId, taskId: t2.id, eventType: "TASK_SNOOZED" } });
    ok("the snooze is in the history (moments only)", !!ev && (ev.payload as Record<string, unknown>).remindTo === newAt.toISOString());
    ok("a snooze into the past is refused", (await as(A.businessId, () => svc.snoozeReminder(A, req(), t2.id, { expectedVersion: s2.task!.version, until: plus(NOW, -10).toISOString() })).then(() => "OK", (e) => e.code)) === "INVALID_INPUT");

    console.log("close before the moment");
    const r3 = await as(A.businessId, () => svc.createTask(A, req(), { title: "לסגור לפני", dueOn: TOMORROW, dueMinute: 720, remindOffsetMinutes: 0 }));
    const t3 = r3.task!;
    const due3 = { businessId: A.businessId, taskId: t3.id, remindAt: t3.remindAt! };
    await as(A.businessId, () => svc.completeTask(A, req(), t3.id, { expectedVersion: t3.version }));
    ok("completed before its moment: never due", !(await dueIds(plus(t3.remindAt!, 1))).includes(t3.id));
    ok("completed before its moment: a dispatch sends nothing", (await rem.dispatchReminder(due3, plus(t3.remindAt!, 1))).result === "skipped");
    const r4 = await as(A.businessId, () => svc.createTask(A, req(), { title: "לבטל", dueOn: TOMORROW, dueMinute: 780, remindOffsetMinutes: 0 }));
    await as(A.businessId, () => svc.cancelTask(A, req(), r4.task!.id, { expectedVersion: r4.task!.version }));
    ok("cancelled before its moment: never due", !(await dueIds(plus(r4.task!.remindAt!, 1))).includes(r4.task!.id));
    await rem.resolveTaskReminderNotifications(A.businessId, t1.id, NOW);
    ok("closing resolves the bell reminder", (await rem.unseenReminders(A.businessId, plus(at1, 1))).every((u) => u.taskId !== t1.id));

    console.log("change after a send");
    const t1now = (await owner.task.findUnique({ where: { id: t1.id } }))!;
    const moved = await as(A.businessId, () => svc.rescheduleTask(A, req(), t1.id, { expectedVersion: t1now.version, dueOn: addCalendarDays(TODAY, 2), dueMinute: 660 }));
    ok("rescheduling keeps the offset, moves the moment and re-arms it",
      moved.task!.remindOffsetMinutes === 15 && moved.task!.reminderSentAt === null
        && moved.task!.remindAt?.getTime() === jerusalemInstantAt(addCalendarDays(TODAY, 2), 11, 0).getTime() - 15 * 60_000);
    const cleared = await as(A.businessId, () => svc.rescheduleTask(A, req(), t1.id, { expectedVersion: moved.task!.version, dueOn: addCalendarDays(TODAY, 2), remindOffsetMinutes: null }));
    ok("clearing the reminder clears the moment", cleared.task!.remindAt === null && cleared.task!.remindOffsetMinutes === null);

    console.log("recurring");
    const sr = await as(A.businessId, () => svc.createSeries(A, req(), { title: "לספור קופה", rule: { kind: "DAILY" }, startOn: TOMORROW, dueMinute: 1080, remindOffsetMinutes: 60 }));
    const occ1 = sr.task!;
    ok("the first occurrence has its moment (17:00 tomorrow)", occ1.remindAt?.getTime() === jerusalemInstantAt(TOMORROW, 18, 0).getTime() - 60 * 60_000);
    const later = plus(occ1.remindAt!, 120);
    const done = await as(A.businessId, () => svc.completeTask(A, req(later), occ1.id, { expectedVersion: occ1.version }));
    const occ2 = await owner.task.findUnique({ where: { id: done.nextTaskId! } });
    ok("completing creates the next occurrence with its own moment",
      !!occ2 && occ2.remindAt !== null && occ2.dueMinute === 1080 && occ2.remindOffsetMinutes === 60 && occ2.remindAt.getTime() > occ1.remindAt!.getTime(), occ2);

    console.log("several open, edit and reschedule (owner 2026-10-24)");
    const many = await Promise.all(
      [600, 615, 630].map((m, i) => as(A.businessId, () => svc.createTask(A, req(), { title: `פתוחה ${i + 1}`, dueOn: TOMORROW, dueMinute: m, remindOffsetMinutes: 0 }))),
    );
    const manyIds = many.map((r) => r.task!.id);
    ok("three personal tasks open side by side (no one-open limit)", new Set(manyIds).size === 3
      && (await owner.task.count({ where: { businessId: A.businessId, id: { in: manyIds }, status: "OPEN" } })) === 3);
    const [m1, m2] = many.map((r) => r.task!);
    const edited = await as(A.businessId, () => svc.editTask(A, req(), m1.id, { expectedVersion: m1.version, title: "פתוחה 1 — נערכה", note: "פירוט חדש" }));
    ok("editing title and note before the send keeps the moment and does not arm a second one",
      edited.task!.remindAt?.getTime() === m1.remindAt!.getTime() && edited.task!.reminderSentAt === null && edited.task!.title === "פתוחה 1 — נערכה");
    const dueM1 = (await rem.dueReminders(plus(m1.remindAt!, 1), 500)).find((d) => d.taskId === m1.id)!;
    ok("…sent once at its moment", (await rem.dispatchReminder(dueM1, plus(m1.remindAt!, 1))).result === "sent"
      && (await rem.dispatchReminder(dueM1, plus(m1.remindAt!, 2))).result === "skipped");
    const m1now = (await owner.task.findUnique({ where: { id: m1.id } }))!;
    await as(A.businessId, () => svc.editTask(A, req(), m1.id, { expectedVersion: m1now.version, note: null }));
    ok("editing after the send does not re-arm it", !(await dueIds(plus(m1.remindAt!, 5))).includes(m1.id)
      && (await owner.task.findUnique({ where: { id: m1.id } }))!.reminderSentAt !== null);
    ok("…one bell notification only", (await owner.notification.count({ where: { businessId: A.businessId, entityType: "task", entityId: m1.id } })) === 1);
    const oldM2 = { businessId: A.businessId, taskId: m2.id, remindAt: m2.remindAt! };
    const movedM2 = await as(A.businessId, () => svc.rescheduleTask(A, req(), m2.id, { expectedVersion: m2.version, dueOn: TOMORROW, dueMinute: 700 }));
    const newM2 = movedM2.task!.remindAt!;
    ok("rescheduling before the send: the OLD moment sends nothing", (await rem.dispatchReminder(oldM2, plus(oldM2.remindAt, 1))).result === "skipped"
      && !(await dueIds(plus(oldM2.remindAt, 1))).includes(m2.id));
    const dueM2 = (await rem.dueReminders(plus(newM2, 1), 500)).find((d) => d.taskId === m2.id);
    ok("…the new moment sends once", !!dueM2 && (await rem.dispatchReminder(dueM2, plus(newM2, 1))).result === "sent"
      && (await rem.dispatchReminder(dueM2, plus(newM2, 2))).result === "skipped");
    const seriesId = occ2!.seriesId!;
    const occOnly = await as(A.businessId, () => svc.editTask(A, req(), occ2!.id, { expectedVersion: occ2!.version, title: "רק הפעם" }));
    ok("editing one occurrence leaves the series title", occOnly.task!.title === "רק הפעם"
      && (await owner.taskSeries.findUnique({ where: { id: seriesId } }))!.title === "לספור קופה");
    const ser = (await owner.taskSeries.findUnique({ where: { id: seriesId } }))!;
    await as(A.businessId, () => svc.changeSeries(A, req(), seriesId, { expectedVersion: ser.version, title: "לספור קופה וכסף" }));
    const occ2now = (await owner.task.findUnique({ where: { id: occ2!.id } }))!;
    ok("editing the series renames it and its open occurrence, and keeps the moment",
      (await owner.taskSeries.findUnique({ where: { id: seriesId } }))!.title === "לספור קופה וכסף"
        && occ2now.title === "לספור קופה וכסף" && occ2now.remindAt?.getTime() === occ2!.remindAt!.getTime() && occ2now.reminderSentAt === null);

    console.log("flag and isolation");
    const rb = await as(B.businessId, () => svc.createTask(B, req(), { title: "B", dueOn: TOMORROW, dueMinute: 600, remindOffsetMinutes: 0 }));
    const dueB = { businessId: B.businessId, taskId: rb.task!.id, remindAt: rb.task!.remindAt! };
    const offB = await rem.dispatchReminder(dueB, plus(dueB.remindAt, 1));
    ok("a business without daily_tasks is never claimed", offB.result === "skipped" && offB.reason === "FLAG_OFF");
    ok("…and its reminder stays unclaimed", (await owner.task.findUnique({ where: { id: dueB.taskId } }))!.reminderSentAt === null);
    const forged = await rem.dispatchReminder({ businessId: A.businessId, taskId: dueB.taskId, remindAt: dueB.remindAt }, plus(dueB.remindAt, 1));
    ok("a due record naming another business claims nothing", forged.result === "skipped");
    ok("B sees none of A's reminders", (await rem.unseenReminders(B.businessId, plus(at1, 1))).length === 0);

    console.log("personal agenda");
    await as(A.businessId, () => svc.createTask(A, req(), { title: "בעוד חודש", dueOn: addCalendarDays(TODAY, 30) }));
    const personal = await as(A.businessId, () => getAgenda(A.businessId, NOW, undefined, { personal: true }));
    const prow = personal.buckets.flatMap((x) => x.rows);
    ok("personal: only the owner's tasks (no business items)", prow.every((r) => r.type === "TASK" || r.type === "REPAIR"));
    ok("personal: reaches beyond a week", prow.some((r) => r.type === "TASK" && r.task.title === "בעוד חודש"));
    const full = await as(A.businessId, () => getAgenda(A.businessId, NOW));
    ok("the full agenda still stops at a week", !full.buckets.flatMap((x) => x.rows).some((r) => r.type === "TASK" && r.task.title === "בעוד חודש"));
    ok("personal rows carry the time and the reminder", prow.some((r) => r.type === "TASK" && r.task.dueMinute != null && r.task.remindOffsetMinutes != null));

    console.log("reliability: per-business poll, the lagged backstop, and racing paths");
    // 101 due reminders in B, all EARLIER than A's: the old poll read the global top 100 and filtered afterwards, so
    // A's own reminder could be crowded out by another business's.
    const early = plus(NOW, -60);
    await owner.task.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ businessId: B.businessId, title: `noise-${i}`, status: "OPEN" as const, remindAt: early })) });
    const aDue = await owner.task.create({ data: { businessId: A.businessId, title: "A due now", status: "OPEN", remindAt: plus(NOW, -2) } });
    const globalTop = (await rem.dueReminders(NOW, 100)).map((d) => d.taskId);
    ok("(the old gap, reproduced) the global top 100 does not contain A's reminder", !globalTop.includes(aDue.id));
    const own = await rem.dueRemindersForBusiness(A.businessId, NOW);
    ok("per-business read: A's reminder is found despite 101 earlier ones in B", own.some((d) => d.taskId === aDue.id));
    ok("per-business read: never another business's reminder", own.every((d) => d.businessId === A.businessId));
    const pollPass = await rem.dispatchDueReminders(NOW, A.businessId);
    ok("the in-app poll pass sends A's reminder", pollPass.sent >= 1 && (await owner.task.findUnique({ where: { id: aDue.id } }))!.reminderSentAt !== null, pollPass);
    ok("…and claims nothing in B", (await owner.task.count({ where: { businessId: B.businessId, title: { startsWith: "noise-" }, reminderSentAt: { not: null } } })) === 0);

    // The noise has done its job; a business with daily_tasks OFF keeps its reminders due (never claimed), and in the
    // GLOBAL pass they would fill the batch ahead of A's — a known limit of the global batch, reported separately.
    await owner.task.updateMany({ where: { businessId: B.businessId, title: { startsWith: "noise-" } }, data: { reminderSentAt: NOW } });
    const recent = await owner.task.create({ data: { businessId: A.businessId, title: "A due 2 min ago", status: "OPEN", remindAt: plus(NOW, -2) } });
    const late = await owner.task.create({ data: { businessId: A.businessId, title: "A due 10 min ago", status: "OPEN", remindAt: plus(NOW, -10) } });
    await rem.dispatchDueReminders(NOW, { minLagMinutes: rem.BACKSTOP_LAG_MINUTES });
    const recentAfter = (await owner.task.findUnique({ where: { id: recent.id } }))!;
    const lateAfter = (await owner.task.findUnique({ where: { id: late.id } }))!;
    ok("backstop (lag 7 min): a reminder 10 minutes late is picked up", lateAfter.reminderSentAt !== null);
    ok("backstop (lag 7 min): a reminder 2 minutes old is left to QStash", recentAfter.reminderSentAt === null);

    const raced = await owner.task.create({ data: { businessId: A.businessId, title: "A raced", status: "OPEN", remindAt: plus(NOW, -9) } });
    await Promise.all([
      rem.dispatchDueReminders(NOW),
      rem.dispatchDueReminders(NOW, { minLagMinutes: rem.BACKSTOP_LAG_MINUTES }),
      rem.dispatchDueReminders(NOW, A.businessId),
    ]);
    const raceKey = rem.reminderDedupeKey(raced.id, raced.remindAt!);
    const raceNotes = await owner.notification.findMany({ where: { businessId: A.businessId, dedupeKey: raceKey }, select: { id: true } });
    const inApp = raceNotes.length === 1 ? await owner.notificationDelivery.count({ where: { notificationId: raceNotes[0].id, channel: "IN_APP" } }) : -1;
    ok("QStash + backstop + poll racing on one reminder: one bell row, one delivery (one claim winner)", raceNotes.length === 1 && inApp === 1, { notes: raceNotes.length, inApp });

    console.log("starvation: a flag-off business cannot fill the GLOBAL batch (owner decision 2026-11-13)");
    // The global re-read needs task_reminders_due_excluding (migration 20261211090000_notification_engine_followup).
    // The lab (.trp) applies only the migrations its chain names: when the follow-up is in the repository, its
    // function section is applied here as the owner; when it is not, the check below FAILS — this code must not ship
    // before that migration.
    const hasFn = async () => Number((await owner.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM pg_proc WHERE proname = 'task_reminders_due_excluding'`))[0].n) === 1;
    if (!(await hasFn())) {
      const fs = await import("node:fs");
      const file = "prisma/migrations/20261211090000_notification_engine_followup/migration.sql";
      if (fs.existsSync(file)) {
        const sql = fs.readFileSync(file, "utf8");
        const section = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.task_reminders_due_excluding"), sql.indexOf("-- ── 2."));
        for (const stmt of section.split(/;\s*\n(?=CREATE|REVOKE|DO|GRANT)/)) if (stmt.trim()) await owner.$executeRawUnsafe(stmt.trim().replace(/;\s*$/, ""));
      }
    }
    ok("task_reminders_due_excluding exists (migration 20261211090000 applied)", await hasFn());
    const bizOff = await owner.business.create({ data: { name: "trp-OFF" } });
    const old = plus(NOW, -120);
    await owner.task.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ businessId: bizOff.id, title: `off-${i}`, status: "OPEN" as const, remindAt: old })) });
    const offBefore = await owner.task.findMany({ where: { businessId: bizOff.id }, select: { id: true, updatedAt: true, reminderSentAt: true }, orderBy: { id: "asc" } });
    const aStarved = await owner.task.create({ data: { businessId: A.businessId, title: "A behind 150 flag-off reminders", status: "OPEN", remindAt: plus(NOW, -1) } });
    const top = (await rem.dueReminders(NOW, 100)).map((d) => d.businessId);
    ok("(the gap, reproduced) the plain global top 100 is all flag-off reminders", top.length === 100 && top.every((b) => b === bizOff.id));
    const excl = await rem.dueRemindersExcluding(NOW, 100, [bizOff.id]);
    ok("the definer re-read without the flag-off business finds A's reminder (identifiers only)", excl.some((d) => d.taskId === aStarved.id) && excl.every((d) => d.businessId !== bizOff.id));
    const globalPass = await rem.dispatchDueReminders(NOW);
    ok("the GLOBAL pass sends A's reminder despite 150 earlier flag-off ones", (await owner.task.findUnique({ where: { id: aStarved.id } }))!.reminderSentAt !== null, globalPass);
    const offAfter = await owner.task.findMany({ where: { businessId: bizOff.id }, select: { id: true, updatedAt: true, reminderSentAt: true }, orderBy: { id: "asc" } });
    ok("the flag-off business: nothing claimed, its reminders' data untouched", JSON.stringify(offAfter) === JSON.stringify(offBefore) && offAfter.every((t) => t.reminderSentAt === null));
    ok("the flag-off business: no bell row, no delivery", (await owner.notification.count({ where: { businessId: bizOff.id } })) === 0 && (await owner.notificationDelivery.count({ where: { businessId: bizOff.id } })) === 0);
    ok("its reminders stay due (they are sent if the flag is turned on later)", (await rem.dueReminders(NOW, 500)).filter((d) => d.businessId === bizOff.id).length === 150);
    await owner.task.updateMany({ where: { businessId: bizOff.id }, data: { reminderSentAt: NOW } }); // leave the lab quiet
  } finally {
    await owner.$disconnect();
  }
  console.log(`\ntask reminders (db): ${failed ? `${failed} of ${checks} FAILED` : `${checks} checks passed`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e instanceof Error ? e.message : e);
  process.exit(1);
});
