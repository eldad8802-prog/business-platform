/**
 * Daily Tasks — TaskService on a real database, AS THE RESTRICTED RUNTIME (NOSUPERUSER NOBYPASSRLS, a member of
 * app_runtime), over the real migration 20261018090000_daily_tasks_foundation (built by .dt/lab.sh):
 *
 *   Isolation (12.5): business B's actor cannot read, change or link to A's tasks and series; a context-less
 *     read of the task tables returns nothing; a user of another business is refused by the database (T-P5).
 *   Lifecycle (6.1): create → edit → reschedule → snooze → complete → reopen → cancel, one journal event each,
 *     versions enforced (VERSION_CONFLICT), invalid states refused.
 *   Series (6.2, 6.5): T-R1 … T-R9 — reopen withdraws an untouched next occurrence; refused when it was acted on
 *     or when the occurrence is not the latest; parallel completions / completion + reopen / resumes / rule change
 *     + completion all end with exactly ONE open occurrence; missed occurrences journaled as SYSTEM.
 *   Repeated requests (12.9): T-I1 … T-I6 — same key + same body → the first answer, one write; same key + other
 *     body → IDEMPOTENCY_KEY_REUSED; a 25-hour key → STALE; the journal answers when the fingerprint is gone; a
 *     cleared digest refuses every reuse; parallel first requests → one write, the same answer, no 500.
 *   Erasure (12.6, T-P1): account deletion blanks the text of tasks and series (rows and history stay) and
 *     removes the request fingerprints; the journal is untouched.
 *
 * env: DATABASE_URL / DIRECT_URL = the runtime login (app_runtime_prod), OWNER_URL = the migration role (fixtures
 * only). TASK_REQUEST_HMAC_KEY is set here. Synthetic data only.
 *
 * Run: npx tsx lib/services/tasks/task.service.db.test.ts
 */
import { PrismaClient } from "@prisma/client";

process.env.TASK_REQUEST_HMAC_KEY ??= "daily-tasks-lab-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID ??= "lab1";

import { prisma } from "@/lib/prisma";
import { prismaAccountDeletionStore } from "@/lib/services/account/account-deletion.prisma-store";
import { addCalendarDays, jerusalemDayKey } from "@/lib/utils/jerusalem-day";

import { uuidV7 } from "./task-idempotency";
import * as svc from "./task.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

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
async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "OK"; } catch (e) { return e instanceof svc.TaskServiceError ? e.code : `ERR:${(e as Error).message}`; }
}

const NOW = new Date("2026-10-12T09:00:00.000Z"); // Monday, 12:00 in Jerusalem
const TODAY = jerusalemDayKey(NOW);
let tick = 0;
/** A fresh UUIDv7 a few milliseconds apart, so every request is distinct. */
const key = (at = NOW) => uuidV7(new Date(at.getTime() - 1000 + (++tick)));
const req = (k = key(), now = NOW) => ({ idempotencyKey: k, now });

async function events(businessId: number, where: Record<string, unknown> = {}) {
  return owner.taskEvent.findMany({ where: { businessId, ...where }, orderBy: { id: "asc" } });
}
async function openCount(businessId: number, seriesId: number) {
  return owner.task.count({ where: { businessId, seriesId, status: "OPEN" } });
}

