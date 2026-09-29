/**
 * Derive authority (#575) — PRE-ENROLLMENT Production proof. SCRIPT-ONLY, READ-ONLY, counts, hashes and
 * booleans only. Driven by .github/workflows/prod-derive-preenrollment-proof.yml:
 *
 *   --phase snapshot --out before.json      fingerprint every table the derive pipeline can write
 *   (the workflow then calls the live route: probe → CRON_SECRET → business 3 → business 9)
 *   --phase verify --before before.json --caller-run <GitHub run id> --businesses 3,9
 *
 * A fingerprint is (row count, md5 over every row's full text), per target business and for the whole
 * table, so an UPDATE is caught as surely as an INSERT or a DELETE. Tables only the derive pipeline
 * writes must be unchanged as a whole; tables other product flows also write (learning events, identity,
 * collections) must be unchanged for the target businesses, and a whole-table change is reported.
 *
 * Verify also proves: no KnowledgeDerivationRun was opened (the provider is reachable only inside an
 * admitted run), exactly the expected KNOWLEDGE_DERIVE SecurityEvents carry this caller run id, none of
 * them names a tenant row, none contains either secret (compared in-process, never sent to the database),
 * the feature is still OFF with nobody enrolled, and the runtime (app_runtime_prod, NOSUPERUSER,
 * NOBYPASSRLS) sees zero knowledge rows without a tenant and zero foreign rows inside one.
 *
 * Reuses runtime-rls-evidence.ts's fail-closed preconditions. Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

/** Written only by the derive pipeline: must be unchanged as a whole. */
const DERIVE_EXCLUSIVE = [
  "KnowledgeMeasure", "KnowledgeMeasureEvidenceLink", "TemporalKnowledge", "BusinessInsight",
  "DerivedClaimProjection", "DerivedClaimCandidate", "DerivedClaimEvidenceLink",
  "OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment",
  "KnowledgeDerivationRun",
];
/** Also written by other product flows: must be unchanged for the target businesses. */
const SHARED = ["IdentityLink", "IdentityProposal", "PartyResolutionClaim", "EntityLinkProposal", "CollectionAction", "LearningEvent", "Recommendation"];
/** The route's own isolation set (tenant tables the knowledge layer writes). */
const ISOLATION = [
  "KnowledgeMeasure", "TemporalKnowledge", "BusinessInsight", "PartyResolutionClaim", "EntityLinkProposal", "CollectionAction",
  "LearningEvent", "OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment",
  "KnowledgeDerivationRun",
];

type Fp = { n: number; h: string };
type TableFp = { exists: boolean; hasBusinessId: boolean; whole: Fp | null; perBusiness: Record<string, Fp> };
type Snapshot = { businesses: number[]; tables: Record<string, TableFp>; runs: number; deriveEvents: number };

async function fingerprint(db: PrismaClient, table: string, businesses: number[]): Promise<TableFp> {
  const [meta] = await db.$queryRawUnsafe<{ ex: boolean; bid: boolean }[]>(
    `SELECT to_regclass('public."' || $1 || '"') IS NOT NULL AS ex,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'businessId') AS bid`, table);
  if (!meta.ex) return { exists: false, hasBusinessId: false, whole: null, perBusiness: {} };
  const q = (where: string) => `SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h FROM "${table}" t ${where}`;
  const [whole] = await db.$queryRawUnsafe<Fp[]>(q(""));
  const perBusiness: Record<string, Fp> = {};
  if (meta.bid) for (const b of businesses) [perBusiness[b]] = await db.$queryRawUnsafe<Fp[]>(q(`WHERE t."businessId" = $1`), b);
  return { exists: true, hasBusinessId: meta.bid, whole, perBusiness };
}

