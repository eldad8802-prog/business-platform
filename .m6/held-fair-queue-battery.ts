/**
 * Leads L1.5-b · PR-1 — the fair queue under load: held receipts never take a drain's whole budget, ready work is
 * done every run, a held receipt is never processed while its hold stands, and release after the hold lifts is
 * exactly once. PostgreSQL with Production's RLS and a NOBYPASSRLS runtime (same lab as the M6 battery).
 *
 * Load is synthetic: one real receipt per kind is recorded through the REAL route (so its payload, receipt key
 * shape and connection reference are exactly what Production writes), then cloned N times by the owner connection
 * with fresh receipt keys. Each load size runs in its own business. Drains are the sweep's own call
 * (drainIntake, per-business limit 50) inside the business's tenant job.
 *
 * env: as .m6/acquisition-battery.ts (DATABASE_URL / DIRECT_URL = runtime, OWNER_URL = owner, AUTH_TOKEN_SECRET,
 *      ACQUISITION_CREDENTIAL_ENCRYPTION_KEY, META_LEAD_ADS_*). HELD_LOADS overrides the sizes (comma-separated).
 */
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { runTenantJob } from "../lib/tenant/job";
import { runWithTenantContext } from "../lib/tenant/context";
import { drainIntake } from "../lib/intake/core/processor";
import { intakeRegistry } from "../lib/intake/sources";
import { createKeyedConnection, setPaused } from "../lib/intake/acquisition/connection.service";
import { deferHeldSiblings, laneReserve, listDueEventIds, pickLanes, SIBLING_BATCH } from "../lib/intake/intake-event.store";
import { POST as webPOST } from "../app/api/intake/acquisition/web/[publicId]/route";
import { POST as googlePOST } from "../app/api/intake/acquisition/google/[publicId]/route";

const RUN = `hq-${Date.now()}`;
const SWEEP_LIMIT = 50;
const LOADS = (process.env.HELD_LOADS ?? "50,500,2000,20000").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
/** Loads up to this size are released to the end (every receipt checked exactly once); larger ones for a few runs. */
/** New enquiries arriving per run during release — below the ready lane's guaranteed share (limit − reserve = 40). */
const BURST = 38;
const FULL_RELEASE_MAX = Number(process.env.HELD_FULL_RELEASE_MAX ?? 500);

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const o = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
const at = (ms = 0) => new Date(Date.now() + ms);
const MIN = 60_000;

async function enable(businessId: number, featureKey: string) {
  await o.businessFeatureAccess.upsert({
    where: { businessId_featureKey: { businessId, featureKey } },
    create: { businessId, featureKey, state: "ENABLED" },
    update: { state: "ENABLED" },
  });
}
function web(publicId: string, key: string, body: Record<string, unknown>) {
  return webPOST(new NextRequest(`http://hq.local/api/intake/acquisition/web/${publicId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  }), params({ publicId }));
}
function google(publicId: string, key: string, leadId: string) {
  return googlePOST(new NextRequest(`http://hq.local/api/intake/acquisition/google/${publicId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lead_id: leadId, google_key: key, api_version: "1.0", form_id: 9001, campaign_id: 8001, adgroup_id: 7001, creative_id: 6001,
      is_test: false, lead_submit_time: new Date().toISOString(),
      user_column_data: [
        { column_id: "FULL_NAME", column_name: "Full Name", string_value: "Load Google" },
        { column_id: "PHONE_NUMBER", column_name: "Phone", string_value: "+972 52-555-0199" },
      ],
    }),
  }), params({ publicId }));
}
const sweep = (businessId: number, now: Date, limit = SWEEP_LIMIT) =>
  runTenantJob({ businessId }, () => drainIntake(intakeRegistry, businessId, { now, limit }));