async function main() {
  // ── Fixtures (owner) ─────────────────────────────────────────────────────────────────────────
  const bizA = await owner.business.create({ data: { name: "dt-svc-A" } });
  const bizB = await owner.business.create({ data: { name: "dt-svc-B" } });
  const uA = await owner.user.create({ data: { email: `a-${Date.now()}@dt.lab`, password: "x", businessId: bizA.id } });
  const uB = await owner.user.create({ data: { email: `b-${Date.now()}@dt.lab`, password: "x", businessId: bizB.id } });
  const custA = await owner.customer.create({ data: { businessId: bizA.id, name: "c" } });
  const custB = await owner.customer.create({ data: { businessId: bizB.id, name: "c" } });
  const leadOpen = await owner.lead.create({ data: { businessId: bizA.id, status: "NEW" } });
  const leadWon = await owner.lead.create({ data: { businessId: bizA.id, status: "WON" } });
  const A = { businessId: bizA.id, userId: uA.id };
  const B = { businessId: bizB.id, userId: uB.id };

  // ── Isolation ────────────────────────────────────────────────────────────────────────────────
  console.log("isolation");
  const t1 = await svc.createTask(A, req(), { title: "לשלוח הצעה", dueOn: TODAY, link: { kind: "customer", id: custA.id } });
  ok("A creates a task linked to its own customer", !!t1.task && t1.task.customerId === custA.id && t1.task.createdByUserId === uA.id);
  ok("B cannot read A's task through any operation (NOT_FOUND)", (await code(svc.completeTask(B, req(), t1.task!.id, { expectedVersion: 1 }))) === "NOT_FOUND");
  ok("B cannot link a task to A's customer (LINK_NOT_FOUND)", (await code(svc.createTask(B, req(), { title: "x", link: { kind: "customer", id: custA.id } }))) === "LINK_NOT_FOUND");
  ok("A cannot link to B's customer", (await code(svc.createTask(A, req(), { title: "x", link: { kind: "customer", id: custB.id } }))) === "LINK_NOT_FOUND");
  ok("a task on an OPEN lead is refused (the lead's own follow-up is the one slot)", (await code(svc.createTask(A, req(), { title: "x", link: { kind: "lead", id: leadOpen.id } }))) === "LINK_LEAD_OPEN");
  ok("a task on a closed lead is accepted", (await code(svc.createTask(A, req(), { title: "x", link: { kind: "lead", id: leadWon.id } }))) === "OK");
  const ctxless = await prisma.$transaction(async (tx) => ({
    t: await tx.task.count(), s: await tx.taskSeries.count(), e: await tx.taskEvent.count(), l: await tx.taskRequestLedger.count(),
  }));
  ok("the runtime without a tenant context sees no task, series, event or fingerprint", ctxless.t + ctxless.s + ctxless.e + ctxless.l === 0, ctxless);
  const spoof = await code(svc.createTask({ businessId: bizA.id, userId: uB.id }, req(), { title: "x" }));
  ok("T-P5: a user of another business is refused by the database", /TASK_USER_OTHER_BUSINESS/.test(spoof), spoof.slice(0, 200));

  // ── Lifecycle (6.1) ──────────────────────────────────────────────────────────────────────────
  console.log("lifecycle");
  const id = t1.task!.id;
  const e1 = await svc.editTask(A, req(), id, { expectedVersion: 1, title: "לשלוח הצעה מעודכנת" });
  ok("edit bumps the version", e1.task?.version === 2);
  ok("a stale version is refused (VERSION_CONFLICT)", (await code(svc.editTask(A, req(), id, { expectedVersion: 1, note: "x" }))) === "VERSION_CONFLICT");
  const r1 = await svc.rescheduleTask(A, req(), id, { expectedVersion: 2, dueOn: addCalendarDays(TODAY, 2) });
  ok("reschedule moves dueOn", r1.task?.dueOn?.toISOString().slice(0, 10) === addCalendarDays(TODAY, 2));
  ok("snooze to today is refused (must be in the future)", (await code(svc.snoozeTask(A, req(), id, { expectedVersion: 3, dueOn: TODAY }))) === "INVALID_INPUT");
  const s1 = await svc.snoozeTask(A, req(), id, { expectedVersion: 3, dueOn: addCalendarDays(TODAY, 7) });
  ok("snooze moves dueOn (a separate signal from reschedule)", s1.task?.version === 4);
  const c1 = await svc.completeTask(A, req(), id, { expectedVersion: 4 });
  ok("complete → DONE with completedAt / completedByUserId", c1.task?.status === "DONE" && !!c1.task.completedAt && c1.task.completedByUserId === uA.id);
  ok("a DONE task cannot be edited", (await code(svc.editTask(A, req(), id, { expectedVersion: 5, title: "y" }))) === "INVALID_STATE");
  const o1 = await svc.reopenTask(A, req(), id, { expectedVersion: 5 });
  ok("reopen → OPEN, completion cleared", o1.task?.status === "OPEN" && o1.task.completedAt === null);
  const x1 = await svc.cancelTask(A, req(), id, { expectedVersion: 6 });
  ok("cancel → CANCELED", x1.task?.status === "CANCELED");
  ok("skip is for occurrences only", (await code(svc.skipOccurrence(A, req(), id, { expectedVersion: 7 }))) === "NOT_AN_OCCURRENCE");
  const ev1 = (await events(bizA.id, { taskId: id })).map((e) => e.eventType);
  ok("one journal event per state change, in order",
    JSON.stringify(ev1) === JSON.stringify(["TASK_CREATED", "TASK_EDITED", "TASK_RESCHEDULED", "TASK_SNOOZED", "TASK_COMPLETED", "TASK_REOPENED", "TASK_CANCELED"]), ev1);
  const evAll = await events(bizA.id);
  ok("no journal payload carries free text (the title never enters the journal)", !JSON.stringify(evAll.map((e) => e.payload)).includes("הצעה"));
  ok("owner events name the acting user; none names another", evAll.filter((e) => e.actor === "OWNER_USER").every((e) => e.actorUserId === uA.id));

  // ── Series (6.2, 6.5) ────────────────────────────────────────────────────────────────────────
  console.log("series");
  const daily = await svc.createSeries(A, req(), { title: "לבדוק מלאי", rule: { kind: "DAILY" }, startOn: addCalendarDays(TODAY, -5) });
  const sid = daily.series!.id;
  ok("a series starts with exactly one open occurrence, due today", (await openCount(bizA.id, sid)) === 1 && daily.task?.dueOn?.toISOString().slice(0, 10) === TODAY);
  // Complete the first occurrence three days late → missed journaled (SYSTEM), next is tomorrow from then.
  const late = new Date(NOW.getTime() + 3 * 86_400_000);
  const k1 = daily.task!;
  const done1 = await svc.completeTask(A, req(key(late), late), k1.id, { expectedVersion: 1 });
  const missed = (await events(bizA.id, { eventType: "OCCURRENCES_MISSED", taskId: k1.id }))[0];
  ok("missed occurrences are journaled once, as SYSTEM, with their count", missed?.actor === "SYSTEM" && (missed.payload as { count: number }).count === 3, missed?.payload);
  const next1 = await owner.task.findUnique({ where: { id: done1.nextTaskId! } });
  ok("the next occurrence is the day after the late completion — no pile for the past", next1?.dueOn?.toISOString().slice(0, 10) === addCalendarDays(jerusalemDayKey(late), 1) && next1?.sequence === 2);
  ok("the next occurrence was created by the system", (await events(bizA.id, { taskId: next1!.id, eventType: "TASK_CREATED" }))[0]?.actor === "SYSTEM");
  // T-R1: reopen k while k+1 is untouched → k+1 withdrawn, k open.
  const ro = await svc.reopenTask(A, req(key(late), late), k1.id, { expectedVersion: 2 });
  const withdrawn = await owner.task.findUnique({ where: { id: next1!.id } });
  ok("T-R1: reopen withdraws the untouched next occurrence; one open occurrence (k)",
    ro.withdrawnTaskId === next1!.id && withdrawn?.closeReason === "WITHDRAWN_BY_REOPEN" && (await openCount(bizA.id, sid)) === 1 && ro.task?.status === "OPEN");
  // Close k again → a NEW occurrence with a new sequence (not k+1 recycled).
  const done2 = await svc.completeTask(A, req(key(late), late), k1.id, { expectedVersion: 3 });
  const next2 = await owner.task.findUnique({ where: { id: done2.nextTaskId! } });
  ok("closing k again creates a new occurrence with a new sequence", next2?.sequence === 3 && (await openCount(bizA.id, sid)) === 1);
  // T-R2: k+1 acted on (snoozed) → reopen of k refused, nothing changes.
  await svc.snoozeTask(A, req(key(late), late), next2!.id, { expectedVersion: 1, dueOn: addCalendarDays(jerusalemDayKey(late), 3) });
  ok("T-R2: reopen is refused when the next occurrence was acted on", (await code(svc.reopenTask(A, req(key(late), late), k1.id, { expectedVersion: 4 }))) === "NEXT_OCCURRENCE_IN_PROGRESS");
  ok("…and nothing changed (one open occurrence, k still DONE)", (await openCount(bizA.id, sid)) === 1 && (await owner.task.findUnique({ where: { id: k1.id } }))?.status === "DONE");
  // T-R3: two parallel completions of the same occurrence → one COMPLETED, one next.
  const n2 = await owner.task.findUnique({ where: { id: next2!.id } });
  const par = await Promise.all([1, 2].map(() => code(svc.completeTask(A, req(key(late), late), n2!.id, { expectedVersion: n2!.version }))));
  const completedEv = (await events(bizA.id, { taskId: n2!.id, eventType: "TASK_COMPLETED" })).length;
  ok("T-R3: two parallel completions → one COMPLETED event, one open occurrence", completedEv === 1 && (await openCount(bizA.id, sid)) === 1 && par.includes("OK"), par);
  // T-R4: completion and reopen in parallel → exactly one open occurrence, in any order.
  const open3 = await owner.task.findFirst({ where: { seriesId: sid, status: "OPEN" } });
  const prevDone = n2!;
  const prevV = (await owner.task.findUnique({ where: { id: prevDone.id } }))!.version;
  await Promise.all([
    code(svc.completeTask(A, req(key(late), late), open3!.id, { expectedVersion: open3!.version })),
    code(svc.reopenTask(A, req(key(late), late), prevDone.id, { expectedVersion: prevV })),
  ]);
  ok("T-R4: completion ∥ reopen → exactly one open occurrence", (await openCount(bizA.id, sid)) === 1);
  // T-R5 / T-R6: pause, then resume twice in parallel → one occurrence when none is open.
  const weekly = await svc.createSeries(A, req(), { title: "דוח שבועי", rule: { kind: "WEEKDAYS", weekdays: [4] } });
  const wid = weekly.series!.id;
  await svc.pauseSeries(A, req(), wid, { expectedVersion: 1 });
  await svc.cancelTask(A, req(), weekly.task!.id, { expectedVersion: 1 });
  ok("a paused series creates no next occurrence on close", (await openCount(bizA.id, wid)) === 0);
  const resumes = await Promise.all([1, 2].map(() => code(svc.resumeSeries(A, req(), wid, { expectedVersion: 2 }))));
  ok("T-R5/T-R6: two parallel resumes → exactly one new occurrence, one refused", (await openCount(bizA.id, wid)) === 1 && resumes.filter((r) => r === "OK").length === 1, resumes);
  const ws = await owner.taskSeries.findUnique({ where: { id: wid } });
  await svc.pauseSeries(A, req(), wid, { expectedVersion: ws!.version });
  const ws2 = await owner.taskSeries.findUnique({ where: { id: wid } });
  await svc.resumeSeries(A, req(), wid, { expectedVersion: ws2!.version });
  ok("T-R5: resume with an open occurrence creates none", (await openCount(bizA.id, wid)) === 1);
  // T-R7 / T-R8 / T-I1 / T-I2: replay and reuse.
  const openW = await owner.task.findFirst({ where: { seriesId: wid, status: "OPEN" } });
  const kk = key();
  const first = await svc.completeTask(A, req(kk), openW!.id, { expectedVersion: openW!.version });
  const again = await svc.completeTask(A, req(kk), openW!.id, { expectedVersion: openW!.version });
  ok("T-R7/T-I1: same key, same request → the first answer (same next occurrence), replayed, one write",
    again.replayed === true && again.nextTaskId === first.nextTaskId && (await events(bizA.id, { taskId: openW!.id, eventType: "TASK_COMPLETED" })).length === 1);
  ok("T-R8/T-I2: same key, different request → IDEMPOTENCY_KEY_REUSED", (await code(svc.completeTask(A, req(kk), openW!.id, { expectedVersion: openW!.version + 99 }))) === "IDEMPOTENCY_KEY_REUSED");
  // T-R9: rule change in parallel with a completion → one open occurrence, continuous history.
  const openW2 = await owner.task.findFirst({ where: { seriesId: wid, status: "OPEN" } });
  const ws3 = await owner.taskSeries.findUnique({ where: { id: wid } });
  await Promise.all([
    code(svc.changeSeries(A, req(), wid, { expectedVersion: ws3!.version, rule: { kind: "WEEKDAYS", weekdays: [0, 2] } })),
    code(svc.completeTask(A, req(), openW2!.id, { expectedVersion: openW2!.version })),
  ]);
  ok("T-R9: rule change ∥ completion → exactly one open occurrence", (await openCount(bizA.id, wid)) === 1);
  const seqs = (await owner.task.findMany({ where: { seriesId: wid }, select: { sequence: true }, orderBy: { sequence: "asc" } })).map((t) => t.sequence);
  ok("…and the sequence history has no gap or duplicate", seqs.every((s, i) => s === i + 1), seqs);

  // ── Repeated requests (12.9) ─────────────────────────────────────────────────────────────────
  console.log("repeated requests");
  const old = new Date(NOW.getTime() - 25 * 3600_000);
  ok("T-I3: a 25-hour-old key may not write (STALE)", (await code(svc.createTask(A, req(key(old)), { title: "x" }))) === "IDEMPOTENCY_KEY_STALE");
  // T-I5: the fingerprint is gone early (simulated) but the key is young → the journal answers.
  const k5 = key();
  const made = await svc.createTask(A, req(k5), { title: "journal answers" });
  await owner.taskRequestLedger.deleteMany({ where: { businessId: bizA.id, idempotencyKey: k5 } });
  const rep = await svc.createTask(A, req(k5), { title: "journal answers" });
  ok("T-I5: fingerprint gone, same request → the journal's answer (same task), no second write",
    rep.replayed && rep.task?.id === made.task?.id && (await owner.task.count({ where: { businessId: bizA.id, title: "journal answers" } })) === 1);
  ok("T-I5: fingerprint gone, different request → refused against the journal", (await code(svc.createTask(A, req(k5), { title: "something else" }))) === "IDEMPOTENCY_KEY_REUSED");
  // T-I4 / T-X5: a cleared digest refuses every reuse (owner-simulated clearing, as the retention path does).
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('dubiz.task_retention', 'on', true)`);
    await tx.$executeRawUnsafe(`UPDATE "TaskEvent" SET "requestDigest" = NULL, "digestKeyId" = NULL WHERE "businessId" = $1 AND "idempotencyKey" = $2`, bizA.id, k5);
  });
  ok("T-I4: digest cleared → even the identical request is refused, no double write", (await code(svc.createTask(A, req(k5), { title: "journal answers" }))) === "IDEMPOTENCY_KEY_REUSED"
    && (await owner.task.count({ where: { businessId: bizA.id, title: "journal answers" } })) === 1);
  // T-I6: two parallel first requests with the same key → one write, both get the same task.
  const k6 = key();
  const both = await Promise.all([1, 2].map(() => svc.createTask(A, req(k6), { title: "parallel first" }).then((r) => r.task?.id ?? -1).catch((e) => `ERR:${(e as Error).message}`)));
  ok("T-I6: parallel first requests → one task, the same answer to both, no error",
    both[0] === both[1] && typeof both[0] === "number" && (await owner.task.count({ where: { businessId: bizA.id, title: "parallel first" } })) === 1, both);

  // T-T5: a fingerprint row older than 7 days that the retention path has not removed yet counts as absent.
  const k7 = key();
  await owner.taskRequestLedger.create({
    data: { businessId: bizA.id, idempotencyKey: k7, requestDigest: "f".repeat(64), digestKeyId: "lab1", resultRef: { taskId: 999999 },
            createdAt: new Date(NOW.getTime() - (7 * 24 + 1) * 3600_000) },
  });
  const t5 = await svc.createTask(A, req(k7), { title: "stale fingerprint ignored" });
  ok("T-T5: a 7-day-and-1-hour fingerprint row is treated as absent (not a reuse, not a replay)",
    t5.replayed === false && t5.task?.title === "stale fingerprint ignored" && t5.task?.id !== 999999);

  // ── Erasure (12.6, T-P1) ─────────────────────────────────────────────────────────────────────
  console.log("erasure");
  const before = await owner.taskEvent.count({ where: { businessId: bizA.id } });
  const strip = (rows: Record<string, unknown>[]) => JSON.stringify(rows.map(({ actorUserId: _a, requestDigest: _d, digestKeyId: _k, ...rest }) => rest));
  const evRestBefore = strip(await owner.taskEvent.findMany({ where: { businessId: bizA.id }, orderBy: { id: "asc" } }));
  ok("before erasure the journal names the acting user and carries digests",
    (await owner.taskEvent.count({ where: { businessId: bizA.id, actorUserId: { not: null } } })) > 0
    && (await owner.taskEvent.count({ where: { businessId: bizA.id, requestDigest: { not: null } } })) > 0);
  // The erasure job runs after the quarantine stage (deletionRequestedAt), as in the real flow.
  await owner.business.update({ where: { id: bizA.id }, data: { deletionRequestedAt: new Date() } });
  await prismaAccountDeletionStore.purgeOperationalData(bizA.id);
  const tasks = await owner.task.findMany({ where: { businessId: bizA.id } });
  const series = await owner.taskSeries.findMany({ where: { businessId: bizA.id } });
  ok("T-P1: every task's title is blank, its note gone, erasedAt set — the rows stay",
    tasks.length > 0 && tasks.every((t) => t.title === "" && t.description === null && t.erasedAt !== null));
  ok("T-P1: every series' title is blank, its note gone, erasedAt set", series.length > 0 && series.every((s) => s.title === "" && s.note === null && s.erasedAt !== null));
  ok("T-P1: the request fingerprints are removed", (await owner.taskRequestLedger.count({ where: { businessId: bizA.id } })) === 0);
  ok("T-P1: every journal event lost its acting user and its request digest",
    (await owner.taskEvent.count({ where: { businessId: bizA.id, OR: [{ actorUserId: { not: null } }, { requestDigest: { not: null } }, { digestKeyId: { not: null } }] } })) === 0);
  ok("T-P1: …and nothing else in the journal changed (no row removed, every other column identical)",
    (await owner.taskEvent.count({ where: { businessId: bizA.id } })) === before
    && strip(await owner.taskEvent.findMany({ where: { businessId: bizA.id }, orderBy: { id: "asc" } })) === evRestBefore);

  ok("business B is untouched by A's erasure", (await owner.task.count({ where: { businessId: bizB.id, erasedAt: { not: null } } })) === 0);

  console.log(failed === 0 ? `\ntask service (runtime role): all ${checks} checks hold.` : `\n${failed} of ${checks} FAILED`);
}

main()
  .catch((e) => { failed += 1; console.error(e); })
  .finally(async () => {
    await Promise.all([owner.$disconnect(), prisma.$disconnect()]);
    process.exit(failed === 0 ? 0 : 1);
  });
