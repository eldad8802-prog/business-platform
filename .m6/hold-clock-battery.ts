/**
 * Leads L1.5-b · A2 — the hold clock on PostgreSQL with Production's RLS and a NOBYPASSRLS runtime (same lab as the
 * M6 battery); synthetic data only. Real receipts, the real processor, explicit `now`s; long spans are reached by
 * seeding a clock state, never by backdating arrival.
 *
 *   - OFF: the existing hold path, nothing written
 *   - ON: counted time accumulates look by look; a look counts at most the max gap; never backdated
 *   - a change of reason never resets; the emergency hold never counts or expires; ≥ 48 h grace after it
 *   - the warning is written at day 12; no expiry without it, nor within 48 h of it; expiry = A1 "expired", payload kept
 *   - siblings: clocks advance in bulk; the ones due to expire are settled by their own look; release still works
 *   - racing sweeps count a span once; a replayed delivery adds nothing; resume keeps the clock
 *   - RLS: another business's tenant moves no clock; load: a 3,000-receipt hold advances in bounded batches
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { runTenantJob } from "../lib/tenant/job";
import { createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { deferHeldSiblingsWithClock, markDeferredWithClock, purgeExpiredFailedPayloads, rearmPausedReceipts } from "../lib/intake/intake-event.store";
import { drainIntake } from "../lib/intake/core/processor";
import { intakeRegistry } from "../lib/intake/sources";
import { IntakeRegistry } from "../lib/intake/core/registry";
import { runIntakeSweep, sweepHealth } from "../lib/intake/intake-sweeper";
import { HOLD_CLOCK_MAX_GAP_MS, HOLD_EXPIRY_MS, HOLD_GRACE_MS, HOLD_WARN_MS, type HoldClock } from "../lib/intake/core/hold-clock";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `hc-${Date.now()}`;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const T = Date.now();
const at = (ms: number) => new Date(T + ms);
const ON = () => { process.env.INTAKE_HOLD_CLOCK_ENABLED = "true"; };
const OFF = () => { delete process.env.INTAKE_HOLD_CLOCK_ENABLED; };
const FEATURE = "acquisition_web_forms";
let seq = 0;

type Lab = { B: number; conn: { id: number; publicId: string }; key: string; t: number; ref: string };

async function deliver(lab: Lab, sub: string) {
  return webPOST(new NextRequest(`http://hc.local/api/intake/acquisition/web/${lab.conn.publicId}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${lab.key}`, "x-forwarded-for": "203.0.113.77" },
    body: JSON.stringify({ submission_id: sub, name: "Hold Clock", phone: `054-600-${String(7000 + (seq++ % 999)).padStart(4, "0")}` }),
  }), { params: Promise.resolve({ publicId: lab.conn.publicId }) });
}

/** A business with a web-form connection; `paused` → its first delivery is held as connection_paused. */
async function lab(label: string, paused = true): Promise<Lab> {
  const b = await o.business.create({ data: { name: `${RUN}-${label}` } });
  await o.businessFeatureAccess.create({ data: { businessId: b.id, featureKey: FEATURE, state: "ENABLED" } });
  const w = await runWithTenantContext({ businessId: b.id }, () => createKeyedConnection({ businessId: b.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  if (paused) await runWithTenantContext({ businessId: b.id }, () => setPaused(w.connection.id, true));
  const L: Lab = { B: b.id, conn: { id: w.connection.id, publicId: w.connection.publicId }, key: w.key, t: 0, ref: "" };
  await deliver(L, `${RUN}-${label}-t`);
  const first = await o.intakeEvent.findFirstOrThrow({ where: { businessId: b.id }, orderBy: { id: "asc" } });
  L.t = first.id;
  L.ref = first.providerAccountRef ?? "";
  return L;
}

async function row(id: number) {
  const r = await o.intakeEvent.findUniqueOrThrow({ where: { id } });
  const m = (r.metadata ?? {}) as Record<string, unknown>;
  return { ...r, clock: (m.holdClock ?? null) as HoldClock | null };
}
/** Put a receipt in a given clock state, due now (a state long looks would have produced). */
async function seedClock(id: number, clock: Partial<HoldClock> | null, due: Date) {
  await o.$executeRawUnsafe(
    `UPDATE "IntakeEvent" SET "metadata" = CASE WHEN $1::jsonb IS NULL THEN COALESCE("metadata", '{}'::jsonb) - 'holdClock'
                                                ELSE COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('holdClock', $1::jsonb) END,
                              "nextAttemptAt" = ($2::timestamptz AT TIME ZONE 'UTC') WHERE "id" = $3`,
    clock ? JSON.stringify({ v: 1, ms: 0, code: "held:connection_paused", grace: null, warnedAt: null, ...clock }) : null, due.toISOString(), id
  );
}
async function clone(templateId: number, n: number, tag: string, clock: Partial<HoldClock> | null, due: Date) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId", "providerAccountRef",
        "receivedAt", "status", "attempts", "nextAttemptAt", "lastAttemptAt", "lastErrorCode", "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", t."sourceKey", t."family", t."eventType", t."dedupeBasis", 'sha256:' || encode(sha256(convert_to($1 || ':' || g, 'UTF8')), 'hex'),
            t."providerAccountRef", t."receivedAt", 'RECEIVED', 0, ($2::timestamptz AT TIME ZONE 'UTC'), NULL, t."lastErrorCode", t."payload",
            CASE WHEN $3::jsonb IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('holdClock', $3::jsonb) END, now(), now()
       FROM "IntakeEvent" t, generate_series(1, $4::int) g WHERE t."id" = $5`,
    `${RUN}:${tag}`, due.toISOString(), clock ? JSON.stringify({ v: 1, ms: 0, code: "held:connection_paused", grace: null, warnedAt: null, ...clock }) : null, n, templateId
  );
}
const drain = (L: Lab, now: Date, limit = 50) => runTenantJob({ businessId: L.B }, () => drainIntake(intakeRegistry, L.B, { now, limit }));
const ms = (c: HoldClock | null) => Number(c?.ms ?? -1);
const lookAt = (c: HoldClock | null) => (c?.at ? new Date(c.at).getTime() : NaN);

async function main() {
  console.log("\n-- OFF: the existing hold path, nothing written --");
  OFF();
  const off = await lab("off");
  await drain(off, at(11 * MIN));
  const r0 = await row(off.t);
  ok("OFF: held as before (code, deferred), no clock written", r0.lastErrorCode === "held:connection_paused" && r0.clock === null && r0.status === "RECEIVED" && r0.attempts === 0, JSON.stringify({ c: r0.lastErrorCode, clock: r0.clock, s: r0.status, a: r0.attempts }));

  ON();
  console.log("\n-- ON: accumulation, max gap, never backdated --");
  const acc = await lab("acc");
  const a0 = await row(acc.t);
  ok("the clock starts at the first look, at 0 (never from arrival)", !!a0.clock && ms(a0.clock) === 0 && a0.clock.code === "held:connection_paused" && a0.attempts === 0, JSON.stringify(a0.clock));
  const first = lookAt(a0.clock);
  for (const k of [1, 2, 3]) await drain(acc, new Date(first + k * 10 * MIN + k * 1000));
  const a1 = await row(acc.t);
  ok("three looks 10 min apart count exactly the time between them", ms(a1.clock) === lookAt(a1.clock) - first, JSON.stringify({ ms: ms(a1.clock), span: lookAt(a1.clock) - first }));
  const before = ms(a1.clock);
  await drain(acc, new Date(lookAt(a1.clock) + 5 * HOUR));
  const a2 = await row(acc.t);
  ok(`a 5 h gap counts at most the max gap (${HOLD_CLOCK_MAX_GAP_MS / HOUR} h)`, ms(a2.clock) - before === HOLD_CLOCK_MAX_GAP_MS, String(ms(a2.clock) - before));
  ok("attempts are never spent by a hold", a2.attempts === 0, String(a2.attempts));

  console.log("\n-- a change of reason never resets --");
  const rc = await lab("reason");
  // the source is withdrawn and the connection resumed → held:source_disabled (counting)
  await o.businessFeatureAccess.update({ where: { businessId_featureKey: { businessId: rc.B, featureKey: FEATURE } }, data: { state: "DISABLED", reason: "block:test" } });
  await runWithTenantContext({ businessId: rc.B }, () => setPaused(rc.conn.id, false));
  await seedClock(rc.t, { ms: 3 * DAY, at: at(0).toISOString(), code: "held:connection_paused" }, at(10 * MIN));
  await drain(rc, at(10 * MIN));
  const c1 = await row(rc.t);
  ok("paused → withdrawn: the count continues (3 d + 10 min), reason recorded", c1.lastErrorCode === "held:source_disabled" && ms(c1.clock) === 3 * DAY + 10 * MIN && c1.clock?.code === "held:source_disabled", JSON.stringify(c1.clock));
  await runWithTenantContext({ businessId: rc.B }, () => setPaused(rc.conn.id, true));
  await drain(rc, at(20 * MIN + 1000));
  const c2 = await row(rc.t);
  ok("withdrawn → paused: still continuing, never back to 0", c2.lastErrorCode === "held:connection_paused" && ms(c2.clock) === 3 * DAY + 20 * MIN + 1000, JSON.stringify(c2.clock));

  console.log("\n-- the Dubiz emergency hold: never counted, never expires, ≥ 48 h grace after --");
  const em = await lab("emergency");
  const saved = await o.platformFeaturePolicy.findUnique({ where: { featureKey: FEATURE } });
  try {
    await o.platformFeaturePolicy.upsert({ where: { featureKey: FEATURE }, create: { featureKey: FEATURE, globalEnabled: false, emergencyDisabled: true }, update: { emergencyDisabled: true } });
    await runWithTenantContext({ businessId: em.B }, () => setPaused(em.conn.id, false));
    await seedClock(em.t, { ms: 5 * DAY, at: at(0).toISOString(), code: "held:connection_paused" }, at(10 * MIN));
    await drain(em, at(10 * MIN));
    await drain(em, at(20 * MIN + 1000));
    const e1 = await row(em.t);
    ok("under the emergency switch: held as emergency, nothing counted (the switching look included)", e1.lastErrorCode === "held:emergency_disabled" && ms(e1.clock) === 5 * DAY, JSON.stringify(e1.clock));
    await seedClock(em.t, { ...e1.clock!, ms: 40 * DAY, warnedAt: at(-20 * DAY).toISOString() }, at(30 * MIN + 2000));
    await drain(em, at(30 * MIN + 2000));
    const e2 = await row(em.t);
    ok("an emergency hold never expires (even 40 d counted, warned 20 d ago)", e2.status === "RECEIVED" && e2.lastErrorCode === "held:emergency_disabled", JSON.stringify({ s: e2.status, c: e2.lastErrorCode }));
    await seedClock(em.t, { ...e2.clock!, ms: 5 * DAY, warnedAt: null }, at(40 * MIN + 3000));
    // the emergency ends; the source is still withdrawn for this business → a counting hold resumes
    await o.platformFeaturePolicy.update({ where: { featureKey: FEATURE }, data: { emergencyDisabled: false } });
    await o.businessFeatureAccess.update({ where: { businessId_featureKey: { businessId: em.B, featureKey: FEATURE } }, data: { state: "DISABLED", reason: "block:test" } });
    const endLook = at(40 * MIN + 3000);
    await drain(em, endLook);
    const e3 = await row(em.t);
    const grace = e3.clock?.grace ? new Date(e3.clock.grace).getTime() : 0;
    ok("first look after it: nothing counted, a grace of ≥ 48 h opens", ms(e3.clock) === 5 * DAY && grace - endLook.getTime() >= HOLD_GRACE_MS && grace - endLook.getTime() >= 48 * HOUR, JSON.stringify(e3.clock));
    await drain(em, new Date(endLook.getTime() + 10 * MIN + 1000));
    const e4 = await row(em.t);
    ok("inside the grace: nothing counted", ms(e4.clock) === 5 * DAY, JSON.stringify(e4.clock));
    // continuous looks up to 10 min before the grace ends, then one 20 min after it
    await seedClock(em.t, { ...e4.clock!, at: new Date(grace - 10 * MIN).toISOString() }, new Date(grace + 20 * MIN));
    await drain(em, new Date(grace + 20 * MIN));
    const e5 = await row(em.t);
    ok("past the grace: counting resumes from where it stood (5 d + 20 min), the grace deadline kept", ms(e5.clock) === 5 * DAY + 20 * MIN && e5.clock?.grace === e4.clock?.grace, JSON.stringify(e5.clock));
  } finally {
    if (saved) await o.platformFeaturePolicy.update({ where: { featureKey: FEATURE }, data: { emergencyDisabled: saved.emergencyDisabled, globalEnabled: saved.globalEnabled } });
    else await o.platformFeaturePolicy.deleteMany({ where: { featureKey: FEATURE } });
  }

  console.log("\n-- the warning, its lead, the expiry --");
  const wn = await lab("warn");
  await seedClock(wn.t, { ms: HOLD_WARN_MS - 5 * MIN, at: at(0).toISOString() }, at(10 * MIN));
  await drain(wn, at(10 * MIN));
  const w1 = await row(wn.t);
  ok("day 12 reached → the warning is written at that look, nothing expires", w1.clock?.warnedAt !== null && new Date(w1.clock!.warnedAt!).getTime() === at(10 * MIN).getTime() && w1.status === "RECEIVED", JSON.stringify(w1.clock));
  await seedClock(wn.t, { ...w1.clock!, ms: 20 * DAY, warnedAt: null, at: at(10 * MIN).toISOString() }, at(20 * MIN));
  await drain(wn, at(20 * MIN));
  const w2 = await row(wn.t);
  ok("20 d counted but never warned → warned now, NOT expired", w2.status === "RECEIVED" && w2.lastErrorCode === "held:connection_paused" && w2.clock?.warnedAt !== null, JSON.stringify({ s: w2.status, clock: w2.clock }));
  await seedClock(wn.t, { ...w2.clock!, ms: HOLD_EXPIRY_MS + HOUR, warnedAt: at(30 * MIN - 47 * HOUR).toISOString(), at: at(20 * MIN).toISOString() }, at(30 * MIN));
  await drain(wn, at(30 * MIN));
  const w3 = await row(wn.t);
  ok("past 14 d but warned only 47 h ago → NOT expired", w3.status === "RECEIVED" && w3.lastErrorCode === "held:connection_paused", JSON.stringify({ s: w3.status, c: w3.lastErrorCode }));
  await seedClock(wn.t, { ...w3.clock!, ms: HOLD_EXPIRY_MS - 5 * MIN, warnedAt: at(40 * MIN - 49 * HOUR).toISOString(), at: at(30 * MIN).toISOString() }, at(40 * MIN));
  const tally = await drain(wn, at(40 * MIN));
  const w4 = await row(wn.t);
  ok("14 d reached at this look and warned 49 h ago → expired (A1): FAILED, no next attempt, payload kept", w4.status === "FAILED" && w4.nextAttemptAt === null && w4.lastErrorCode === "expired:connection_paused" && w4.payload !== null && w4.payloadPurgedAt === null, JSON.stringify({ s: w4.status, c: w4.lastErrorCode, p: w4.payload !== null }));
  ok("…tallied \"expired\", never \"failed\"", tally.expired === 1 && tally.failed === 0, JSON.stringify(tally));
  const purged = await runTenantJob({ businessId: wn.B }, () => purgeExpiredFailedPayloads(wn.B, at(60 * DAY)));
  const w5 = await row(wn.t);
  ok("…and the dead-letter retention never deletes it (60 d later)", purged === 0 && w5.payload !== null, String(purged));
  const only = new IntakeRegistry();
  only.register({ ...intakeRegistry.list().find((a) => a.sourceKey === "web.form")!, listTenants: async () => [wn.B] });
  const sweep = await runIntakeSweep({ now: at(41 * MIN), reconcileCommerce: false, syncRevenueSources: false, registry: only });
  ok("the sweep stays healthy (no failed receipt, no new dead letter)", sweep.events.failed === 0 && sweep.backlog.deadLettersNew === 0 && !sweepHealth(sweep).events.includes("failed_receipts"), JSON.stringify(sweepHealth(sweep)));

  console.log("\n-- siblings: bulk clocks, the expiring ones settled by their own look, release --");
  const sb = await lab("siblings");
  await seedClock(sb.t, { ms: 1 * DAY, at: at(0).toISOString() }, at(10 * MIN));
  await clone(sb.t, 40, "fresh", { ms: 1 * DAY, at: at(0).toISOString() }, at(10 * MIN));
  await clone(sb.t, 10, "due", { ms: HOLD_EXPIRY_MS, warnedAt: at(-3 * DAY).toISOString(), at: at(0).toISOString() }, at(10 * MIN));
  const st = await drain(sb, at(10 * MIN), 60);
  const sib = await o.$queryRawUnsafe<{ s: string; c: string; n: number; ms: string }[]>(
    `SELECT "status"::text AS s, "lastErrorCode" AS c, count(*)::int AS n, min(("metadata"->'holdClock'->>'ms')) || '..' || max(("metadata"->'holdClock'->>'ms')) AS ms
       FROM "IntakeEvent" WHERE "businessId" = $1 GROUP BY 1, 2 ORDER BY 1`, sb.B);
  const held = sib.find((x) => x.c === "held:connection_paused");
  const expired = sib.find((x) => x.c === "expired:connection_paused");
  ok("41 waiting receipts each counted the 10 min once", held?.n === 41 && held.ms === `${DAY + 10 * MIN}..${DAY + 10 * MIN}`, JSON.stringify(sib));
  ok("the 10 due to expire were settled each by its own look (expired, payload kept)", expired?.n === 10 && st.expired === 10 && st.failed === 0, JSON.stringify({ sib, st }));
  await runWithTenantContext({ businessId: sb.B }, () => setPaused(sb.conn.id, false)); // re-arms the paused receipts
  await drain(sb, at(12 * MIN), 100);
  const rel = await o.intakeEvent.groupBy({ by: ["status"], where: { businessId: sb.B }, _count: true });
  ok("resume: the 41 are processed normally (a hold lifted before expiry loses nothing)", rel.find((g) => g.status === "PROCESSED")?._count === 41, JSON.stringify(rel));

  console.log("\n-- racing sweeps, replayed delivery, resume keeps the clock --");
  const rs = await lab("race");
  await seedClock(rs.t, { ms: DAY, at: at(0).toISOString() }, at(10 * MIN));
  await clone(rs.t, 199, "race", { ms: DAY, at: at(0).toISOString() }, at(10 * MIN));
  await Promise.all([drain(rs, at(10 * MIN), 25), drain(rs, at(10 * MIN), 25), drain(rs, at(10 * MIN), 25)]);
  const race = await o.$queryRawUnsafe<{ n: number; lo: string; hi: string }[]>(
    `SELECT count(*)::int AS n, min(("metadata"->'holdClock'->>'ms')) AS lo, max(("metadata"->'holdClock'->>'ms')) AS hi
       FROM "IntakeEvent" WHERE "businessId" = $1 AND "lastErrorCode" = 'held:connection_paused'`, rs.B);
  ok("three racing drains: all 200 still held, each counted the span exactly once", race[0].n === 200 && race[0].lo === String(DAY + 10 * MIN) && race[0].hi === String(DAY + 10 * MIN), JSON.stringify(race));
  const beforeReplay = await row(rs.t);
  const replay = await deliver(rs, `${RUN}-race-t`);
  const afterReplay = await row(rs.t);
  const n = await o.intakeEvent.count({ where: { businessId: rs.B } });
  ok("a replayed delivery records nothing new and moves no clock", replay.status < 300 && n === 200 && JSON.stringify(afterReplay.clock) === JSON.stringify(beforeReplay.clock), JSON.stringify({ st: replay.status, n }));
  await runWithTenantContext({ businessId: rs.B }, () => rearmPausedReceipts("web.form", rs.ref, at(11 * MIN)));
  const afterRearm = await row(rs.t);
  ok("re-arming on resume keeps the clock", JSON.stringify(afterRearm.clock) === JSON.stringify(beforeReplay.clock), JSON.stringify(afterRearm.clock));

  console.log("\n-- RLS --");
  const victim = await lab("victim");
  const Y = await o.business.create({ data: { name: `${RUN}-y` } });
  await seedClock(victim.t, { ms: HOLD_EXPIRY_MS, warnedAt: at(-3 * DAY).toISOString(), at: at(0).toISOString() }, at(10 * MIN));
  const vBefore = await row(victim.t);
  const look = await runTenantJob({ businessId: Y.id }, () => markDeferredWithClock(victim.B, { id: victim.t }, at(20 * MIN), "held:connection_paused", at(10 * MIN)))
    .catch(() => ({ expire: false, warned: false }));
  const sibs = await runTenantJob({ businessId: Y.id }, () => deferHeldSiblingsWithClock(victim.B, { id: -1, sourceKey: "web.form", providerAccountRef: vBefore.providerAccountRef }, at(20 * MIN), "held:connection_paused", at(10 * MIN)))
    .catch(() => ({ count: 0, warned: 0 }));
  const vAfter = await row(victim.t);
  ok("business Y's tenant moves no clock of B and expires nothing", !look.expire && sibs.count === 0 && JSON.stringify(vAfter.clock) === JSON.stringify(vBefore.clock) && vAfter.status === "RECEIVED", JSON.stringify({ look, sibs }));

  console.log("\n-- load: one 3,000-receipt hold --");
  const ld = await lab("load");
  await seedClock(ld.t, { ms: DAY, at: at(0).toISOString() }, at(10 * MIN));
  await clone(ld.t, 2999, "load", { ms: DAY, at: at(0).toISOString() }, at(10 * MIN));
  const t0 = Date.now();
  const lt = emptyT();
  for (let i = 0; i < 3; i++) { const d = await drain(ld, at(10 * MIN), 1); lt.deferred += d.deferred; lt.failed += d.failed; }
  const took = Date.now() - t0;
  const adv = await o.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "IntakeEvent" WHERE "businessId" = $1 AND ("metadata"->'holdClock'->>'ms')::bigint = $2`, ld.B, DAY + 10 * MIN);
  ok(`three looks advance 3,000 clocks in bounded batches of ≤ 1,000 (${took} ms)`, adv[0].n === 3000 && lt.deferred === 3 && took < 20000, JSON.stringify({ adv: adv[0].n, lt, took }));

  OFF();
  console.log(`\nL1.5-b hold-clock battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

function emptyT() { return { deferred: 0, failed: 0 }; }

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
