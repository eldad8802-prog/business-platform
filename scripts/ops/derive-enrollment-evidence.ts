/**
 * Derive authority — POST-ENROLLMENT Production proof (businesses 3 and 9). SCRIPT-ONLY, READ-ONLY:
 * counts, hashes, codes and booleans only. Driven by .github/workflows/prod-derive-enrollment-proof.yml:
 *
 *   --phase precheck                        enrollment is EXACTLY the two approved overrides, the feature is
 *                                           otherwise OFF, and the platform-admin audit rows exist.
 *                                           Anything else fails BEFORE a single derive request is sent.
 *   --phase snapshot --out before.json      fingerprints (row count + md5 over full row text):
 *                                             derive-writable tables  per target business AND for all others
 *                                             every other tenant table per target business (+ the Business rows)
 *   (the workflow then drives the live route and writes calls.jsonl — one safe summary line per call)
 *   --phase verify --before before.json --calls calls.jsonl --caller-run <GitHub run id>
 *
 * Verify proves, against the calls actually made:
 *   LEDGER     one KnowledgeDerivationRun per 200, carrying the response's runId, the right businessId,
 *              SUCCEEDED + finishedAt, this caller run id; nothing left RUNNING; no run for any refusal.
 *   AUDIT      the KNOWLEDGE_DERIVE SecurityEvents for this caller run id are EXACTLY the multiset the
 *              calls imply (SUCCESS names its business; refusals name none); no secret in any of them.
 *   MUTATIONS  derive-writable tables: per-business deltas reported as EXPECTED artifacts, rows of every
 *              OTHER business unchanged (cross-tenant = 0); every non-derive tenant table unchanged for
 *              3 and 9 (unexpected = 0); OutcomeDecision / OutcomeActionEvent unchanged (nothing fabricated).
 *   TENANT     as app_runtime_prod (NOSUPERUSER, NOBYPASSRLS): no context → zero runs; in each tenant's
 *              context only its own runs, the other's run invisible; zero foreign rows in any derive table.
 *   SCHEMA     live catalog: the ownership guard (only outcome columns may change, businessId never), the
 *              UPDATE policy's USING + WITH CHECK tenant pin, the one-RUNNING partial unique index (valid).
 *   FEATURE    still exactly {3, 9} enabled, default/global OFF, emergency not engaged.
 *
 * Reuses runtime-rls-evidence.ts's fail-closed preconditions. Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

const FEATURE = "knowledge_derivation";
/** Every table the derive pipeline (route + services) can write. */
const DERIVE_TABLES = [
  "KnowledgeMeasure", "KnowledgeMeasureEvidenceLink", "TemporalKnowledge", "BusinessInsight",
  "DerivedClaimProjection", "DerivedClaimCandidate", "DerivedClaimEvidenceLink",
  "IdentityLink", "IdentityProposal", "PartyResolutionClaim", "EntityLinkProposal", "CollectionAction", "LearningEvent", "Recommendation",
  "OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment",
  "KnowledgeDerivationRun",
];
/** Written by derive but only ever from an owner interaction: must not move (no fabricated decisions/actions). */
const MUST_NOT_MOVE = ["OutcomeDecision", "OutcomeActionEvent"];
/** Accounted separately (the audit store) or changed by the approved enrollment itself. */
const ACCOUNTED_ELSEWHERE = ["SecurityEvent", "BusinessFeatureAccess", "PlatformAuditEvent"];
const ISOLATION = [
  "KnowledgeMeasure", "TemporalKnowledge", "BusinessInsight", "PartyResolutionClaim", "EntityLinkProposal", "CollectionAction",
  "LearningEvent", "OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment",
  "KnowledgeDerivationRun",
];

type Fp = { n: number; h: string | null };
type Snap = {
  businesses: number[];
  derive: Record<string, { exists: boolean; hasBusinessId: boolean; per: Record<string, Fp>; others: Fp | null }>;
  other: Record<string, Record<string, Fp>>;
  businessRows: Record<string, Fp>;
  maxRunId: number;
};
type Call = {
  label: string; business: number; code: number; error: string | null; runId: string | null; bodyBusinessId: number | null;
  brainRequested: boolean | null; brainAllowed: boolean | null; brainInvoked: boolean | null; brainSkipped: string | null;
};

const q1 = async (db: PrismaClient, sql: string, ...p: unknown[]) => (await db.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...p))[0] ?? {};
const num = (v: unknown) => Number(v ?? -1);