async function snapshot(db: PrismaClient, businesses: number[]): Promise<Snapshot> {
  const tables: Record<string, TableFp> = {};
  for (const t of [...DERIVE_EXCLUSIVE, ...SHARED]) tables[t] = await fingerprint(db, t, businesses);
  const runs = Number((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "KnowledgeDerivationRun"`))[0].n);
  const deriveEvents = Number((await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "SecurityEvent" WHERE "eventType" = 'KNOWLEDGE_DERIVE'`))[0].n);
  return { businesses, tables, runs, deriveEvents };
}

const same = (a: Fp | null | undefined, b: Fp | null | undefined) => (a?.n ?? -1) === (b?.n ?? -2) && a?.h === b?.h;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const phase = arg("--phase");
  const expected = arg("--expected-runtime-user");
  const allowHost = arg("--allow-host") ?? null;
  const businesses = (arg("--businesses") ?? "3,9").split(",").map(Number);
  if (!expected || (phase !== "snapshot" && phase !== "verify") || businesses.some((b) => !Number.isInteger(b) || b <= 0)) {
    console.error("usage: --phase snapshot|verify --expected-runtime-user <login> [--allow-host h] [--businesses 3,9] (--out f | --before f --caller-run id)");
    process.exit(2);
  }
  let owner: PrismaClient | undefined;
  let runtime: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    runtime = new PrismaClient({ datasourceUrl: assertSafeUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost) });
    await enforceReadOnly(owner, "owner");
    await enforceReadOnly(runtime, "runtime");
    const identity = await verifyRuntimeIdentity(runtime, expected);

    if (phase === "snapshot") {
      const snap = await snapshot(owner, businesses);
      await verifyReadOnly(owner, "owner");
      writeFileSync(arg("--out") ?? "before.json", JSON.stringify(snap));
      const missing = Object.entries(snap.tables).filter(([, v]) => !v.exists).map(([k]) => k);
      console.log(JSON.stringify({ phase, tables: Object.keys(snap.tables).length, missingTables: missing, runs: snap.runs, deriveEvents: snap.deriveEvents }));
      return;
    }

    const callerRun = arg("--caller-run") ?? "";
    if (!/^[0-9]{1,20}$/.test(callerRun)) { console.error("--caller-run must be the numeric GitHub run id"); process.exit(2); }
    const before = JSON.parse(readFileSync(arg("--before") ?? "before.json", "utf8")) as Snapshot;
    const after = await snapshot(owner, businesses);

    // 1. Zero mutation.
    const changedForTargets: string[] = [];
    const changedWholeExclusive: string[] = [];
    const changedWholeShared: string[] = [];
    for (const t of [...DERIVE_EXCLUSIVE, ...SHARED]) {
      const a = before.tables[t], b = after.tables[t];
      if (a.exists !== b.exists) { changedWholeExclusive.push(t); continue; }
      if (!b.exists) continue;
      for (const bid of businesses) if (b.hasBusinessId && !same(a.perBusiness[bid], b.perBusiness[bid])) changedForTargets.push(`${t}#${bid}`);
      if (!same(a.whole, b.whole)) (DERIVE_EXCLUSIVE.includes(t) ? changedWholeExclusive : changedWholeShared).push(t);
    }
    const perTarget = Object.fromEntries(businesses.map((bid) => [bid, Object.fromEntries(
      ["KnowledgeMeasure", "TemporalKnowledge", "DerivedClaimProjection", "BusinessInsight", "IdentityProposal", "IdentityLink", "OutcomeRecommendation", "KnowledgeDerivationRun"]
        .map((t) => [t, after.tables[t]?.perBusiness[bid]?.n ?? null]))]));

    // 2. Security events carrying this caller run id.
    const events = await owner.$queryRawUnsafe<{ outcome: string; reason: string | null; bid: number | null; actor: string; route: string | null; meta: string | null }[]>(
      `SELECT outcome, "reasonClass" AS reason, "businessId" AS bid, "actorKind" AS actor, route, metadata::text AS meta
         FROM "SecurityEvent" WHERE "eventType" = 'KNOWLEDGE_DERIVE' AND metadata->>'callerRef' = $1 ORDER BY "occurredAt"`, callerRun);
    const targetOf = (m: string | null) => { try { return (JSON.parse(m ?? "{}") as { targetBusinessId?: number | null }).targetBusinessId ?? null; } catch { return null; } };
    const reasons = events.map((e) => `${e.outcome}:${e.reason}:${targetOf(e.meta) ?? "-"}`).sort();
    const expectedReasons = ["DENIED:invalid_business:-", "DENIED:unauthorized:-", ...businesses.map((b) => `DENIED:not_enrolled:${b}`)].sort();
    const eventsNameNoTenantRow = events.every((e) => e.bid === null);
    const secrets = [process.env.KNOWLEDGE_DERIVE_SECRET, process.env.CRON_SECRET].filter((s): s is string => !!s && s.length >= 8);
    const secretsInAudit = events.filter((e) => secrets.some((s) => (e.meta ?? "").includes(s) || (e.reason ?? "").includes(s))).length;

    // 3. Feature still OFF, nobody enrolled.
    const [def] = await owner.$queryRawUnsafe<{ d: boolean }[]>(`SELECT "defaultEnabled" AS d FROM "PlatformFeatureDefinition" WHERE key = 'knowledge_derivation'`);
    const [pol] = await owner.$queryRawUnsafe<{ g: boolean; e: boolean }[]>(`SELECT "globalEnabled" AS g, "emergencyDisabled" AS e FROM "PlatformFeaturePolicy" WHERE "featureKey" = 'knowledge_derivation'`);
    const enrolled = Number((await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'knowledge_derivation' AND state = 'ENABLED'`))[0].n);

    // 4. Tenant isolation as the runtime login (set_config(..., true) is not a write).
    const noContext: Record<string, number> = {};
    const foreignInside: Record<string, number> = {};
    for (const t of ISOLATION) {
      noContext[t] = Number((await runtime.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n);
      foreignInside[t] = await runtime.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businesses[0]));
        return Number((await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}" WHERE "businessId" <> $1`, businesses[0]))[0].n);
      });
    }
    await verifyReadOnly(owner, "owner");
    await verifyReadOnly(runtime, "runtime");

    const isolationHolds = Object.values(noContext).every((v) => v === 0) && Object.values(foreignInside).every((v) => v === 0);
    const newRuns = after.runs - before.runs;
    const result = {
      runtime: { user: identity.user, superuser: identity.superuser, bypassRls: identity.bypassRls },
      mutation: { changedForTargets, changedWholeExclusive, changedWholeSharedElsewhere: changedWholeShared, newDerivationRuns: newRuns, perTargetRowCounts: perTarget },
      audit: { eventsForThisRun: events.length, reasons, expectedReasons, eventsNameNoTenantRow, actorKinds: [...new Set(events.map((e) => e.actor))],
        routes: [...new Set(events.map((e) => e.route))], secretsChecked: secrets.length, secretsInAudit, totalDeriveEventsDelta: after.deriveEvents - before.deriveEvents },
      feature: { defaultEnabled: def?.d ?? null, globalEnabled: pol?.g ?? null, emergencyDisabled: pol?.e ?? null, enrolled },
      isolation: { holds: isolationHolds, runtimeVisibleWithoutTenant: noContext, runtimeVisibleForeignInsideTenant: foreignInside },
    };
    const pass = changedForTargets.length === 0 && changedWholeExclusive.length === 0 && newRuns === 0 &&
      JSON.stringify(reasons) === JSON.stringify(expectedReasons) && eventsNameNoTenantRow && secrets.length === 2 && secretsInAudit === 0 &&
      def?.d === false && pol?.g === false && enrolled === 0 && isolationHolds && !identity.superuser && !identity.bypassRls;
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

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/derive-preenrollment-evidence.ts")) void main();
