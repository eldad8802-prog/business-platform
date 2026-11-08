/**
 * Leads L1.5-b · PR-2 — capacity metrics on PostgreSQL with Production's RLS and a NOBYPASSRLS runtime (same lab as
 * the M6 battery); synthetic data only.
 *
 *   - exact counts per connection and class (held by reason / due / retrying / replayable dead letters), finished and
 *     purged receipts never counted, the oldest held arrival
 *   - the scan cap (counts become lower bounds, flagged) and timings at 50 / 500 / 2,000 / 20,000 / 50,000 held
 *   - flow: received last hour / day, processed last hour, recovered (processed > 10 min after arrival)
 *   - the sweep's capacity report; with alerts OFF no new red reason; with INTAKE_CAPACITY_ALERTS_ENABLED=true each
 *     tier crossing is reported once (a second run reports none)
 *   - RLS: another business's tenant reads nothing
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runWithTenantContext } from "../lib/tenant/context";
import { createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { BACKLOG_SCAN_CAP, intakeBacklog, intakeFlow } from "../lib/intake/intake-event.store";
import { runIntakeSweep, sweepHealth } from "../lib/intake/intake-sweeper";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";

const RUN = `cap-${Date.now()}`;
const MIN = 60_000;
const LOADS = (process.env.CAPACITY_LOADS ?? "50,500,2000,20000,50000").split(",").map(Number).filter((n) => n > 0);
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
  return webPOST(new NextRequest(`http://cap.local/api/intake/acquisition/web/${publicId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.21" },
    body: JSON.stringify(body),
  }), params({ publicId }));
}
type CloneSpec = {
  tag: string; ref: string; status: "RECEIVED" | "FAILED" | "PROCESSED"; next: Date | null; code: string | null; receivedAt: Date;
  processedAt?: Date | null; purged?: boolean;
};
async function clone(templateId: number, n: number, c: CloneSpec) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId",
        "providerAccountRef", "occurredAt", "receivedAt", "status", "attempts", "nextAttemptAt", "lastErrorCode", "processedAt",
        "payload", "payloadPurgedAt", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", t."sourceKey", t."family", t."eventType", t."dedupeBasis",
            'sha256:' || encode(sha256(convert_to($1 || ':' || g, 'UTF8')), 'hex'),
            $2, t."occurredAt", ($3::timestamptz AT TIME ZONE 'UTC') + (g * interval '1 millisecond'), $4::"IntakeEventStatus", 0,
            ($5::timestamptz AT TIME ZONE 'UTC'), $6, ($7::timestamptz AT TIME ZONE 'UTC'),
            CASE WHEN $8::boolean THEN NULL ELSE t."payload" END, CASE WHEN $8::boolean THEN now() END,
            COALESCE(t."metadata", '{}'::jsonb) || jsonb_build_object('capTag', $9::text), now(), now()
       FROM "IntakeEvent" t, generate_series(1, $10::int) g
      WHERE t."id" = $11`,
    `${RUN}:${c.tag}`, c.ref, c.receivedAt.toISOString(), c.status, c.next ? c.next.toISOString() : null, c.code,
    c.processedAt ? c.processedAt.toISOString() : null, !!c.purged, c.tag, n, templateId
  );
}
async function settle() {
  await o.$executeRawUnsafe(`ANALYZE "IntakeEvent"`);
  await o.$queryRawUnsafe(`SELECT count(*) FROM "IntakeEvent"`);
}

/** One business: N held on a paused web endpoint + a fixed mix of every other class on a second, active endpoint. */
async function business(N: number) {
  const B = await o.business.create({ data: { name: `${RUN}-K${N}` } });
  await enable(B.id, "acquisition_web_forms");
  const mk = () => runWithTenantContext({ businessId: B.id }, () => createKeyedConnection({ businessId: B.id, userId: null, sourceKey: "web.form", allowedOrigins: [] }));
  const paused = await mk();
  const active = await mk();
  for (const c of [paused, active]) await runWithTenantContext({ businessId: B.id }, () => setPaused(c.connection.id, true));
  await web(paused.connection.publicId, paused.key, { submission_id: `${RUN}-${N}-t`, name: "Capacity", phone: "054-800-0001" });
  await runWithTenantContext({ businessId: B.id }, () => setPaused(active.connection.id, false));
  const t = await o.intakeEvent.findFirstOrThrow({ where: { businessId: B.id } });
  await o.intakeEvent.update({ where: { id: t.id }, data: { status: "IGNORED", nextAttemptAt: null } });
  const t0 = new Date();
  const oldestHeld = new Date(t0.getTime() - 5 * 24 * 60 * MIN);
  await clone(t.id, N, { tag: "held-paused", ref: paused.connection.publicId, status: "RECEIVED", next: at(9 * MIN), code: "held:connection_paused", receivedAt: oldestHeld });
  await clone(t.id, 10, { tag: "held-emergency", ref: active.connection.publicId, status: "RECEIVED", next: at(9 * MIN), code: "held:emergency_disabled", receivedAt: at(-60 * MIN) });
  await clone(t.id, 7, { tag: "due", ref: active.connection.publicId, status: "RECEIVED", next: null, code: null, receivedAt: at(-5 * MIN) });
  await clone(t.id, 5, { tag: "retrying", ref: active.connection.publicId, status: "FAILED", next: at(30 * MIN), code: "error:Error", receivedAt: at(-50 * MIN) });
  await clone(t.id, 3, { tag: "dead", ref: active.connection.publicId, status: "FAILED", next: null, code: "error:Error", receivedAt: at(-2 * 24 * 60 * MIN) });
  await clone(t.id, 2, { tag: "dead-purged", ref: active.connection.publicId, status: "FAILED", next: null, code: "error:Error", receivedAt: at(-40 * 24 * 60 * MIN), purged: true });
  await clone(t.id, 3, { tag: "recovered", ref: active.connection.publicId, status: "PROCESSED", next: null, code: null, receivedAt: at(-3 * 60 * MIN), processedAt: at(-20 * MIN) });
  await clone(t.id, 2, { tag: "on-time", ref: active.connection.publicId, status: "PROCESSED", next: null, code: null, receivedAt: at(-30 * MIN), processedAt: at(-29 * MIN) });
  return { B, paused, active, oldestHeld, templateId: t.id };
}

