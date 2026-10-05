/**
 * M9 · Production CLOSED-LOOP BASELINE — READ ONLY. Measures the outcome loop before the product changes.
 *
 *   OWNER_DATABASE_URL=… RUNTIME_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/closed-loop-baseline.ts \
 *     --allow-host ep-flat-brook-am4bhq1y --runtime-user app_runtime_prod
 *
 * Two sessions, both held READ ONLY by Postgres (verified before and after):
 *   owner    exact aggregates of the five M9 tables, origin evidence and coherence checks. Counts and codes
 *            only — never a name, amount, document text, target list or free value.
 *   runtime  the least-privilege login (verified NOSUPERUSER + NOBYPASSRLS) builds each business's REAL
 *            snapshot to measure which learning artifacts are present in the BKS. No model is called.
 *
 * ORIGIN is classified only where a stored field proves it; anything else is UNKNOWN:
 *   DURING_AUTHORIZED_DERIVE_RUN  the row was created inside a KnowledgeDerivationRun window of the same
 *                                 business (the only writer of recommendations / actions / observations /
 *                                 assessments is the derive route)
 *   OWNER_SESSION_NO_UI_SURFACE   a decision whose actor is a user of the same business. No screen calls the
 *                                 decision endpoint, so HOW the call was made is not provable: never "natural"
 *   NATURAL_DOMAIN_ACT            (action events) the ledger record exists in the same business — a real
 *                                 review / payment the business performed, which the derive merely observed
 *   UNKNOWN                       nothing stored proves the origin. Nothing is ever classified SYNTHETIC by guess.
 *
 * CHAINS, per recommendation: decision → performed domain action → observation → ACTIVE assessment →
 * RECOMMENDATION_MEMORY in the BKS. A COMPLETE loop needs every link; a NATURAL complete loop also needs every
 * link's origin proven natural (a decision cannot be, while no owner surface exists).
 *
 * ANOMALIES fail the run: a cross-tenant link between M9 rows, an action whose ledger record is missing or
 * foreign, a decision actor from another business, an observation on another recommendation's action, a
 * non-vocabulary attribution, or BKS memory that differs from what learn.ts's own rule predicts.
 *
 * READ ONLY IS ENFORCED PER CONNECTION, not asserted. Every connection either pool opens carries
 * `options=-c default_transaction_read_only=on`, so the database itself makes each new connection read-only.
 * The pools are small and bounded (POOL_LIMIT) because the application's own snapshot code opens tenant
 * transactions in parallel (business-status → paperwork insight); a single connection made the second one
 * time out (P2028, run 37382271323). Before any query, POOL_LIMIT parallel transactions prove every pooled
 * connection reports read-only, and an attempted write is proven to be REJECTED by PostgreSQL.
 *
 * A failure building one business's snapshot is reported as an ERROR row for that business and FAILS the run;
 * the report is still printed. An error never becomes a pass.
 *
 * Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

const DAY = 86_400_000;
const ATTRIBUTIONS = new Set(["NOT_ASSESSABLE", "NO_OUTCOME_OBSERVED", "OBSERVED_SEQUENCE"]);
const STORE_TABLE: Record<string, string> = { ReviewEvent: "ReviewEvent", PaymentAllocation: "PaymentAllocation", Document: "Document", Installment: "Installment" };
const RUN_MARGIN_MS = 60_000;
/** Small and bounded: enough for the snapshot code's parallel tenant transactions to each get a connection. */
const POOL_LIMIT = 5;

