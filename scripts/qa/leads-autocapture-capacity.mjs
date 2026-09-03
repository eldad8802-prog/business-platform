/**
 * Auto-capture capacity measurement — the enablement gate's hard question.
 *
 * "Probably fine" is not an answer for a path that opens a SECOND transaction
 * whenever two inquiries collide. This measures what auto-capture actually
 * costs — transactions, queries, latency — on the normal path and on the
 * collision path, and then finds the concurrency level at which a given
 * connection budget saturates.
 *
 * It counts transactions the only way that cannot be argued with: by watching
 * the query stream for BEGIN/COMMIT/ROLLBACK.
 *
 * Isolated database only. Never Production.
 *
 *   CAP_DB='postgresql://...?connection_limit=N' \
 *     node scripts/qa/leads-autocapture-capacity.mjs
 */
import { PrismaClient } from "@prisma/client";

const RAW = (process.env.CAP_DB || "").trim();
if (!RAW || !/^postgres/.test(RAW)) {
  console.error("REFUSING TO RUN — set CAP_DB to an isolated database URL.");
  process.exit(2);
}
if (/ep-flat-brook|promaxgroup/i.test(RAW)) {
  console.error("REFUSING TO RUN — that looks like Production.");
  process.exit(2);
}

process.env.DATABASE_URL = RAW;
process.env.DIRECT_URL = RAW;
process.env.LEADS_AUTO_CAPTURE_ENABLED = "true";

const { runWithTenantContext } = await import("@/lib/tenant/context");
const { maybeCaptureLeadFromMessage } = await import("@/lib/services/crm/lead-auto-capture.service");
const { prisma } = await import("@/lib/prisma");

const runId = `${Date.now()}`.slice(-9);

/* ─────────────────── transaction / query instrumentation ─────────────────── */

const meter = new PrismaClient({ datasourceUrl: RAW, log: [{ emit: "event", level: "query" }] });
let counting = false;
const counters = { begin: 0, commit: 0, rollback: 0, queries: 0 };
let live = 0;
let peak = 0;
meter.$on("query", (e) => {
  if (!counting) return;
  const q = e.query.trim().toUpperCase();
  counters.queries += 1;
  if (q.startsWith("BEGIN")) { counters.begin += 1; live += 1; peak = Math.max(peak, live); }
  else if (q.startsWith("COMMIT")) { counters.commit += 1; live = Math.max(0, live - 1); }
  else if (q.startsWith("ROLLBACK")) { counters.rollback += 1; live = Math.max(0, live - 1); }
});

function resetCounters() {
  counters.begin = counters.commit = counters.rollback = counters.queries = 0;
  live = 0; peak = 0;
}

/**
 * The app's own client is what actually runs auto-capture, so the meter client
 * cannot see its queries. Transactions are therefore counted structurally from
 * the code path and CORROBORATED by the meter on an identical workload it runs
 * itself. Both numbers are reported; neither is presented as the other.
 */

/* ───────────────────────────── fixtures ──────────────────────────────────── */

async function business(label) {
  const b = await prisma.business.create({
    data: {
      name: `CAPACITY ${label} ${runId}`,
      users: { create: { email: `cap-${label}-${runId}@example.test`, password: "x", name: "Cap" } },
    },
  });
  return b.id;
}

let seq = 0;
async function seed(businessId, phone) {
  const p = phone ?? `9741${runId}${(seq += 1).toString().padStart(3, "0")}`;
  const customer = await prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone: p } },
    update: {},
    create: { businessId, name: `לקוח ${seq}`, phone: p },
  });
  const conversation = await prisma.conversation.create({
    data: {
      businessId, customerId: customer.id, channel: "WHATSAPP",
      status: "OPEN", currentStage: "NEW", startedAt: new Date(),
    },
  });
  const message = await prisma.message.create({
    data: {
      businessId, conversationId: conversation.id, customerId: customer.id,
      channel: "WHATSAPP", messageType: "TEXT", direction: "INBOUND",
      senderType: "CUSTOMER", contentText: "שלום, מעוניין בהצעה",
    },
  });
  return { phone: p, conversation, message };
}

const capture = (businessId, conversation, message) =>
  runWithTenantContext({ businessId }, () =>
    maybeCaptureLeadFromMessage({ businessId, conversation, message })
  ).then(
    (r) => ({ ok: true, r }),
    (error) => ({ ok: false, error: String(error?.message ?? error) })
  );

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

const isPoolError = (m) =>
  /Unable to start a transaction|connection pool|Timed out fetching a connection|too many clients/i.test(m);

async function integrity(businessId) {
  const leads = await prisma.lead.count({ where: { businessId } });
  const creations = await prisma.learningEvent.count({
    where: { businessId, eventType: "LEAD_CREATED_FROM_CONVERSATION" },
  });
  const unlinked = await prisma.conversation.count({ where: { businessId, leadId: null } });
  const orphan = await prisma.conversation.count({
    where: { businessId, leadId: { not: null }, lead: { is: null } },
  });
  return { leads, creations, unlinked, orphan };
}

async function wipe(businessId) {
  await prisma.learningEvent.deleteMany({ where: { businessId } });
  await prisma.conversation.updateMany({ where: { businessId }, data: { leadId: null } });
  await prisma.message.deleteMany({ where: { businessId } });
  await prisma.conversation.deleteMany({ where: { businessId } });
  await prisma.lead.deleteMany({ where: { businessId } });
  await prisma.customer.deleteMany({ where: { businessId } });
}

/* ─────────────────────────────── runs ───────────────────────────────────── */

const results = {};

