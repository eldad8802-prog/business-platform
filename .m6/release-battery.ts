/**
 * Leads L1.5-b · PR-5 — release throughput and resume under load. PostgreSQL with Production's RLS and a NOBYPASSRLS
 * runtime (same lab as the M6 battery); synthetic data only. Drives the REAL sweep (runIntakeSweep, store polling and
 * Rivhit off) and the REAL resume (setPaused).
 *
 *   A. budget + rotation: many businesses with ready work and a short budget → the run stops starting businesses at
 *      its deadline, and the rotation lets every business lead within a few runs (none always last)
 *   B. resume of 50,000 held receipts: the resume answers within its budget (no transaction grows with the backlog),
 *      a receipt under a live lease is NOT re-armed, whatever was not re-armed still comes due at the hold recheck
 *   C. release rounds: a resumed backlog gets more than one drain per run, with two sweeps racing → exactly once
 *   D. pause during release: nothing is processed while paused again; resumed → the rest exactly once
 *
 * Load is cloned from one real receipt per kind recorded through the REAL route (see held-fair-queue-battery.ts).
 * Unfinished receipts of other batteries' businesses are parked first (lab only) so timings measure this battery.
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { runIntakeSweep, MAX_RELEASE_ROUNDS } from "../lib/intake/intake-sweeper";
import { HEALTH_STAMP_BATCH, intakeHealthCounts, REARM_BUDGET_MS } from "../lib/intake/intake-event.store";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `rl-${Date.now()}`;
const MIN = 60_000;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const at = (ms = 0) => new Date(Date.now() + ms);

async function enable(businessId: number, featureKey: string) {
  await o.businessFeatureAccess.upsert({
    where: { businessId_featureKey: { businessId, featureKey } },
    create: { businessId, featureKey, state: "ENABLED" },
    update: { state: "ENABLED" },
  });
}
function web(publicId: string, key: string, body: Record<string, unknown>) {
  return webPOST(new NextRequest(`http://rl.local/api/intake/acquisition/web/${publicId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.11" },
    body: JSON.stringify(body),
  }), params({ publicId }));
}
async function clone(templateId: number, n: number, c: {
  tag: string; ref: string; status: "RECEIVED" | "FAILED"; attempts: number; next: Date | null; code: string | null; receivedAt: Date; lastAttemptAt?: Date | null;
}) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId",
        "providerAccountRef", "occurredAt", "receivedAt", "status", "attempts", "lastAttemptAt", "nextAttemptAt", "lastErrorCode",
        "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", t."sourceKey", t."family", t."eventType", t."dedupeBasis",
            'sha256:' || encode(sha256(convert_to($1 || ':' || g, 'UTF8')), 'hex'),
            $2, t."occurredAt", ($3::timestamptz AT TIME ZONE 'UTC') + (g * interval '1 millisecond'), $4::"IntakeEventStatus", $5::int,
            ($11::timestamptz AT TIME ZONE 'UTC'), ($6::timestamptz AT TIME ZONE 'UTC'), $7, t."payload",
            COALESCE(t."metadata", '{}'::jsonb) || jsonb_build_object('rlTag', $8::text), now(), now()
       FROM "IntakeEvent" t, generate_series(1, $9::int) g
      WHERE t."id" = $10`,
    `${RUN}:${c.tag}`, c.ref, c.receivedAt.toISOString(), c.status, c.attempts, c.next ? c.next.toISOString() : null, c.code, c.tag, n, templateId,
    c.lastAttemptAt ? c.lastAttemptAt.toISOString() : null
  );
}
/**
 * Lab only: a bulk insert leaves rows no reader has touched yet and the table unanalyzed — a state Production never
 * has (receipts arrive one by one and are read at once). Settle it the way a live table already is before measuring.
 */
async function settle() {
  await o.$executeRawUnsafe(`ANALYZE "IntakeEvent"`);
  await o.$queryRawUnsafe(`SELECT count(*) FROM "IntakeEvent"`);
}
const byTag = (businessId: number, tag: string) => ({ businessId, metadata: { path: ["rlTag"], equals: tag } });
const processedOf = (businessId: number, tag: string) => o.intakeEvent.count({ where: { ...byTag(businessId, tag), status: "PROCESSED" } });
const sweep = (now: Date, deadline?: number) =>
  runIntakeSweep({ now, reconcileCommerce: false, syncRevenueSources: false, ...(deadline ? { deadline } : {}) });

/** Lab only: whatever other batteries left unfinished waits a month, so it does not compete for this battery's budget. */
async function parkOthers(keep: number[]) {
  await o.$executeRawUnsafe(
    `UPDATE "IntakeEvent" SET "nextAttemptAt" = (now() AT TIME ZONE 'UTC') + interval '30 days'
      WHERE "status" IN ('RECEIVED', 'PERSISTED', 'FAILED') AND NOT ("businessId" = ANY($1::int[]))
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" < (now() AT TIME ZONE 'UTC') + interval '1 day')`,
    keep
  );
}