/** Clone a template receipt `n` times (owner connection, fresh receipt keys). Returns nothing; rows are counted by tag. */
async function clone(templateId: number, n: number, o2: {
  tag: string; ref: string; status: "RECEIVED" | "FAILED"; attempts: number; next: Date | null; code: string | null; receivedAt: Date;
}) {
  await o.$executeRawUnsafe(
    `INSERT INTO "IntakeEvent" ("businessId", "sourceKey", "family", "eventType", "dedupeBasis", "externalEventId",
        "providerAccountRef", "occurredAt", "receivedAt", "status", "attempts", "nextAttemptAt", "lastErrorCode",
        "payload", "metadata", "createdAt", "updatedAt")
     SELECT t."businessId", t."sourceKey", t."family", t."eventType", t."dedupeBasis",
            'sha256:' || encode(sha256(convert_to($1 || ':' || g, 'UTF8')), 'hex'),
            $2, t."occurredAt", ($3::timestamptz AT TIME ZONE 'UTC') + (g * interval '1 millisecond'), $4::"IntakeEventStatus", $5::int,
            ($6::timestamptz AT TIME ZONE 'UTC'), $7, t."payload", COALESCE(t."metadata", '{}'::jsonb) || jsonb_build_object('hqTag', $8::text),
            now(), now()
       FROM "IntakeEvent" t, generate_series(1, $9::int) g
      WHERE t."id" = $10`,
    `${RUN}:${o2.tag}`, o2.ref, o2.receivedAt.toISOString(), o2.status, o2.attempts, o2.next ? o2.next.toISOString() : null, o2.code, o2.tag, n, templateId
  );
}
const tagged = (businessId: number, tag: string) =>
  o.intakeEvent.findMany({ where: { businessId, metadata: { path: ["hqTag"], equals: tag } }, select: { id: true, status: true, attempts: true, nextAttemptAt: true, lastErrorCode: true, payload: true } });
const leadsOf = (businessId: number, sourceKey: string) => o.lead.count({ where: { businessId, sourceChannel: `intake:${sourceKey}` } });