async function fp(db: PrismaClient, table: string, where: string, ...p: unknown[]): Promise<Fp> {
  try {
    const r = await q1(db, `SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h FROM "${table}" t ${where}`, ...p);
    return { n: num(r.n), h: String(r.h) };
  } catch {
    // Too large for the statement timeout: fall back to the count (reported as such, never a silent pass).
    const r = await q1(db, `SELECT count(*)::int AS n FROM "${table}" t ${where}`, ...p);
    return { n: num(r.n), h: null };
  }
}
const same = (a?: Fp | null, b?: Fp | null) => !!a && !!b && a.n === b.n && a.h === b.h;

async function enrollment(db: PrismaClient) {
  const def = await q1(db, `SELECT "defaultEnabled" AS d FROM "PlatformFeatureDefinition" WHERE key = $1`, FEATURE);
  const pol = await q1(db, `SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = $1`, FEATURE);
  const rows = await db.$queryRawUnsafe<{ b: number; s: string }[]>(
    `SELECT "businessId" AS b, state::text AS s FROM "BusinessFeatureAccess" WHERE "featureKey" = $1 ORDER BY 1`, FEATURE);
  return {
    defaultEnabled: def.d ?? null, globalEnabled: pol.g ?? null, emergencyDisabled: pol.e ?? null,
    enabled: rows.filter((r) => r.s === "ENABLED").map((r) => r.b),
    overrides: rows.map((r) => `${r.b}:${r.s}`),
  };
}