/** A business with one website endpoint and a real receipt to clone (recorded while paused, so never processed). */
async function setup(label: string) {
  const B = await o.business.create({ data: { name: `${RUN}-${label}` } });
  await enable(B.id, "acquisition_web_forms");
  const c = await runWithTenantContext({ businessId: B.id }, () => createKeyedConnection({ businessId: B.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  const pause = (on: boolean) => runWithTenantContext({ businessId: B.id }, () => setPaused(c.connection.id, on));
  await pause(true);
  await web(c.connection.publicId, c.key, { submission_id: `${RUN}-${label}-t`, name: "Release Load", phone: "054-700-0001" });
  const t = await o.intakeEvent.findFirstOrThrow({ where: { businessId: B.id } });
  await o.intakeEvent.update({ where: { id: t.id }, data: { status: "IGNORED", nextAttemptAt: null } }); // template only
  return { B, c, t, pause };
}

async function budgetAndRotation() {
  console.log("\n-- A. budget + rotation: 12 businesses with ready work, a short budget --");
  const biz: { id: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const s = await setup(`A${i}`);
    await s.pause(false);
    await clone(s.t.id, 60, { tag: "ready", ref: s.c.connection.publicId, status: "RECEIVED", attempts: 0, next: null, code: null, receivedAt: at() });
    biz.push({ id: s.B.id });
  }
  await parkOthers(biz.map((b) => b.id));
  await settle();
  const reachedAt: Record<number, number> = {};
  let notReachedFirst = 0;
  let runs = 0;
  const base = Math.floor(Date.now() / (10 * MIN)) * 10 * MIN;
  while (runs < 14 && Object.keys(reachedAt).length < biz.length) {
    runs++;
    const r = await sweep(new Date(base + runs * 10 * MIN + 1000), Date.now() + 2500);
    if (runs === 1) notReachedFirst = r.budget.businessesNotReached;
    for (const b of biz) if (!(b.id in reachedAt) && (await processedOf(b.id, "ready")) > 0) reachedAt[b.id] = runs;
  }
  ok(`A: a 2.5 s budget does not reach every business in one run (${notReachedFirst} left for later runs)`, notReachedFirst > 0, String(notReachedFirst));
  ok(`A: the rotation reaches all 12 businesses within ${runs} runs — none is always last`, Object.keys(reachedAt).length === biz.length, JSON.stringify(reachedAt));
  const leftover = await o.intakeEvent.count({ where: { businessId: { in: biz.map((b) => b.id) }, metadata: { path: ["rlTag"], equals: "ready" }, status: { not: "PROCESSED" } } });
  ok("A: nothing was lost or failed — every receipt is PROCESSED or still due (RECEIVED)",
    (await o.intakeEvent.count({ where: { businessId: { in: biz.map((b) => b.id) }, metadata: { path: ["rlTag"], equals: "ready" }, status: { notIn: ["PROCESSED", "RECEIVED"] } } })) === 0,
    String(leftover));
  await parkOthers([]);
}

async function resumeAndRelease() {
  console.log("\n-- B/C. resume 50,000 held receipts; release rounds with two racing sweeps --");
  const N = Number(process.env.RELEASE_LOAD ?? 50_000);
  const s = await setup("B");
  const t0 = new Date();
  // Held as a real look leaves them: claimed a while ago, waiting for the next recheck.
  await clone(s.t.id, N, { tag: "held", ref: s.c.connection.publicId, status: "RECEIVED", attempts: 0, next: new Date(t0.getTime() + 9 * MIN), code: "held:connection_paused", receivedAt: new Date(t0.getTime() - 2 * 24 * 60 * MIN), lastAttemptAt: new Date(t0.getTime() - MIN) });
  // One a worker holds RIGHT NOW (claimed at t0, lease = t0 + 2 min): the resume must not re-arm it.
  const leaseUntil = new Date(t0.getTime() + 2 * MIN);
  await clone(s.t.id, 1, { tag: "leased", ref: s.c.connection.publicId, status: "RECEIVED", attempts: 1, next: leaseUntil, code: "held:connection_paused", receivedAt: new Date(t0.getTime() - 60 * MIN), lastAttemptAt: t0 });
  await parkOthers([s.B.id]);
  await settle();

  const r0 = Date.now();
  const view = await s.pause(false);
  const resumeMs = Date.now() - r0;
  const conn = await o.acquisitionConnection.findUnique({ where: { id: s.c.connection.id } });
  const dueNow = await o.intakeEvent.count({ where: { ...byTag(s.B.id, "held"), nextAttemptAt: { lte: at(1000) } } });
  const lateMax = await o.intakeEvent.aggregate({ where: { ...byTag(s.B.id, "held") }, _max: { nextAttemptAt: true } });
  ok(`B: resuming ${N} held answers in ${resumeMs} ms (≤ re-arm budget ${REARM_BUDGET_MS} ms + margin); the connection is ACTIVE`,
    !!view && conn?.status === "ACTIVE" && resumeMs < REARM_BUDGET_MS + 7000, JSON.stringify({ resumeMs, status: conn?.status }));
  ok(`B: ${dueNow} of ${N} re-armed in batches; the rest still come due at their recheck (latest ${lateMax._max.nextAttemptAt?.toISOString()})`,
    dueNow > 0 && (!lateMax._max.nextAttemptAt || lateMax._max.nextAttemptAt.getTime() <= t0.getTime() + 9 * MIN + 1000));
  const leased = await o.intakeEvent.findFirstOrThrow({ where: byTag(s.B.id, "leased") });
  ok("B: the receipt a worker holds under its lease was NOT re-armed (a second worker cannot claim it)",
    leased.nextAttemptAt?.getTime() === leaseUntil.getTime() && leased.attempts === 1, JSON.stringify(leased.nextAttemptAt));
  console.log(`     timing: resume ${resumeMs} ms, re-armed ${dueNow}`);

  // C. two racing sweeps, each with its 40 s budget: more than one drain per run for this business.
  const c0 = Date.now();
  const [a, b] = await Promise.all([sweep(at()), sweep(at())]);
  const runMs = Date.now() - c0;
  const done1 = await processedOf(s.B.id, "held");
  ok(`C: one run released ${done1} (> one drain of 50) through ${a.budget.releaseRounds + b.budget.releaseRounds} release rounds, within the budget`,
    done1 > 50 && runMs < 60_000, JSON.stringify({ done1, runMs, ra: a.budget, rb: b.budget }));
  ok(`C: per run, never more than 50 × (1 + ${MAX_RELEASE_ROUNDS}) per sweep for one business`, done1 <= 2 * 50 * (1 + MAX_RELEASE_ROUNDS));
  const rows = await o.intakeEvent.findMany({ where: { ...byTag(s.B.id, "held"), status: "PROCESSED" }, select: { attempts: true } });
  const leads = await o.lead.count({ where: { businessId: s.B.id, sourceChannel: "intake:web.form" } });
  ok(`C: exactly once under the race — every released receipt PROCESSED with 1 attempt, ${leads} Leads = ${rows.length + (leased ? 0 : 0)} receipts`,
    rows.every((e) => e.attempts === 1) && leads === (await o.intakeEvent.count({ where: { businessId: s.B.id, sourceKey: "web.form", status: "PROCESSED" } })));
  console.log(`     timing: release run ${runMs} ms → ${done1} released (${(done1 / (runMs / 1000)).toFixed(1)}/s)`);
  // The health read over a 50,000-receipt stale backlog stays inside its transaction (bounded stamping) — before
  // PR-5 it stamped every stale receipt in one statement, timed out, rolled back, and failed again every run.
  const h0 = Date.now();
  const h = await runWithTenantContext({ businessId: s.B.id }, () => intakeHealthCounts(s.B.id, at()));
  ok(`C: the health read over a ${N}-receipt stale backlog succeeds in ${Date.now() - h0} ms, reporting at most ${HEALTH_STAMP_BATCH} new per run (${h.pendingStaleNew}), counting all (${h.pendingStale})`,
    h.pendingStaleNew <= HEALTH_STAMP_BATCH && h.pendingStale >= N - done1 - 1);
  await parkOthers([]);
}

async function pauseDuringRelease() {
  console.log("\n-- D. pause during release, then resume --");
  const s = await setup("D");
  await clone(s.t.id, 600, { tag: "held", ref: s.c.connection.publicId, status: "RECEIVED", attempts: 0, next: at(-MIN), code: "held:connection_paused", receivedAt: at(-24 * 60 * MIN) });
  await parkOthers([s.B.id]);
  await settle();
  await s.pause(false);
  await sweep(at(), Date.now() + 5000);
  const before = await processedOf(s.B.id, "held");
  await s.pause(true);
  await Promise.all([sweep(at(1000)), sweep(at(1000))]);
  await sweep(at(11 * MIN));
  const whilePaused = await processedOf(s.B.id, "held");
  const rest = await o.intakeEvent.findMany({ where: { ...byTag(s.B.id, "held"), status: "RECEIVED" }, select: { lastErrorCode: true, attempts: true } });
  ok(`D: paused again after ${before} released → nothing more is processed while paused (still ${whilePaused})`, whilePaused === before && before > 0, JSON.stringify({ before, whilePaused }));
  ok("D: …the rest wait held again (held:connection_paused), no attempt spent", rest.length === 600 - before && rest.every((e) => e.lastErrorCode === "held:connection_paused" && e.attempts === 0));
  await s.pause(false);
  for (let i = 0; i < 6 && (await processedOf(s.B.id, "held")) < 600; i++) await Promise.all([sweep(at(12 * MIN + i * 1000)), sweep(at(12 * MIN + i * 1000))]);
  const all = await o.intakeEvent.findMany({ where: { ...byTag(s.B.id, "held") }, select: { status: true, attempts: true } });
  ok("D: resumed → all 600 PROCESSED exactly once (one attempt each), one Lead each",
    all.every((e) => e.status === "PROCESSED" && e.attempts === 1) && (await o.lead.count({ where: { businessId: s.B.id, sourceChannel: "intake:web.form" } })) === 600);
  await parkOthers([]);
}

async function main() {
  await budgetAndRotation();
  await resumeAndRelease();
  await pauseDuringRelease();
  console.log(`\nL1.5-b release battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