async function main() {
  console.log("\n-- capacity per business at each load --");
  const made: { N: number; id: number; templateId: number; ref: string }[] = [];
  for (const N of LOADS) {
    const k = await business(N);
    await settle();
    const s = Date.now();
    const b = await runWithTenantContext({ businessId: k.B.id }, () => intakeBacklog(k.B.id, at()));
    const ms = Date.now() - s;
    const p = b.connections.find((c) => c.providerAccountRef === k.paused.connection.publicId);
    const a = b.connections.find((c) => c.providerAccountRef === k.active.connection.publicId);
    if (N + 27 <= BACKLOG_SCAN_CAP) {
      ok(`load ${N}: exact — paused endpoint ${N} held (connection_paused); active endpoint 10 held (emergency_disabled) + 7 due + 5 retrying + 3 replayable dead letters; finished and purged not counted`,
        !b.capped && p?.held === N && p.heldByReason.connection_paused === N && a?.held === 10 && a.heldByReason.emergency_disabled === 10
          && a.due === 7 && a.retrying === 5 && a.deadLetters === 3 && b.totals.held === N + 10 && b.totals.deadLetters === 3,
        JSON.stringify({ totals: b.totals, capped: b.capped, p: p && { held: p.held, r: p.heldByReason }, a: a && { held: a.held, due: a.due, re: a.retrying, d: a.deadLetters } }));
      ok(`load ${N}: oldest held arrival is the paused endpoint's (5 days)`, Math.abs((b.oldestHeldAt?.getTime() ?? 0) - k.oldestHeld.getTime()) < 5000);
    } else {
      ok(`load ${N}: past the ${BACKLOG_SCAN_CAP}-row cap the read says so (capped) and counts are lower bounds`,
        b.capped && b.totals.held >= BACKLOG_SCAN_CAP - 30 && b.totals.held <= N + 10, JSON.stringify({ totals: b.totals, capped: b.capped }));
    }
    ok(`load ${N}: the backlog read takes ${ms} ms (< 3,000 — the server ceiling)`, ms < 3000);
    const small = await runWithTenantContext({ businessId: k.B.id }, () => intakeBacklog(k.B.id, at(), { scanCap: 2500 }));
    ok(`load ${N}: a 2,500-row read (what a screen may use) is ${small.capped ? "capped" : "exact"} as expected`, small.capped === N + 27 > 2500);
    const f = await runWithTenantContext({ businessId: k.B.id }, () => intakeFlow(k.B.id, at()));
    ok(`load ${N}: flow — received last hour ${f.receivedLastHour}, last day ${f.receivedLastDay}; processed last hour 5, of them recovered 3`,
      f.processedLastHour === 5 && f.recoveredLastHour === 3 && f.receivedLastHour >= 7 + 5 && f.receivedLastDay >= f.receivedLastHour,
      JSON.stringify(f));
    console.log(`     timing: backlog ${ms} ms (${N} held)`);
    made.push({ N, id: k.B.id, templateId: k.templateId, ref: k.paused.connection.publicId });
  }

  console.log("\n-- RLS --");
  const other = made[0];
  const peek = await runWithTenantContext({ businessId: made[1]?.id ?? other.id }, () => intakeBacklog(other.id, at()));
  ok("RLS: reading business X's backlog from business Y's tenant returns nothing", made.length < 2 || peek.totals.held + peek.totals.due + peek.totals.retrying + peek.totals.deadLetters === 0, JSON.stringify(peek.totals));

  console.log("\n-- the sweep's capacity report --");
  delete process.env.INTAKE_CAPACITY_ALERTS_ENABLED;
  const off = await runIntakeSweep({ now: at(), reconcileCommerce: false, syncRevenueSources: false, deadline: Date.now() + 10 * 60_000 });
  const expectAt = (t: number) => made.filter((m) => m.N + 10 >= t).length;
  ok(`sweep: capacity aggregated — businesses ≥500: ${off.capacity.businessesAt500}, ≥1,000: ${off.capacity.businessesAt1000}, ≥2,000: ${off.capacity.businessesAt2000}; max per business ${off.capacity.maxHeldPerBusiness}`,
    off.capacity.businessesAt500 >= expectAt(500) && off.capacity.businessesAt2000 >= expectAt(2000) && off.capacity.held >= made.reduce((a, m) => a + Math.min(m.N, BACKLOG_SCAN_CAP - 30), 0),
    JSON.stringify(off.capacity));
  ok("sweep: alerts OFF → no tier crossing claimed, no capacity red reason", off.capacity.tierCrossingsNew === 0 && !off.capacity.globalAlert
    && !sweepHealth(off).events.some((e) => e.startsWith("held_capacity")));
  const stamped0 = await o.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM "IntakeEvent" WHERE metadata ?| array['heldTier500At','heldTier1000At','heldTier2000At']`);
  ok("sweep: alerts OFF → nothing is written for capacity", stamped0[0].n === 0);

  process.env.INTAKE_CAPACITY_ALERTS_ENABLED = "true";
  const on1 = await runIntakeSweep({ now: at(1000), reconcileCommerce: false, syncRevenueSources: false, deadline: Date.now() + 10 * 60_000 });
  const expectedCrossings = made.reduce((a, m) => a + [500, 1000, 2000].filter((t) => m.N + 10 >= t).length, 0);
  ok(`sweep: alerts ON → each tier crossing reported once (${on1.capacity.tierCrossingsNew} ≥ ${expectedCrossings}), the run says so (held_capacity_tier)`,
    on1.capacity.tierCrossingsNew >= expectedCrossings && sweepHealth(on1).events.includes("held_capacity_tier"), JSON.stringify(on1.capacity));
  // Release the 1,000 OLDEST held of the largest business (still far above every tier): no crossing is new.
  const big = made[made.length - 1];
  const releaseOldest = (businessId: number, n: number) => o.$executeRawUnsafe(
    `UPDATE "IntakeEvent" SET "status" = 'PROCESSED', "nextAttemptAt" = NULL WHERE "id" IN (SELECT "id" FROM "IntakeEvent" WHERE "businessId" = $1 AND "lastErrorCode" LIKE 'held:%' AND "status" = 'RECEIVED' ORDER BY "receivedAt", "id" LIMIT $2::int)`,
    businessId, n);
  await releaseOldest(big.id, 1000);
  const on2 = await runIntakeSweep({ now: at(2000), reconcileCommerce: false, syncRevenueSources: false, deadline: Date.now() + 10 * 60_000 });
  ok("sweep: …and a second run reports none, although the 1,000 oldest of one business were released meanwhile (once per crossing)",
    on2.capacity.tierCrossingsNew === 0 && !sweepHealth(on2).events.includes("held_capacity_tier"), JSON.stringify(on2.capacity));
  // Falls below the tier and rises again → reported again.
  const k500 = made.find((m) => m.N === 500);
  if (k500) {
    await releaseOldest(k500.id, 30);
    const below = await runIntakeSweep({ now: at(3000), reconcileCommerce: false, syncRevenueSources: false, deadline: Date.now() + 10 * 60_000 });
    await clone(k500.templateId, 40, { tag: "rise", ref: k500.ref, status: "RECEIVED", next: at(9 * MIN), code: "held:connection_paused", receivedAt: at() });
    const again = await runIntakeSweep({ now: at(4000), reconcileCommerce: false, syncRevenueSources: false, deadline: Date.now() + 10 * 60_000 });
    ok(`sweep: below the tier (${below.capacity.tierCrossingsNew} new), then above it again → reported again (${again.capacity.tierCrossingsNew})`,
      below.capacity.tierCrossingsNew === 0 && again.capacity.tierCrossingsNew >= 1, JSON.stringify({ below: below.capacity.tierCrossingsNew, again: again.capacity.tierCrossingsNew }));
  }
  delete process.env.INTAKE_CAPACITY_ALERTS_ENABLED;

  console.log(`\nL1.5-b capacity battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