/** A Production-checked URL whose EVERY pooled connection starts read-only (database-enforced). */
function readOnlyPoolUrl(label: string, raw: string | undefined, allowHost: string | null): string {
  const u = new URL(assertSafeUrl(label, raw, allowHost)); // refuses non-Production hosts and poolers first
  u.searchParams.set("connection_limit", String(POOL_LIMIT));
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

/** Proves, on POOL_LIMIT concurrent connections, that each one is read-only, and that a write is rejected. */
async function provePoolReadOnly(db: PrismaClient, label: string): Promise<{ connections: number; allReadOnly: boolean; writeRejected: boolean }> {
  const probes = await Promise.all(Array.from({ length: POOL_LIMIT }, () =>
    db.$transaction(async (tx) => {
      const [r] = await tx.$queryRawUnsafe<{ ro: string; pid: number }[]>("SELECT current_setting('default_transaction_read_only') AS ro, pg_backend_pid() AS pid");
      await tx.$queryRawUnsafe("SELECT 1 AS held FROM pg_sleep(0.2)"); // hold the connection so the probes spread over the pool
      return r;
    }, { maxWait: 20_000, timeout: 20_000 })));
  const pids = new Set(probes.map((p) => Number(p.pid)));
  let writeRejected = false;
  try {
    // A TEMP table: even if it were allowed, it would touch nothing but this session. It must be refused.
    await db.$executeRawUnsafe("CREATE TEMP TABLE zz_readonly_probe (x int)");
  } catch (e) {
    writeRejected = /read-only|25006/i.test(String((e as Error).message ?? e));
  }
  if (!probes.every((p) => p.ro === "on")) throw new RefusedError(`${label} pool has a connection that is not read-only`);
  return { connections: pids.size, allReadOnly: probes.every((p) => p.ro === "on"), writeRejected };
}

type Check = { name: string; pass: boolean; detail?: unknown };
const tally = <T,>(xs: readonly T[], f: (x: T) => string) => xs.reduce<Record<string, number>>((a, x) => { const k = f(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const allowHost = arg("--allow-host") ?? null;
  const runtimeUser = arg("--runtime-user") ?? "";
  if (!runtimeUser) { console.error("usage: --allow-host <host> --runtime-user <role>"); process.exit(2); }
  const checks: Check[] = [];
  // The application code under test may reject a parallel promise after another one already failed; record it
  // (and fail the run) instead of letting it kill the process before the report.
  const unhandled: string[] = [];
  process.on("unhandledRejection", (e) => { unhandled.push(`${e instanceof Error ? e.name : "Error"} ${(e as { code?: string })?.code ?? ""}`.trim()); });
  const check = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass, detail });
  let owner: PrismaClient | undefined;
  let rt: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: readOnlyPoolUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    rt = new PrismaClient({ datasourceUrl: readOnlyPoolUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost) });
    const ownerRo = await provePoolReadOnly(owner, "owner");
    const rtRo = await provePoolReadOnly(rt, "runtime");
    check("read-only: every pooled connection starts read-only (database-enforced), owner and runtime",
      ownerRo.allReadOnly && rtRo.allReadOnly, { owner: ownerRo.connections, runtime: rtRo.connections });
    check("read-only: an attempted write is rejected by PostgreSQL, owner and runtime", ownerRo.writeRejected && rtRo.writeRejected);
    const id = await verifyRuntimeIdentity(rt, runtimeUser);
    check("runtime login is NOSUPERUSER + NOBYPASSRLS", !id.superuser && !id.bypassRls);
    const q = <T>(sql: string, ...p: unknown[]) => owner!.$queryRawUnsafe<T[]>(sql, ...p);
    const asOf = new Date();

    /* ── the five tables (ids, codes, dates only) ── */
    const recs = await q<{ id: number; b: number; key: string; version: number; type: string; status: string; issuedAt: Date; closedAt: Date | null; createdAt: Date }>(
      `SELECT id, "businessId" AS b, "recommendationKey" AS key, version, type, status::text AS status, "issuedAt", "closedAt", "createdAt" FROM "OutcomeRecommendation" ORDER BY id`);
    const decs = await q<{ id: number; b: number; rid: number; decision: string; source: string; actor: number; ub: number | null; createdAt: Date }>(
      `SELECT d.id, d."businessId" AS b, d."recommendationId" AS rid, d.decision::text AS decision, d.source, d."actorUserId" AS actor, u."businessId" AS ub, d."createdAt"
         FROM "OutcomeDecision" d LEFT JOIN "User" u ON u.id = d."actorUserId" ORDER BY d.id`);
    const acts = await q<{ id: number; b: number; rid: number; kind: string; eventType: string; store: string; rec: number; createdAt: Date }>(
      `SELECT id, "businessId" AS b, "recommendationId" AS rid, "actionKind" AS kind, "eventType", "domainStore" AS store, "domainRecordId" AS rec, "createdAt" FROM "OutcomeActionEvent" ORDER BY id`);
    const obs = await q<{ id: number; b: number; rid: number; aid: number | null; kind: string; createdAt: Date }>(
      `SELECT id, "businessId" AS b, "recommendationId" AS rid, "actionEventId" AS aid, kind, "createdAt" FROM "OutcomeObservation" ORDER BY id`);
    const asms = await q<{ id: number; b: number; rid: number; status: string; attribution: string; outcomeState: string; actionState: string; decisionState: string; createdAt: Date }>(
      `SELECT id, "businessId" AS b, "recommendationId" AS rid, status, attribution, "outcomeState", "actionState", "decisionState", "createdAt" FROM "OutcomeAssessment" ORDER BY id`);
    const runs = await q<{ b: number; callerClass: string; startedAt: Date; finishedAt: Date | null }>(
      `SELECT "businessId" AS b, "callerClass", "startedAt", "finishedAt" FROM "KnowledgeDerivationRun" ORDER BY id`);

    const recById = new Map(recs.map((r) => [r.id, r]));
    const inRun = (b: number, at: Date) => runs.some((r) => r.b === b && at.getTime() >= r.startedAt.getTime() - RUN_MARGIN_MS
      && at.getTime() <= (r.finishedAt ?? r.startedAt).getTime() + RUN_MARGIN_MS);
    const origin = (b: number, at: Date) => (inRun(b, at) ? "DURING_AUTHORIZED_DERIVE_RUN" : "UNKNOWN");

    /* ── coherence / tenant checks ── */
    const crossTenant = [...decs, ...acts, ...obs, ...asms].filter((x) => recById.get(x.rid)?.b !== x.b).length;
    check("tenant: every decision / action / observation / assessment belongs to its recommendation's business", crossTenant === 0, crossTenant);
    const foreignActor = decs.filter((d) => d.ub !== d.b).length;
    check("decisions: every actor is a user of the same business", foreignActor === 0, foreignActor);
    let missingLedger = 0;
    const naturalAct = new Set<number>();
    for (const [store, table] of Object.entries(STORE_TABLE)) {
      const ofStore = acts.filter((a) => a.store === store);
      if (ofStore.length === 0) continue;
      const rows = await q<{ id: number; b: number }>(`SELECT id, "businessId" AS b FROM "${table}" WHERE id = ANY($1)`, ofStore.map((a) => a.rec));
      for (const a of ofStore) {
        const r = rows.find((x) => Number(x.id) === a.rec);
        if (!r || Number(r.b) !== a.b) missingLedger += 1; else naturalAct.add(a.id);
      }
    }
    const unknownStore = acts.filter((a) => !(a.store in STORE_TABLE)).length;
    check("actions: every action's ledger record exists in the same business", missingLedger === 0 && unknownStore === 0, { missingLedger, unknownStore });
    const actById = new Map(acts.map((a) => [a.id, a]));
    const obsMismatch = obs.filter((o) => o.aid !== null && actById.get(o.aid)?.rid !== o.rid).length;
    check("observations: a linked action belongs to the same recommendation", obsMismatch === 0, obsMismatch);
    const badAttr = asms.filter((a) => !ATTRIBUTIONS.has(a.attribution)).length;
    check("assessments: attribution is within the non-causal vocabulary", badAttr === 0, badAttr);

    /* ── BKS presence, built as the runtime role ── */
    (globalThis as unknown as { prisma: PrismaClient }).prisma = rt;
    const { buildBusinessKnowledgeSnapshot } = await import("@/lib/knowledge/snapshot/build-snapshot");
    const businesses = [...new Set(recs.map((r) => r.b))].sort((a, b) => a - b);
    const bks: Record<string, unknown> = {};
    const memorySlots = new Map<number, Set<string>>();
    let memoryMismatch = 0;
    let patterns = { DECISION_PATTERN: 0, OUTCOME_PATTERN: 0 };
    const snapshotErrors: Record<string, string> = {};
    for (const b of businesses) {
      let snap: Awaited<ReturnType<typeof buildBusinessKnowledgeSnapshot>>;
      try {
        snap = await buildBusinessKnowledgeSnapshot(b, { asOf });
      } catch (e) {
        // Reported, never swallowed: this business has no BKS measurement and the run FAILS.
        snapshotErrors[`B${b}`] = `${e instanceof Error ? e.name : "Error"} ${(e as { code?: string })?.code ?? ""}`.trim();
        bks[`B${b}`] = { ERROR: snapshotErrors[`B${b}`] };
        memoryMismatch += 1;
        continue;
      }
      const mem = snap.knowledge.filter((k) => k.kind === "RECOMMENDATION_MEMORY");
      const dp = snap.knowledge.filter((k) => k.kind === "DECISION_PATTERN").length;
      const op = snap.knowledge.filter((k) => k.kind === "OUTCOME_PATTERN").length;
      patterns = { DECISION_PATTERN: patterns.DECISION_PATTERN + dp, OUTCOME_PATTERN: patterns.OUTCOME_PATTERN + op };
      memorySlots.set(b, new Set(mem.map((m) => m.slot)));
      // learn.ts's own rule: latest version per key among recommendations issued ≤ asOf that are ACTIVE or issued in the
      // last 365 days, kept when ACTIVE or closed/issued within the last 90 days.
      const loaded = recs.filter((r) => r.b === b && r.issuedAt.getTime() <= asOf.getTime() && (r.status === "ACTIVE" || r.issuedAt.getTime() >= asOf.getTime() - 365 * DAY));
      const latest = new Map<string, (typeof recs)[number]>();
      for (const r of loaded) { const c = latest.get(r.key); if (!c || r.version > c.version) latest.set(r.key, r); }
      const expected = [...latest.values()].filter((r) => r.status === "ACTIVE" || asOf.getTime() - (r.closedAt ?? r.issuedAt).getTime() <= 90 * DAY);
      if (expected.length !== mem.length || expected.some((r) => !memorySlots.get(b)!.has(`outcome|memory|${r.key}`))) memoryMismatch += 1;
      bks[`B${b}`] = {
        recommendationMemory: mem.length, decisionPatterns: dp, outcomePatterns: op,
        patternGaps: snap.knowledgeGaps.filter((g) => g.key.startsWith("outcomes.")).map((g) => `${g.kind}:${g.reason}`).sort(),
      };
    }
    check("BKS: every business's snapshot was built (no ERROR)", Object.keys(snapshotErrors).length === 0, snapshotErrors);
    check("BKS: RECOMMENDATION_MEMORY in each snapshot equals what learn.ts's rule predicts from the database", memoryMismatch === 0, memoryMismatch);
    check("harness: no unhandled rejection from the application code under test", unhandled.length === 0, unhandled);

    /* ── chains ── */
    const chainOf = (r: (typeof recs)[number]) => {
      const d = decs.some((x) => x.rid === r.id);
      const a = acts.filter((x) => x.rid === r.id && x.eventType === "PERFORMED");
      const aNatural = a.some((x) => naturalAct.has(x.id));
      const o = obs.some((x) => x.rid === r.id);
      const s = asms.some((x) => x.rid === r.id && x.status === "ACTIVE");
      const m = memorySlots.get(r.b)?.has(`outcome|memory|${r.key}`) ?? false;
      return { d, a: a.length > 0, aNatural, o, s, m };
    };
    const latestPerKey = new Map<string, (typeof recs)[number]>();
    for (const r of recs) { const c = latestPerKey.get(`${r.b}|${r.key}`); if (!c || r.version > c.version) latestPerKey.set(`${r.b}|${r.key}`, r); }
    const chains = recs.map((r) => ({ r, c: chainOf(r) }));
    const complete = chains.filter(({ c }) => c.d && c.a && c.o && c.s && c.m).length;
    const completeNatural = 0; // a decision's origin cannot be proven natural while no owner surface exists (see header)
    // Partial natural chain: the recommendation was followed by a REAL domain act the ledger proves (observations
    // and assessments are system derivations, so they never make a chain "natural" on their own).
    const partialNatural = chains.filter(({ c }) => c.aNatural).length;

    const report = {
      asOf: asOf.toISOString(),
      readOnlyPool: { limit: POOL_LIMIT, ownerConnectionsProbed: ownerRo.connections, runtimeConnectionsProbed: rtRo.connections, writeRejected: ownerRo.writeRejected && rtRo.writeRejected },
      businessesWithRecommendations: businesses.map((b) => `B${b}`),
      OutcomeRecommendation: {
        total: recs.length, byBusiness: tally(recs, (r) => `B${r.b}`), byType: tally(recs, (r) => r.type), byStatus: tally(recs, (r) => r.status),
        distinctKeys: latestPerKey.size, origin: tally(recs, (r) => origin(r.b, r.createdAt)),
      },
      OutcomeDecision: { total: decs.length, byDecision: tally(decs, (d) => d.decision), bySource: tally(decs, (d) => d.source),
        origin: tally(decs, (d) => (d.ub === d.b ? "OWNER_SESSION_NO_UI_SURFACE" : "UNKNOWN")) },
      OutcomeActionEvent: { total: acts.length, byKind: tally(acts, (a) => a.kind), byEventType: tally(acts, (a) => a.eventType), byStore: tally(acts, (a) => a.store),
        recordedDuring: tally(acts, (a) => origin(a.b, a.createdAt)), naturalDomainActs: naturalAct.size },
      OutcomeObservation: { total: obs.length, byKind: tally(obs, (o) => o.kind), origin: tally(obs, (o) => origin(o.b, o.createdAt)) },
      OutcomeAssessment: { total: asms.length, byStatus: tally(asms, (a) => a.status), byAttribution: tally(asms, (a) => a.attribution),
        byOutcomeState: tally(asms, (a) => a.outcomeState), byActionState: tally(asms, (a) => a.actionState), byDecisionState: tally(asms, (a) => a.decisionState),
        origin: tally(asms, (a) => origin(a.b, a.createdAt)) },
      derivationRuns: { total: runs.length, byCallerClass: tally(runs, (r) => r.callerClass) },
      learning: { ...patterns, recommendationMemory: [...memorySlots.values()].reduce((s, x) => s + x.size, 0), bks },
      chains: {
        recommendations: recs.length,
        withDecision: chains.filter(({ c }) => c.d).length,
        withPerformedAction: chains.filter(({ c }) => c.a).length,
        withNaturalDomainAction: chains.filter(({ c }) => c.aNatural).length,
        withObservation: chains.filter(({ c }) => c.o).length,
        withActiveAssessment: chains.filter(({ c }) => c.s).length,
        inBksMemory: chains.filter(({ c }) => c.m).length,
        partialNaturalChains: partialNatural,
        completeLoopsAnyOrigin: complete,
        completeNaturalClosedLoops: completeNatural,
      },
    };
    await verifyReadOnly(owner, "owner");
    await verifyReadOnly(rt, "runtime");
    console.log(JSON.stringify(report, null, 1));
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || c.detail === undefined ? "" : `  (${JSON.stringify(c.detail)})`}`);
    const failed = checks.filter((c) => !c.pass).length;
    console.log(failed === 0 ? `\nCLOSED-LOOP BASELINE: PASS (${checks.length} checks)` : `\nCLOSED-LOOP BASELINE: FAIL (${failed} of ${checks.length})`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
    await rt?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/closed-loop-baseline.ts")) void main();