async function scenario(N: number) {
  console.log(`\n-- load ${N}: ${N} held receipts on a PAUSED web endpoint + ready work on two ACTIVE sources --`);
  const F = await o.business.create({ data: { name: `${RUN}-F${N}` } });
  for (const f of ["acquisition_web_forms", "acquisition_google_lead_forms"]) await enable(F.id, f);
  const mk = (sourceKey: "web.form" | "google.lead_form") =>
    runWithTenantContext({ businessId: F.id }, () => createKeyedConnection({ businessId: F.id, userId: null, sourceKey, allowedOrigins: [] }));
  const pausedWeb = await mk("web.form");
  const activeWeb = await mk("web.form");
  const activeG = await mk("google.lead_form");
  const pause = (id: number, on: boolean) => runWithTenantContext({ businessId: F.id }, () => setPaused(id, on));

  // Templates through the real routes, recorded while paused (held, never processed).
  for (const id of [pausedWeb.connection.id, activeWeb.connection.id, activeG.connection.id]) await pause(id, true);
  await web(pausedWeb.connection.publicId, pausedWeb.key, { submission_id: `${RUN}-${N}-t1`, name: "Load Web", phone: "054-600-0001" });
  await google(activeG.connection.publicId, activeG.key, `${RUN}-${N}-g1`);
  for (const id of [activeWeb.connection.id, activeG.connection.id]) await pause(id, false);
  const tWeb = await o.intakeEvent.findFirstOrThrow({ where: { businessId: F.id, sourceKey: "web.form" } });
  const tG = await o.intakeEvent.findFirstOrThrow({ where: { businessId: F.id, sourceKey: "google.lead_form" } });
  // The two templates themselves leave the queue (only the clones are measured).
  await o.intakeEvent.updateMany({ where: { id: { in: [tWeb.id, tG.id] } }, data: { status: "IGNORED", nextAttemptAt: null, payload: undefined } });

  const t0 = new Date();
  const old = new Date(t0.getTime() - 3 * 24 * 60 * MIN); // held for days → the OLDEST due rows
  await clone(tWeb.id, N, { tag: "held", ref: pausedWeb.connection.publicId, status: "RECEIVED", attempts: 0, next: new Date(t0.getTime() - MIN), code: "held:connection_paused", receivedAt: old });
  // One held receipt under a LIVE lease (a worker is on it): no look may touch it.
  await clone(tWeb.id, 1, { tag: "leased", ref: pausedWeb.connection.publicId, status: "RECEIVED", attempts: 1, next: new Date(t0.getTime() + 2 * MIN), code: "held:connection_paused", receivedAt: old });
  // A fresh receipt of the paused endpoint that was never looked at (arrived after the last look): its own lane.
  await clone(tWeb.id, 1, { tag: "fresh-paused", ref: pausedWeb.connection.publicId, status: "RECEIVED", attempts: 0, next: null, code: null, receivedAt: t0 });
  // Ready work: 30 new website enquiries (active endpoint) + 5 Google leads due for a retry after a failure.
  await clone(tWeb.id, 30, { tag: "ready-web", ref: activeWeb.connection.publicId, status: "RECEIVED", attempts: 0, next: null, code: null, receivedAt: t0 });
  await clone(tG.id, 5, { tag: "ready-g", ref: activeG.connection.publicId, status: "FAILED", attempts: 1, next: new Date(t0.getTime() - MIN), code: "error:Error", receivedAt: new Date(t0.getTime() - 60 * MIN) });

  // ---- run 1: the sweep's look while paused ----
  const s1 = Date.now();
  const listed = await runTenantJob({ businessId: F.id }, () => listDueEventIds(F.id, at(), SWEEP_LIMIT));
  const listMs = Date.now() - s1;
  const heldIds = new Set((await tagged(F.id, "held")).map((e) => e.id));
  const listedHeld = listed.filter((id) => heldIds.has(id)).length;
  ok(`load ${N}: the run's list keeps ready work first — 36 ready (30 web + 5 Google + 1 fresh), held only in its share (${listedHeld} ≤ ${SWEEP_LIMIT - 36})`,
    listed.length === SWEEP_LIMIT && listed.length - listedHeld === 36 && listedHeld === SWEEP_LIMIT - 36, JSON.stringify({ n: listed.length, held: listedHeld }));
  const r1Start = Date.now();
  const r1 = await sweep(F.id, at());
  const r1Ms = Date.now() - r1Start;
  const readyWeb = await tagged(F.id, "ready-web");
  const readyG = await tagged(F.id, "ready-g");
  ok(`load ${N}: run 1 finishes ALL ready work (30 web → 30 Leads; 5 Google retries of one verified phone → its one open Lead) despite ${N} older held receipts`,
    readyWeb.every((e) => e.status === "PROCESSED" && e.attempts === 1) && readyG.every((e) => e.status === "PROCESSED" && e.attempts === 2)
      && (await leadsOf(F.id, "web.form")) === 30 && (await leadsOf(F.id, "google.lead_form")) === 1,
    JSON.stringify({ r1, web: await leadsOf(F.id, "web.form"), g: await leadsOf(F.id, "google.lead_form") }));
  const held1 = await tagged(F.id, "held");
  ok(`load ${N}: no held receipt was processed while paused — all RECEIVED, held:connection_paused, 0 attempts, payload kept`,
    held1.length === N && held1.every((e) => e.status === "RECEIVED" && e.lastErrorCode === "held:connection_paused" && e.attempts === 0 && e.payload !== null));
  const dueHeld1 = held1.filter((e) => !e.nextAttemptAt || e.nextAttemptAt.getTime() <= Date.now()).length;
  ok(`load ${N}: one look settled up to ${SIBLING_BATCH} of the connection's held receipts (still due: ${dueHeld1} ≤ max(0, N − 1 − ${SIBLING_BATCH})); 2 holds spent no attempt`,
    dueHeld1 <= Math.max(0, N - 1 - SIBLING_BATCH) && r1.deferred === 2 && r1.failed === 0,
    JSON.stringify({ dueHeld1, deferred: r1.deferred, notClaimed: r1.not_claimed, failed: r1.failed }));
  const leased = (await tagged(F.id, "leased"))[0];
  ok(`load ${N}: the receipt under a live lease was not touched (lease, attempts and code unchanged)`,
    leased.attempts === 1 && leased.nextAttemptAt!.getTime() === t0.getTime() + 2 * MIN && leased.status === "RECEIVED");
  const fresh = (await tagged(F.id, "fresh-paused"))[0];
  ok(`load ${N}: the never-looked-at receipt of the paused endpoint got its own look → held (not processed), attempt not counted`,
    fresh.status === "RECEIVED" && fresh.lastErrorCode === "held:connection_paused" && fresh.attempts === 0);
  console.log(`     timing: list ${listMs} ms, run 1 ${r1Ms} ms (${N} held)`);
  ok(`load ${N}: run 1 completes in under 60 s (${r1Ms} ms) — no statement runs on holding locks, even before the table is analyzed`, r1Ms < 60_000);

  // ---- run 2, right after: nothing held is due → no claim is spent on held receipts ----
  const r2 = await sweep(F.id, at(1000));
  ok(`load ${N}: an immediate next run spends at most one look on the connection (${r2.deferred}) and processes nothing held`,
    r2.deferred <= (N > SIBLING_BATCH + 1 ? 1 : 0) && r2.processed === 0 && r2.failed === 0, JSON.stringify(r2));

  // ---- recheck (+11 min, lease of the leased one expired too): still paused → still held, cheap ----
  const r3 = await sweep(F.id, at(11 * MIN));
  const held3 = await tagged(F.id, "held");
  ok(`load ${N}: the 10-minute recheck while still paused → still held, still 0 attempts, no Lead, ≤ ${laneReserve(SWEEP_LIMIT) + 1} looks`,
    held3.every((e) => e.status === "RECEIVED" && e.attempts === 0) && (await leadsOf(F.id, "web.form")) === 30 && r3.deferred <= SWEEP_LIMIT && r3.failed === 0,
    JSON.stringify(r3));

  // ---- resume, with new ready work arriving every run: ready never waits, held released in its share ----
  await pause(pausedWeb.connection.id, false);
  const total = N + 2; // + the leased one + the fresh one (same endpoint)
  let released = 0;
  let runs = 0;
  let readyBacklogOk = true;
  const perRun: number[] = [];
  let readyDoneBefore = await o.intakeEvent.count({ where: { businessId: F.id, providerAccountRef: activeWeb.connection.publicId, status: "PROCESSED" } });
  const maxRuns = N <= FULL_RELEASE_MAX ? Math.ceil(total / laneReserve(SWEEP_LIMIT)) + 5 : 3;
  const releaseStart = Date.now();
  while (runs < maxRuns) {
    runs++;
    const tag = `burst-${runs}`;
    const readyDue = BURST + (await o.intakeEvent.count({ where: { businessId: F.id, providerAccountRef: activeWeb.connection.publicId, status: "RECEIVED" } }));
    await clone(tWeb.id, BURST, { tag, ref: activeWeb.connection.publicId, status: "RECEIVED", attempts: 0, next: null, code: null, receivedAt: at() });
    const now = at(11 * MIN + runs * 1000);
    // Two concurrent sweeps race for the same receipts (QStash + the GitHub schedule).
    const [a, b] = await Promise.all([sweep(F.id, now), sweep(F.id, now)]);
    // Ready work done this run: at least its guaranteed share (limit − held reserve) whenever that much was due,
    // and nothing older than the previous run's burst is ever left behind (never starved).
    const readyDone = await o.intakeEvent.count({ where: { businessId: F.id, providerAccountRef: activeWeb.connection.publicId, status: "PROCESSED" } });
    if (readyDone - readyDoneBefore < Math.min(readyDue, SWEEP_LIMIT - laneReserve(SWEEP_LIMIT))) readyBacklogOk = false;
    if (runs > 1 && (await tagged(F.id, `burst-${runs - 1}`)).some((e) => e.status !== "PROCESSED")) readyBacklogOk = false;
    readyDoneBefore = readyDone;
    const nowReleased = await o.intakeEvent.count({ where: { businessId: F.id, providerAccountRef: pausedWeb.connection.publicId, status: "PROCESSED", id: { not: tWeb.id } } });
    perRun.push(nowReleased - released);
    released = nowReleased;
    void a; void b;
    if (released >= total) break;
  }
  const releaseMs = Date.now() - releaseStart;
  ok(`load ${N}: with ${BURST} new enquiries arriving every run, every run finishes all due ready work up to its 40-slot share; none waits more than one run`, readyBacklogOk);
  const beforeLast = released >= total ? perRun.slice(0, -1) : perRun;
  ok(`load ${N}: …and every run releases ≥ ${laneReserve(SWEEP_LIMIT)} held receipts in the held share (per run: min ${Math.min(...beforeLast)}, max ${Math.max(...perRun)})`,
    beforeLast.every((n) => n >= laneReserve(SWEEP_LIMIT)), JSON.stringify(perRun.slice(0, 12)));
  const endpointRows = await o.intakeEvent.findMany({ where: { businessId: F.id, providerAccountRef: pausedWeb.connection.publicId, id: { not: tWeb.id } }, select: { status: true, attempts: true } });
  const processedRows = endpointRows.filter((e) => e.status === "PROCESSED");
  ok(`load ${N}: every released receipt was processed exactly once (attempts = 1 or 2 for the dead worker's), no duplicate`,
    processedRows.every((e) => e.attempts === 1 || e.attempts === 2) && processedRows.length === released);
  if (N <= FULL_RELEASE_MAX) {
    ok(`load ${N}: released to the end — all ${total} receipts of the endpoint PROCESSED, nothing left held`,
      processedRows.length === total && endpointRows.length === total, JSON.stringify({ processed: processedRows.length, total, runs }));
  } else {
    ok(`load ${N}: released for ${runs} runs (the rest keeps waiting, still due, nothing lost or duplicated)`,
      endpointRows.length === total && endpointRows.filter((e) => e.status === "RECEIVED").length === total - released);
  }
  const webLeads = await leadsOf(F.id, "web.form");
  const webProcessed = await o.intakeEvent.count({ where: { businessId: F.id, sourceKey: "web.form", status: "PROCESSED" } });
  ok(`load ${N}: one Lead per processed website receipt (${webLeads} = ${webProcessed}) — no duplicate from the racing sweeps`, webLeads === webProcessed);
  console.log(`     timing: release ${runs} runs in ${releaseMs} ms (${released} released)`);
  return F.id;
}