async function snapshot(db: PrismaClient, businesses: number[]): Promise<Snap> {
  await db.$executeRawUnsafe(`SET statement_timeout = '60s'`);
  const derive: Snap["derive"] = {};
  for (const t of DERIVE_TABLES) {
    const m = await q1(db, `SELECT to_regclass('public."' || $1 || '"') IS NOT NULL AS ex,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='businessId') AS bid`, t);
    if (!m.ex) { derive[t] = { exists: false, hasBusinessId: false, per: {}, others: null }; continue; }
    const per: Record<string, Fp> = {};
    if (m.bid) for (const b of businesses) per[b] = await fp(db, t, `WHERE t."businessId" = $1`, b);
    const others = m.bid
      ? await fp(db, t, `WHERE t."businessId" IS NULL OR NOT (t."businessId" = ANY($1::int[]))`, businesses)
      : await fp(db, t, ``); // no tenant column: the whole table must be explained by the runs
    derive[t] = { exists: true, hasBusinessId: !!m.bid, per, others };
  }
  const tenantTables = (await db.$queryRawUnsafe<{ t: string }[]>(
    `SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x
        ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' AND c.column_name = 'businessId' ORDER BY 1`)).map((r) => r.t)
    .filter((t) => !DERIVE_TABLES.includes(t) && !ACCOUNTED_ELSEWHERE.includes(t));
  const other: Snap["other"] = {};
  for (const t of tenantTables) {
    other[t] = {};
    for (const b of businesses) other[t][b] = await fp(db, t, `WHERE t."businessId" = $1`, b);
  }
  const businessRows: Record<string, Fp> = {};
  for (const b of businesses) businessRows[b] = await fp(db, "Business", `WHERE t.id = $1`, b);
  const maxRunId = num((await q1(db, `SELECT coalesce(max(id), 0)::int AS n FROM "KnowledgeDerivationRun"`)).n);
  return { businesses, derive, other, businessRows, maxRunId };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const phase = arg("--phase");
  const expected = arg("--expected-runtime-user");
  const allowHost = arg("--allow-host") ?? null;
  const businesses = (arg("--businesses") ?? "3,9").split(",").map(Number);
  if (!expected || !["precheck", "snapshot", "verify"].includes(phase ?? "") || businesses.length !== 2 || businesses.some((b) => !Number.isInteger(b) || b <= 0)) {
    console.error("usage: --phase precheck|snapshot|verify --expected-runtime-user <login> [--allow-host h] [--businesses 3,9] ...");
    process.exit(2);
  }
  const [A, B] = businesses;
  let owner: PrismaClient | undefined;
  let runtime: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    runtime = new PrismaClient({ datasourceUrl: assertSafeUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost) });
    await enforceReadOnly(owner, "owner");
    await enforceReadOnly(runtime, "runtime");
    const identity = await verifyRuntimeIdentity(runtime, expected);

    if (phase === "precheck") {
      const e = await enrollment(owner);
      const audit = await owner.$queryRawUnsafe<{ id: number; actor: number | null; target: string | null; at: Date; old: string | null; neu: string | null; allowed: string | null }[]>(
        `SELECT id, "actorUserId" AS actor, "targetId" AS target, "createdAt" AS at, metadata->>'oldState' AS old,
                metadata->>'newState' AS neu, metadata->>'effectiveAllowedAfter' AS allowed
           FROM "PlatformAuditEvent" WHERE action = 'PLATFORM_FEATURE_ACCESS_UPDATED' AND metadata->>'featureKey' = $1 ORDER BY id`, FEATURE);
      // The canonical lifecycle (lib/tenant/business-lifecycle.ts): ACTIVE = no deletion requested, not deleted.
      const lifecycle = await owner.$queryRawUnsafe<{ b: number; active: boolean }[]>(
        `SELECT id AS b, ("deletionRequestedAt" IS NULL AND "deletedAt" IS NULL) AS active FROM "Business" WHERE id = ANY($1::int[]) ORDER BY 1`, businesses);
      await verifyReadOnly(owner, "owner");
      const exact = JSON.stringify([...e.enabled].sort((x, y) => x - y)) === JSON.stringify([A, B].sort((x, y) => x - y));
      const auditFor = (b: number) => audit.filter((a) => a.target === String(b) && a.neu === "ENABLED").map((a) => ({ id: a.id, actorUserId: a.actor, at: a.at, oldState: a.old, newState: a.neu, effectiveAllowedAfter: a.allowed }));
      const pass = exact && e.defaultEnabled === false && e.globalEnabled === false && e.emergencyDisabled === false &&
        auditFor(A).length >= 1 && auditFor(B).length >= 1 && !identity.superuser && !identity.bypassRls &&
        lifecycle.length === 2 && lifecycle.every((l) => l.active);
      console.log(JSON.stringify({ phase, feature: e, exactlyApprovedEnrollment: exact, platformAudit: { [A]: auditFor(A), [B]: auditFor(B), totalForFeature: audit.length },
        lifecycleActive: lifecycle, runtime: identity, pass }, null, 1));
      process.exitCode = pass ? 0 : 1;
      return;
    }

    if (phase === "snapshot") {
      const snap = await snapshot(owner, businesses);
      await verifyReadOnly(owner, "owner");
      writeFileSync(arg("--out") ?? "before.json", JSON.stringify(snap));
      const countOnly = [...Object.entries(snap.derive).flatMap(([t, v]) => [...Object.values(v.per), v.others].some((f) => f && f.h === null) ? [t] : []),
        ...Object.entries(snap.other).flatMap(([t, v]) => Object.values(v).some((f) => f.h === null) ? [t] : [])];
      console.log(JSON.stringify({ phase, deriveTables: Object.keys(snap.derive).length, missing: Object.entries(snap.derive).filter(([, v]) => !v.exists).map(([k]) => k),
        otherTenantTables: Object.keys(snap.other).length, countOnlyFingerprints: countOnly, maxRunId: snap.maxRunId }));
      return;
    }

    // ---- verify ----
    const callerRun = arg("--caller-run") ?? "";
    if (!/^[0-9]{1,20}$/.test(callerRun)) { console.error("--caller-run must be the numeric GitHub run id"); process.exit(2); }
    const before = JSON.parse(readFileSync(arg("--before") ?? "before.json", "utf8")) as Snap;
    const calls = readFileSync(arg("--calls") ?? "calls.jsonl", "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Call);
    const after = await snapshot(owner, businesses);
    const secrets = [process.env.KNOWLEDGE_DERIVE_SECRET, process.env.CRON_SECRET].filter((s): s is string => !!s && s.length >= 8);
    const leaks = (s: string | null | undefined) => secrets.some((x) => (s ?? "").includes(x));
    const failures: string[] = [];

    // LEDGER
    const oks = calls.filter((c) => c.code === 200);
    const runs = await owner.$queryRawUnsafe<{ b: number; runId: string; status: string; fs: string | null; req: boolean; allowed: boolean; invoked: boolean; ref: string | null; fin: boolean; counts: string | null; versions: string | null }[]>(
      `SELECT "businessId" AS b, "runId", status, "failureStage" AS fs, "brainRequested" AS req, "brainAllowed" AS allowed, "brainInvoked" AS invoked,
              "callerRef" AS ref, "finishedAt" IS NOT NULL AS fin, counts::text AS counts, versions::text AS versions
         FROM "KnowledgeDerivationRun" WHERE id > $1 ORDER BY id`, before.maxRunId);
    const stillRunning = num((await q1(owner, `SELECT count(*)::int AS n FROM "KnowledgeDerivationRun" WHERE status = 'RUNNING' AND "businessId" = ANY($1::int[])`, businesses)).n);
    if (runs.length !== oks.length) failures.push(`ledger: ${runs.length} new runs for ${oks.length} successful calls`);
    for (const c of oks) {
      const r = runs.find((x) => x.runId === c.runId);
      if (!r) { failures.push(`ledger: no run for ${c.label}`); continue; }
      if (r.b !== c.business || c.bodyBusinessId !== c.business) failures.push(`ledger: ${c.label} run belongs to ${r.b}, response names ${c.bodyBusinessId}`);
      if (r.status !== "SUCCEEDED" || !r.fin || r.fs !== null) failures.push(`ledger: ${c.label} not terminal SUCCEEDED`);
      if (r.ref !== callerRun) failures.push(`ledger: ${c.label} callerRef mismatch`);
      if (r.invoked !== c.brainInvoked || r.allowed !== c.brainAllowed) failures.push(`ledger: ${c.label} brain flags differ from response`);
    }
    if (stillRunning !== 0) failures.push(`ledger: ${stillRunning} run(s) left RUNNING`);
    if (runs.some((r) => leaks(r.counts) || leaks(r.versions))) failures.push("ledger: secret material in a run row");

    // AUDIT
    const events = await owner.$queryRawUnsafe<{ outcome: string; reason: string | null; bid: number | null; meta: string | null }[]>(
      `SELECT outcome, "reasonClass" AS reason, "businessId" AS bid, metadata::text AS meta FROM "SecurityEvent"
        WHERE "eventType" = 'KNOWLEDGE_DERIVE' AND metadata->>'callerRef' = $1`, callerRun);
    const target = (m: string | null) => { try { return (JSON.parse(m ?? "{}") as { targetBusinessId?: number | null }).targetBusinessId ?? null; } catch { return null; } };
    const got = events.map((e) => e.outcome === "SUCCESS" ? `SUCCESS:${e.bid}` : `${e.outcome}:${e.reason}:${target(e.meta) ?? "-"}:${e.bid ?? "-"}`).sort();
    const want = calls.map((c) => c.code === 200 ? `SUCCESS:${c.business}` : `DENIED:${c.error}:${c.code === 400 || c.code === 401 ? "-" : c.business}:-`).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push("audit: SecurityEvents differ from the calls made");
    const secretsInAudit = events.filter((e) => leaks(e.meta) || leaks(e.reason)).length;
    if (secretsInAudit !== 0) failures.push("audit: secret material in a SecurityEvent");

    // MUTATIONS
    const expectedArtifacts: Record<string, Record<string, { before: number; after: number; changed: boolean }>> = {};
    const crossTenant: string[] = [];
    /** Derive tables with no tenant column (reported, never silently attributed to a tenant). */
    const untenantedChanged: string[] = [];
    const fabricated: string[] = [];
    for (const t of DERIVE_TABLES) {
      const a = before.derive[t], z = after.derive[t];
      if (!z?.exists) continue;
      for (const b of businesses) {
        const x = a.per[b], y = z.per[b];
        if (!x || !y) continue;
        const changed = !same(x, y);
        if (changed) (expectedArtifacts[t] ??= {})[b] = { before: x.n, after: y.n, changed };
        if (changed && MUST_NOT_MOVE.includes(t)) fabricated.push(`${t}#${b}`);
      }
      if (!same(a.others, z.others)) (a.hasBusinessId ? crossTenant : untenantedChanged).push(t);
    }
    const unexpected: string[] = [];
    for (const [t, per] of Object.entries(before.other)) for (const b of businesses) if (!same(per[b], after.other[t]?.[b])) unexpected.push(`${t}#${b}`);
    for (const b of businesses) if (!same(before.businessRows[b], after.businessRows[b])) unexpected.push(`Business#${b}`);
    if (crossTenant.length) failures.push(`mutations: other businesses' rows changed in ${crossTenant.join(",")}`);
    if (unexpected.length) failures.push(`mutations: non-derive tables changed: ${unexpected.join(",")}`);
    if (fabricated.length) failures.push(`mutations: owner-only tables moved: ${fabricated.join(",")}`);

    // TENANT — as the runtime login; set_config(..., true) is not a write.
    const noContextRuns = num((await q1(runtime, `SELECT count(*)::int AS n FROM "KnowledgeDerivationRun"`)).n);
    const runIdsOf = (b: number) => oks.filter((c) => c.business === b).map((c) => c.runId as string);
    const inside = async (b: number) => runtime!.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(b));
      const other = b === A ? B : A;
      const r = await tx.$queryRawUnsafe<{ foreign: number; own: number; otherRuns: number }[]>(
        `SELECT count(*) FILTER (WHERE "businessId" <> $1)::int AS foreign,
                count(*) FILTER (WHERE "runId" = ANY($2::text[]))::int AS own,
                count(*) FILTER (WHERE "runId" = ANY($3::text[]))::int AS "otherRuns" FROM "KnowledgeDerivationRun"`, b, runIdsOf(b), runIdsOf(other));
      const foreignRows: Record<string, number> = {};
      for (const t of ISOLATION) foreignRows[t] = num((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" WHERE "businessId" <> $1`, b))[0]?.n);
      return { foreignRuns: r[0].foreign, ownRunsVisible: r[0].own, ownRunsExpected: runIdsOf(b).length, otherTenantRunsVisible: r[0].otherRuns, foreignRows };
    });
    const tenantA = await inside(A);
    const tenantB = await inside(B);
    const tenantHolds = noContextRuns === 0 && [tenantA, tenantB].every((t) => t.foreignRuns === 0 && t.otherTenantRunsVisible === 0 &&
      t.ownRunsVisible === t.ownRunsExpected && Object.values(t.foreignRows).every((v) => v === 0));
    if (!tenantHolds) failures.push("tenant: runtime visibility did not hold");

    // SCHEMA — live catalog.
    const guard = await q1(owner, `SELECT pg_get_functiondef(p.oid) AS d, t.tgenabled AS en FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid WHERE r.relname = 'KnowledgeDerivationRun' AND NOT t.tgisinternal AND p.proname = 'kdr_run_guard'`);
    const def = String(guard.d ?? "");
    const ownershipGuard = guard.en === "O" && def.includes("KDR_IMMUTABLE") &&
      /to_jsonb\(NEW\)\s*-\s*ARRAY\['status','finishedAt','failureStage','counts','versions','brainInvoked'\]/.test(def) && !/'businessId'/.test(def);
    const upd = await q1(owner, `SELECT qual AS u, with_check AS w FROM pg_policies WHERE tablename = 'KnowledgeDerivationRun' AND cmd = 'UPDATE'`);
    const pin = (s: unknown) => /"businessId"\s*=\s*\(?NULLIF\(current_setting\('app\.current_business_id'/.test(String(s ?? ""));
    const updatePolicyPinned = pin(upd.u) && pin(upd.w);
    const idx = await q1(owner, `SELECT i.indisunique AS u, i.indisvalid AS v, pg_get_indexdef(i.indexrelid) AS d FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'KnowledgeDerivationRun_one_running_key'`);
    const oneRunningIndex = idx.u === true && idx.v === true && /WHERE.*RUNNING/.test(String(idx.d ?? ""));
    if (!ownershipGuard || !updatePolicyPinned || !oneRunningIndex) failures.push("schema: ownership guard / update pin / one-running index not as reviewed");

    // FEATURE
    const e = await enrollment(owner);
    const exact = JSON.stringify([...e.enabled].sort((x, y) => x - y)) === JSON.stringify([A, B].sort((x, y) => x - y));
    if (!exact || e.defaultEnabled !== false || e.globalEnabled !== false || e.emergencyDisabled !== false) failures.push("feature: state is not exactly the approved enrollment");

    await verifyReadOnly(owner, "owner");
    await verifyReadOnly(runtime, "runtime");
    const result = {
      runtime: { user: identity.user, superuser: identity.superuser, bypassRls: identity.bypassRls },
      calls: calls.map((c) => `${c.label}: ${c.code} ${c.error ?? "ok"}`),
      ledger: { newRuns: runs.map((r) => ({ businessId: r.b, runId: r.runId, status: r.status, finished: r.fin, brainRequested: r.req, brainAllowed: r.allowed, brainInvoked: r.invoked, counts: r.counts ? JSON.parse(r.counts) : null })), stillRunning },
      audit: { events: got, expected: want, secretsChecked: secrets.length, secretsInAudit },
      mutations: { expectedArtifacts, crossTenant, untenantedChanged, unexpected, ownerOnlyTablesMoved: fabricated },
      tenant: { noContextRuns, [A]: tenantA, [B]: tenantB, holds: tenantHolds },
      schema: { ownershipGuard, updatePolicyPinned, oneRunningIndex },
      feature: e,
      failures,
    };
    const pass = failures.length === 0 && secrets.length === 2 && !identity.superuser && !identity.bypassRls;
    console.log(JSON.stringify({ ...result, pass }, null, 1));
    process.exitCode = pass ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
    await runtime?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/derive-enrollment-evidence.ts")) void main();
