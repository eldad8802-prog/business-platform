/**
 * Business Brain — READ-ONLY Production proof of bks.v2 and brain-context.v3 for the enrolled proof businesses.
 *
 *   OWNER_DATABASE_URL=… RUNTIME_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/business-brain-proof.ts \
 *     --allow-host ep-flat-brook-am4bhq1y --runtime-user app_runtime_prod --businesses 3,9 --since <ISO>
 *
 * Builds the REAL snapshot and the REAL Brain context in-process — exactly the code the derive route runs —
 * as the least-privilege runtime login (verified NOSUPERUSER + NOBYPASSRLS), inside a session Postgres
 * itself holds READ ONLY. No model is called. A second, owner session (also READ ONLY) verifies every
 * item against the database. Output: counts, codes, booleans — never a value, name, amount or entity id.
 *
 * Per business:
 *   VERSION      the snapshot is bks.v2, the context brain-context.v3, for exactly this business
 *   TEMPORAL     the latest derivation run after --since ran every temporal rule ok; every TEMPORAL_STATE
 *                names temporal rows that exist and belong to this business
 *   MEMORY       every HISTORICAL_MEASURE / PREVIOUS_BASELINE is never fresh, carries NOT_CURRENT_KNOWLEDGE,
 *                and points at a row of this business in the state it claims (STALE / SUPERSEDED)
 *   LINKS        every RECORD_LINK subject (customer, supplier, item, service) is a record of this business
 *   FINDINGS     every cross-domain finding is non-causal (flag and words), has premises, never rests on
 *                memory, and its knowledge premises resolve to rows of this business
 *   PRIVACY      no linked counterparty's name appears in the snapshot; in the Brain context every subject is
 *                an alias, no money-shaped fact exists, and relationships are not serialized
 *
 * Exit: 0 PASS · 1 FAIL · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly, verifyRuntimeIdentity } from "./runtime-rls-evidence";

const CAUSAL = /\b(because|caused|due to|led to|result(?:s|ed)? in|driven by|thanks to|improved|effect)\b/i;
const MONEY_FACT = /amount|outstanding|unpaid|total|price|cost|charge|sum/i;
const SUBJECT_TABLE: Record<string, string> = { customer: "Customer", supplier: "Supplier", "inventory-item": "InventoryItem", "business-service": "BusinessService" };

type Check = { name: string; pass: boolean; detail?: unknown };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const allowHost = arg("--allow-host") ?? null;
  const runtimeUser = arg("--runtime-user") ?? "";
  const businesses = (arg("--businesses") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const since = new Date(arg("--since") ?? "");
  if (!runtimeUser || businesses.length === 0 || Number.isNaN(since.getTime())) {
    console.error("usage: --allow-host <host> --runtime-user <role> --businesses 3,9 --since <ISO>");
    process.exit(2);
  }
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass, detail });
  let owner: PrismaClient | undefined;
  let rt: PrismaClient | undefined;
  try {
    owner = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    rt = new PrismaClient({ datasourceUrl: assertSafeUrl("RUNTIME_DATABASE_URL", process.env.RUNTIME_DATABASE_URL, allowHost) });
    await enforceReadOnly(owner, "owner");
    await enforceReadOnly(rt, "runtime");
    const id = await verifyRuntimeIdentity(rt, runtimeUser);
    check("runtime login is NOSUPERUSER + NOBYPASSRLS", !id.superuser && !id.bypassRls);
    // The application's own code paths use THIS read-only runtime client (the prisma singleton honours a pre-set global).
    (globalThis as unknown as { prisma: PrismaClient }).prisma = rt;
    const { buildBusinessKnowledgeSnapshot } = await import("@/lib/knowledge/snapshot/build-snapshot");
    const { buildBrainContext } = await import("@/lib/knowledge/brain/context-builder");
    const { temporalCatalogue } = await import("@/lib/knowledge/temporal/rules");
    const temporalRules = temporalCatalogue().length;
    const q = <T>(sql: string, ...p: unknown[]) => owner!.$queryRawUnsafe<T[]>(sql, ...p);
    const report: Record<string, unknown> = { temporalRules };

    for (const b of businesses) {
      const out: Record<string, unknown> = {};
      const snap = await buildBusinessKnowledgeSnapshot(b, {});
      const { context } = buildBrainContext(snap);
      check(`B${b}: snapshot bks.v2 for exactly this business; context brain-context.v3`,
        snap.contractVersion === "bks.v2" && snap.businessId === b && context.contextVersion === "brain-context.v3");

      const [run] = await q<{ counts: Record<string, number> | null }>(
        `SELECT counts FROM "KnowledgeDerivationRun" WHERE "businessId" = $1 AND "startedAt" >= $2 AND status = 'SUCCEEDED' ORDER BY "startedAt" DESC LIMIT 1`, b, since);
      check(`B${b}: latest derivation after --since ran every temporal rule ok (${temporalRules})`, run?.counts?.temporalRulesOk === temporalRules, run?.counts?.temporalRulesOk);

      const kinds = snap.knowledge.reduce<Record<string, number>>((a, k) => ({ ...a, [k.kind]: (a[k.kind] ?? 0) + 1 }), {});
      const states = snap.knowledge.filter((k) => k.kind === "TEMPORAL_STATE");
      out.knowledgeByKind = kinds;
      out.temporalStates = states.reduce<Record<string, number>>((a, k) => ({ ...a, [String((k.value as { state?: string }).state)]: (a[String((k.value as { state?: string }).state)] ?? 0) + 1 }), {});

      // TEMPORAL — provenance rows exist and are this business's
      const tIds = [...new Set(states.flatMap((s) => s.provenance.map((p) => Number(p.id))))];
      const tRows = tIds.length === 0 ? [] : await q<{ id: number; b: number }>(`SELECT id, "businessId" AS b FROM "TemporalKnowledge" WHERE id = ANY($1)`, tIds);
      check(`B${b}: every temporal state names temporal rows of this business`, tRows.length === tIds.length && tRows.every((r) => Number(r.b) === b), { named: tIds.length, found: tRows.length });

      // MEMORY
      const memory = snap.knowledge.filter((k) => k.kind === "HISTORICAL_MEASURE" || k.kind === "PREVIOUS_BASELINE");
      let memBad = 0;
      for (const m of memory) {
        if (m.freshness.fresh || !m.caveats.includes("NOT_CURRENT_KNOWLEDGE")) { memBad += 1; continue; }
        const p = m.provenance[0];
        const table = p.store === "KnowledgeMeasure" ? "KnowledgeMeasure" : "TemporalKnowledge";
        const [r] = await q<{ b: number; status: string }>(`SELECT "businessId" AS b, status::text AS status FROM "${table}" WHERE id = $1`, Number(p.id));
        const claimed = m.kind === "PREVIOUS_BASELINE" ? "SUPERSEDED" : String((m.value as { historicalState?: string }).historicalState);
        if (!r || Number(r.b) !== b || r.status !== claimed) memBad += 1;
      }
      out.memory = { items: memory.length, violations: memBad };
      check(`B${b}: memory is never fresh, labelled NOT_CURRENT_KNOWLEDGE, and true to its row`, memBad === 0, memBad);

      // LINKS
      const links = snap.relationships.filter((r) => r.type === "RECORD_LINK");
      let foreignSubjects = 0;
      const names: string[] = [];
      const byTable = new Map<string, Set<number>>();
      for (const l of links) for (const s of [l.left, l.right]) {
        const t = SUBJECT_TABLE[s.type];
        if (t) byTable.set(t, (byTable.get(t) ?? new Set()).add(Number(s.id)));
      }
      for (const [t, ids] of byTable) {
        const rows = await q<{ id: number; b: number; nm: string | null }>(
          `SELECT id, "businessId" AS b, ${t === "Customer" || t === "Supplier" || t === "InventoryItem" || t === "BusinessService" ? "name" : "NULL"} AS nm FROM "${t}" WHERE id = ANY($1)`, [...ids]);
        foreignSubjects += ids.size - rows.filter((r) => Number(r.b) === b).length;
        for (const r of rows) if (r.nm && r.nm.length >= 4) names.push(r.nm);
      }
      out.recordLinks = links.length;
      check(`B${b}: every record-link subject is a record of this business`, foreignSubjects === 0, foreignSubjects);

      // FINDINGS
      let findBad = 0;
      const premiseKnowledge: number[] = [];
      for (const f of snap.crossDomainFindings) {
        if (f.causal !== false || CAUSAL.test(f.establishes) || f.premises.length === 0) findBad += 1;
        if (f.premises.some((p) => p.slot.startsWith("hist|") || p.slot.startsWith("prevbase|"))) findBad += 1;
        for (const p of f.premises) for (const r of p.provenance) if (r.store === "KnowledgeMeasure") premiseKnowledge.push(Number(r.id));
      }
      const pk = [...new Set(premiseKnowledge)];
      const pkRows = pk.length === 0 ? [] : await q<{ id: number; b: number }>(`SELECT id, "businessId" AS b FROM "KnowledgeMeasure" WHERE id = ANY($1)`, pk);
      out.findings = snap.crossDomainFindings.reduce<Record<string, number>>((a, f) => ({ ...a, [f.ruleId]: (a[f.ruleId] ?? 0) + 1 }), {});
      check(`B${b}: every finding is non-causal, premised, never on memory`, findBad === 0, findBad);
      check(`B${b}: finding premises resolve to measures of this business`, pkRows.length === pk.length && pkRows.every((r) => Number(r.b) === b));

      // PRIVACY
      const snapText = JSON.stringify(snap);
      check(`B${b}: no linked counterparty name appears in the snapshot`, !names.some((n) => snapText.includes(n)));
      const ctxText = JSON.stringify(context);
      const moneyFacts = [...context.knowledge.map((k) => k.facts), ...context.findings.map((f) => f.facts)]
        .flatMap((f) => Object.keys(f)).filter((k) => MONEY_FACT.test(k)).length;
      check(`B${b}: Brain context — aliased subjects, no money-shaped fact, no relationships, no names`,
        context.knowledge.every((k) => k.subject === null || /^S\d+$/.test(k.subject)) && moneyFacts === 0
          && !("relationships" in context) && !names.some((n) => ctxText.includes(n)), { moneyFacts });
      out.brainContext = { knowledge: context.knowledge.length, findings: context.findings.length, omitted: context.omitted };
      report[`B${b}`] = out;
    }
    await verifyReadOnly(owner, "owner");
    await verifyReadOnly(rt, "runtime");
    console.log(JSON.stringify(report, null, 1));
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || c.detail === undefined ? "" : `  (${JSON.stringify(c.detail)})`}`);
    const failed = checks.filter((c) => !c.pass).length;
    console.log(failed === 0 ? `\nBUSINESS BRAIN PRODUCTION PROOF: PASS (${checks.length} checks)` : `\nBUSINESS BRAIN PRODUCTION PROOF: FAIL (${failed} of ${checks.length})`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await owner?.$disconnect();
    await rt?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/business-brain-proof.ts")) void main();