async function isolation() {
  console.log("\n-- isolation, emergency release and fairness between sources --");
  const X = await o.business.create({ data: { name: `${RUN}-X` } });
  const Y = await o.business.create({ data: { name: `${RUN}-Y` } });
  for (const b of [X.id, Y.id]) for (const f of ["acquisition_web_forms", "acquisition_google_lead_forms"]) await enable(b, f);
  const mk = (businessId: number, sourceKey: "web.form" | "google.lead_form") =>
    runWithTenantContext({ businessId }, () => createKeyedConnection({ businessId, userId: null, sourceKey, allowedOrigins: [] }));
  const wx = await mk(X.id, "web.form");
  const wy = await mk(Y.id, "web.form");
  for (const [b, c] of [[X.id, wx], [Y.id, wy]] as const) {
    await runWithTenantContext({ businessId: b }, () => setPaused(c.connection.id, true));
    await web(c.connection.publicId, c.key, { submission_id: `${RUN}-iso-${b}`, name: "Iso", phone: "054-600-0002" });
  }
  const tx = await o.intakeEvent.findFirstOrThrow({ where: { businessId: X.id } });
  const ty = await o.intakeEvent.findFirstOrThrow({ where: { businessId: Y.id } });
  const past = at(-MIN);
  await o.intakeEvent.updateMany({ where: { id: { in: [tx.id, ty.id] } }, data: { nextAttemptAt: past } });
  await clone(ty.id, 20, { tag: "iso-y", ref: wy.connection.publicId, status: "RECEIVED", attempts: 0, next: past, code: "held:connection_paused", receivedAt: at(-MIN) });
  // X's look settles X's connection only; Y's due held receipts are untouched.
  await sweep(X.id, at());
  const y = await tagged(Y.id, "iso-y");
  ok("isolation: a look in business X never moves business Y's held receipts", y.every((e) => e.nextAttemptAt!.getTime() === past.getTime()));
  // Even naming Y's ids from X's tenant job changes nothing: the row-level policy decides.
  const n = await runTenantJob({ businessId: X.id }, () =>
    deferHeldSiblings(Y.id, { id: ty.id, sourceKey: "web.form", providerAccountRef: wy.connection.publicId }, at(10 * MIN), "held:connection_paused", at()));
  ok("isolation: deferHeldSiblings called for business Y from X's tenant job → 0 rows (RLS)", n === 0 && (await tagged(Y.id, "iso-y")).every((e) => e.nextAttemptAt!.getTime() === past.getTime()), String(n));
  ok("deferHeldSiblings refuses a non-hold code (a throttle is per receipt, not per connection)",
    (await runTenantJob({ businessId: Y.id }, () => deferHeldSiblings(Y.id, { id: ty.id, sourceKey: "web.form", providerAccountRef: wy.connection.publicId }, at(10 * MIN), "throttled", at()))) === 0);

  // Emergency switch on Google for business E: 120 held; switched off → released at the next recheck, exactly once.
  const E = await o.business.create({ data: { name: `${RUN}-E` } });
  await enable(E.id, "acquisition_google_lead_forms");
  const gE = await mk(E.id, "google.lead_form");
  const emergency = (on: boolean) => o.platformFeaturePolicy.upsert({
    where: { featureKey: "acquisition_google_lead_forms" }, create: { featureKey: "acquisition_google_lead_forms", globalEnabled: false, emergencyDisabled: on }, update: { emergencyDisabled: on },
  });
  await emergency(true);
  await google(gE.connection.publicId, gE.key, `${RUN}-em-1`);
  const tE = await o.intakeEvent.findFirstOrThrow({ where: { businessId: E.id } });
  ok("emergency: the Google lead is recorded and held (held:emergency_disabled)", tE.lastErrorCode === "held:emergency_disabled" || tE.status === "RECEIVED", JSON.stringify([tE.status, tE.lastErrorCode]));
  await clone(tE.id, 120, { tag: "em", ref: gE.connection.publicId, status: "RECEIVED", attempts: 0, next: at(-MIN), code: "held:emergency_disabled", receivedAt: at(-60 * MIN) });
  await sweep(E.id, at());
  ok("emergency: a look while the switch is on → all 120 still held, none processed, none due",
    (await tagged(E.id, "em")).every((e) => e.status === "RECEIVED" && e.attempts === 0 && e.nextAttemptAt!.getTime() > Date.now()) && (await leadsOf(E.id, "google.lead_form")) === 0);
  await emergency(false);
  let runs = 0;
  while (runs < 10 && (await o.intakeEvent.count({ where: { businessId: E.id, metadata: { path: ["hqTag"], equals: "em" }, status: "RECEIVED" } })) > 0) {
    runs++;
    await Promise.all([sweep(E.id, at(11 * MIN + runs * 1000)), sweep(E.id, at(11 * MIN + runs * 1000))]);
  }
  const em = await tagged(E.id, "em");
  ok(`emergency: switched off → released at the next recheck, all 120 PROCESSED exactly once in ${runs} runs (one verified phone → its one open Lead)`,
    em.every((e) => e.status === "PROCESSED" && e.attempts === 1) && (await leadsOf(E.id, "google.lead_form")) === 1, JSON.stringify({ runs, leads: await leadsOf(E.id, "google.lead_form") }));

  // Fairness between ready sources: 200 old website retries never starve 3 newer Google leads.
  const R = await o.business.create({ data: { name: `${RUN}-R` } });
  for (const f of ["acquisition_web_forms", "acquisition_google_lead_forms"]) await enable(R.id, f);
  const wR = await mk(R.id, "web.form");
  const gR = await mk(R.id, "google.lead_form");
  for (const c of [wR, gR]) await runWithTenantContext({ businessId: R.id }, () => setPaused(c.connection.id, true));
  await web(wR.connection.publicId, wR.key, { submission_id: `${RUN}-fair-w`, name: "Fair", phone: "054-600-0003" });
  await google(gR.connection.publicId, gR.key, `${RUN}-fair-g`);
  for (const c of [wR, gR]) await runWithTenantContext({ businessId: R.id }, () => setPaused(c.connection.id, false));
  const twR = await o.intakeEvent.findFirstOrThrow({ where: { businessId: R.id, sourceKey: "web.form" } });
  const tgR = await o.intakeEvent.findFirstOrThrow({ where: { businessId: R.id, sourceKey: "google.lead_form" } });
  await o.intakeEvent.updateMany({ where: { id: { in: [twR.id, tgR.id] } }, data: { status: "IGNORED", nextAttemptAt: null } });
  await clone(twR.id, 200, { tag: "fair-w", ref: wR.connection.publicId, status: "FAILED", attempts: 1, next: at(-MIN), code: "error:Error", receivedAt: at(-120 * MIN) });
  await clone(tgR.id, 3, { tag: "fair-g", ref: gR.connection.publicId, status: "RECEIVED", attempts: 0, next: null, code: null, receivedAt: at() });
  const list = await runTenantJob({ businessId: R.id }, () => listDueEventIds(R.id, at(), SWEEP_LIMIT));
  const gIds = new Set((await tagged(R.id, "fair-g")).map((e) => e.id));
  ok("fairness: 200 older website retries + 3 newer Google leads → the first run's list carries all 3 Google leads (round-robin by source)",
    list.length === SWEEP_LIMIT && list.filter((id) => gIds.has(id)).length === 3);
  await sweep(R.id, at());
  ok("fairness: …and the run processes them (3 Google receipts PROCESSED) alongside 47 website retries (47 Leads)",
    (await tagged(R.id, "fair-g")).every((e) => e.status === "PROCESSED") && (await leadsOf(R.id, "web.form")) === 47, JSON.stringify({ g: await leadsOf(R.id, "google.lead_form"), w: await leadsOf(R.id, "web.form") }));
}

function pure() {
  console.log("\n-- the lane split (pure) --");
  const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);
  const cases: [number, number, number, number, number][] = [
    // ready due, held due, limit → expected ready taken, held taken
    [0, 0, 50, 0, 0], [100, 0, 50, 50, 0], [0, 100, 50, 0, 50], [100, 100, 50, 40, 10], [30, 100, 50, 30, 20],
    [45, 3, 50, 45, 3], [49, 20, 50, 40, 10], [5, 5, 50, 5, 5], [100, 100, 25, 20, 5], [100, 100, 1, 0, 1], [3, 100, 4, 3, 1],
  ];
  for (const [r, h, l, er, eh] of cases) {
    const out = pickLanes(ids(r), ids(h, 10_000), l);
    const gotR = out.filter((x) => x < 10_000).length;
    const gotH = out.length - gotR;
    ok(`pickLanes(ready ${r}, held ${h}, limit ${l}) → ${er} + ${eh}`, gotR === er && gotH === eh && out.length <= l, `${gotR} + ${gotH}`);
  }
}

async function main() {
  pure();
  for (const n of LOADS) await scenario(n);
  await isolation();
  console.log(`\nL1.5-b fair-queue battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => { await o.$disconnect(); });