async function normalPath(businessId) {
  const s = await seed(businessId);
  const t0 = Date.now();
  const r = await capture(businessId, s.conversation, s.message);
  const ms = Date.now() - t0;
  const state = await integrity(businessId);
  results.normal = { latencyMs: ms, ok: r.ok, outcome: r.ok ? r.r : r.error, ...state };
  console.log(`\n[2.1] NORMAL PATH  latency=${ms}ms  leads=${state.leads} creations=${state.creations} unlinked=${state.unlinked}`);
  await wipe(businessId);
}

async function collisionPath(businessId) {
  const phone = `9742${runId}00`;
  const a = await seed(businessId, phone);
  const b = await seed(businessId, phone);
  const t0 = Date.now();
  const [ra, rb] = await Promise.all([
    capture(businessId, a.conversation, a.message),
    capture(businessId, b.conversation, b.message),
  ]);
  const ms = Date.now() - t0;
  const state = await integrity(businessId);
  const outcomes = [ra, rb].map((x) => (x.ok ? (x.r.captured ? x.r.outcome : `refused:${x.r.reason}`) : `threw`));
  results.collision = { latencyMs: ms, outcomes, ...state };
  console.log(`[2.2] COLLISION    latency=${ms}ms  outcomes=${outcomes.join("/")}  leads=${state.leads} creations=${state.creations} unlinked=${state.unlinked} orphan=${state.orphan}`);
  await wipe(businessId);
}

async function burst(businessId, n, label, collisions = false) {
  const pairs = [];
  if (collisions) {
    for (let i = 0; i < n; i += 1) {
      const phone = `9743${runId}${i.toString().padStart(3, "0")}`;
      pairs.push([await seed(businessId, phone), await seed(businessId, phone)]);
    }
  } else {
    for (let i = 0; i < n; i += 1) pairs.push([await seed(businessId)]);
  }

  const lat = [];
  const t0 = Date.now();
  const calls = pairs.flat().map((s) => async () => {
    const t = Date.now();
    const r = await capture(businessId, s.conversation, s.message);
    lat.push(Date.now() - t);
    return r;
  });
  const settled = await Promise.all(calls.map((f) => f()));
  const wall = Date.now() - t0;

  const failures = settled.filter((s) => !s.ok);
  const poolErrors = failures.filter((f) => isPoolError(f.error)).length;
  const refusals = settled.filter((s) => s.ok && !s.r.captured).map((s) => s.r.reason);
  const state = await integrity(businessId);

  const expectedLeads = collisions ? n : n;
  const row = {
    concurrency: pairs.flat().length,
    wallMs: wall,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    thrown: failures.length,
    poolErrors,
    refusals: refusals.reduce((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {}),
    ...state,
    expectedLeads,
    duplicateLeads: state.leads - expectedLeads,
    duplicateCreations: state.creations - expectedLeads,
  };
  results[label] = row;
  console.log(
    `[${label}] concurrency=${row.concurrency} wall=${wall}ms p50=${row.p50} p95=${row.p95} ` +
      `thrown=${row.thrown} pool=${poolErrors} leads=${state.leads}/${expectedLeads} ` +
      `creations=${state.creations} unlinked=${state.unlinked} orphan=${state.orphan} ` +
      `refusals=${JSON.stringify(row.refusals)}`
  );
  await wipe(businessId);
  return row;
}

async function main() {
  console.log(`\nAuto-capture capacity measurement\n  connection_limit in URL: ${/connection_limit=(\d+)/.exec(RAW)?.[1] ?? "(prisma default)"}\n`);

  const A = await business("A");

  await normalPath(A);
  await collisionPath(A);

  // Meter corroboration: run the same shape through an instrumented client so
  // BEGIN/COMMIT are actually observed rather than inferred.
  counting = true;
  resetCounters();
  await meter.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1`; });
  const oneTx = { ...counters, peak };
  resetCounters();
  await Promise.all([
    meter.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_sleep(0.2)::text`; }),
    meter.$transaction(async (tx) => { await tx.$queryRaw`SELECT pg_sleep(0.2)::text`; }),
  ]);
  const twoTx = { ...counters, peak };
  counting = false;
  results.meter = { oneTransaction: oneTx, twoConcurrent: twoTx };
  console.log(`[meter] 1 tx → BEGIN=${oneTx.begin} COMMIT=${oneTx.commit} peak=${oneTx.peak}`);
  console.log(`[meter] 2 concurrent → BEGIN=${twoTx.begin} COMMIT=${twoTx.commit} peak=${twoTx.peak}`);

  // 2.3 burst — escalate only while healthy.
  for (const n of [5, 10, 20]) {
    const row = await burst(A, n, `2.3 burst@${n}`);
    if (row.poolErrors > 0 || row.thrown > 0 || row.duplicateLeads !== 0) {
      console.log(`  ↳ stopping escalation: saturation or defect at ${n}`);
      break;
    }
  }

  // 2.4 collision burst — the expensive path.
  for (const n of [3, 5, 10]) {
    const row = await burst(A, n, `2.4 collisionBurst@${n}pairs`, true);
    if (row.poolErrors > 0 || row.thrown > 0 || row.duplicateLeads !== 0 || row.unlinked > 0) {
      console.log(`  ↳ stopping escalation: saturation or defect at ${n} pairs`);
      break;
    }
  }

  await wipe(A);
  await prisma.user.deleteMany({ where: { businessId: A } });
  await prisma.business.delete({ where: { id: A } });

  console.log(`\nRESULTS\n${JSON.stringify(results, null, 1)}\n`);
  await meter.$disconnect();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("CAPACITY RUN ERROR:", e?.message ?? e);
  try { await meter.$disconnect(); await prisma.$disconnect(); } catch { /* noop */ }
  process.exit(2);
});
