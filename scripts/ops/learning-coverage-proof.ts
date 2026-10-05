/**
 * All-Feature Learning Coverage — READ-ONLY Production proof for the enrolled proof businesses.
 *
 *   OWNER_DATABASE_URL=… node_modules/.bin/tsx scripts/ops/learning-coverage-proof.ts \
 *     --allow-host ep-flat-brook-am4bhq1y --businesses 3,9 --since 2026-10-05T00:00:00Z
 *
 * Runs AFTER the two real derivations (knowledge-derive.yml, one per business). It changes nothing: one
 * owner session, READ ONLY by Postgres (verified before and after). It reads only the business's own
 * knowledge rows and the records their evidence points at, and prints COUNTS, CODES and BOOLEANS — no
 * value, no name, no amount, no entity id (this log is as public as the repository).
 *
 * Per business, against its latest SUCCEEDED derivation run started after --since:
 *   RUN          status SUCCEEDED, rulesFailed 0, rulesOk = catalogue size, temporalRulesOk = temporal size
 *   LINEAGES     the 33 coverage lineages exist with v1; every coverage measure is pinned to its rule's v1
 *   MEASURES     per coverage rule: rows by status (no rows = no subject yet, a valid result)
 *   TEMPORAL     per coverage temporal rule: rows by status (INSUFFICIENT_HISTORY is a valid result)
 *   PROVENANCE   every evidence link of a coverage measure / temporal artifact: kind mapped to its table,
 *                record exists, record and link belong to the measure's business. Violations must be 0.
 *   CUSTOMER     customer-keyed measures point at a Customer of the same business (the FK, nothing else);
 *                no measure or temporal detail carries a phone / email / tax-id key
 *   SYNTHETIC    no source record of the coverage domains was created inside the derivation run window
 *   EXISTING     the pre-coverage rules still have their measures, pinned to registered lineages
 *   BRAIN        run row: brain requested / allowed / invoked, accepted count, prompt version
 *
 * Exit: 0 PASS · 1 FAIL (any check false) · 3 REFUSED · 2 usage.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeUrl, enforceReadOnly, RefusedError, verifyReadOnly } from "./runtime-rls-evidence";
import { catalogueDescriptors } from "@/lib/knowledge/registry";
import { temporalCatalogue } from "@/lib/knowledge/temporal/rules";
import { COVERAGE_DOMAINS, COVERAGE_EVIDENCE_STORES } from "@/lib/knowledge/coverage/evidence-kinds";

const NEW_RULE = /^(BILL|CUST|PAY|COLL|LEAD|CONV|APPT|SEC|OFF|REP)-/;
const NEW_TEMPORAL = /^T-(BILL|CUST|PAY|LEAD|CONV|APPT)-/;
/** Source tables of the coverage domains — none may gain a row inside a proof derivation window. */
const SOURCE_TABLES = ["BillingDocument", "PaymentRequest", "CollectionAction", "Lead", "LeadLifecycleEvent", "Conversation",
  "Message", "Appointment", "BusinessObligation", "OfferingDemandSignal", "Customer"];
const PII_KEYS = /"(phone|phoneNumber|email|emailAddress|taxId|tax_id|vatNumber|idNumber)"\s*:/i;

type Check = { name: string; pass: boolean; detail?: unknown };

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const allowHost = arg("--allow-host") ?? null;
  const businesses = (arg("--businesses") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const since = new Date(arg("--since") ?? "");
  if (businesses.length === 0 || Number.isNaN(since.getTime())) {
    console.error("usage: --allow-host <host> --businesses 3,9 --since <ISO instant>");
    process.exit(2);
  }

  const rules = catalogueDescriptors();
  const temporal = temporalCatalogue();
  const covRules = rules.filter((d) => NEW_RULE.test(d.ruleId));
  const covTemporal = temporal.filter((t) => NEW_TEMPORAL.test(t.ruleId));
  const oldRules = rules.filter((d) => !NEW_RULE.test(d.ruleId));
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass, detail });
  const report: Record<string, unknown> = {
    catalogue: { rules: rules.length, temporal: temporal.length, coverageRules: covRules.length, coverageTemporal: covTemporal.length },
  };
  check("catalogue: 26 coverage rules and 7 coverage temporal rules", covRules.length === 26 && covTemporal.length === 7);

  let db: PrismaClient | undefined;
  try {
    db = new PrismaClient({ datasourceUrl: assertSafeUrl("OWNER_DATABASE_URL", process.env.OWNER_DATABASE_URL, allowHost) });
    await enforceReadOnly(db, "owner");
    const q = <T>(sql: string, ...p: unknown[]) => db!.$queryRawUnsafe<T[]>(sql, ...p);

    /* LINEAGES (global) */
    const covKeys = [...covRules.map((d) => d.policyKey), ...covTemporal.map((t) => t.policyKey)];
    const lineage = await q<{ key: string; v1: boolean }>(
      `SELECT p.key, bool_or(v.version = 'v1') AS v1 FROM "DerivationPolicy" p LEFT JOIN "DerivationPolicyVersion" v ON v."policyId" = p.id
        WHERE p.key = ANY($1) GROUP BY p.key`, covKeys);
    check("lineages: all 33 coverage lineages exist with v1", lineage.length === 33 && lineage.every((l) => l.v1), { found: lineage.length });

    const perBusiness: Record<string, unknown> = {};
    for (const b of businesses) {
      const out: Record<string, unknown> = {};
      /* RUN */
      const [run] = await q<{ runId: string; status: string; startedAt: Date; finishedAt: Date | null; counts: Record<string, number> | null;
        versions: Record<string, string> | null; brainRequested: boolean; brainAllowed: boolean; brainInvoked: boolean }>(
        `SELECT "runId", status, "startedAt", "finishedAt", counts, versions, "brainRequested", "brainAllowed", "brainInvoked"
           FROM "KnowledgeDerivationRun" WHERE "businessId" = $1 AND "startedAt" >= $2 AND status = 'SUCCEEDED'
          ORDER BY "startedAt" DESC LIMIT 1`, b, since);
      if (!run || !run.finishedAt) { check(`B${b}: a SUCCEEDED derivation run after --since exists`, false); perBusiness[`B${b}`] = { run: null }; continue; }
      const c = run.counts ?? {};
      out.run = { status: run.status, rulesOk: c.rulesOk, rulesFailed: c.rulesFailed, temporalRulesOk: c.temporalRulesOk, measuresActive: c.measuresActive,
        snapshotKnowledge: c.snapshotKnowledge, insights: c.insights };
      check(`B${b}: run SUCCEEDED, rulesFailed = 0`, c.rulesFailed === 0);
      check(`B${b}: every measure rule ran ok (${rules.length})`, c.rulesOk === rules.length, c.rulesOk);
      check(`B${b}: every temporal rule ran ok (${temporal.length})`, c.temporalRulesOk === temporal.length, c.temporalRulesOk);
      out.brain = { requested: run.brainRequested, allowed: run.brainAllowed, invoked: run.brainInvoked, accepted: c.brainAccepted ?? 0,
        promptVersion: run.versions?.brainPrompt ?? null };

      /* MEASURES */
      const measures = await q<{ id: number; measureKey: string; status: string; entityType: string | null; entityId: number | null; pkey: string; ver: string; pii: boolean }>(
        `SELECT m.id, m."measureKey", m.status::text AS status, m."entityType", m."entityId", p.key AS pkey, v.version AS ver,
                (m.detail::text ~* $2) AS pii
           FROM "KnowledgeMeasure" m JOIN "DerivationPolicyVersion" v ON v.id = m."rulePolicyVersionId" JOIN "DerivationPolicy" p ON p.id = v."policyId"
          WHERE m."businessId" = $1`, b, PII_KEYS.source);
      const byRule: Record<string, Record<string, number>> = {};
      let pinnedWrong = 0;
      for (const d of covRules) {
        const rows = measures.filter((m) => m.measureKey === d.measureKey);
        byRule[d.ruleId] = rows.reduce<Record<string, number>>((a, m) => ({ ...a, [m.status]: (a[m.status] ?? 0) + 1 }), {});
        pinnedWrong += rows.filter((m) => m.pkey !== d.policyKey || m.ver !== d.versionLabel).length;
      }
      out.coverageMeasures = byRule;
      out.coverageRulesWithRows = Object.values(byRule).filter((s) => Object.keys(s).length > 0).length;
      check(`B${b}: every coverage measure is pinned to its rule's lineage and version`, pinnedWrong === 0, pinnedWrong);

      /* TEMPORAL */
      const temporalRows = await q<{ id: number; temporalKey: string; status: string; refs: { kind: string; id: number }[]; pii: boolean }>(
        `SELECT id, "temporalKey", status::text AS status, "evidenceRefs" AS refs,
                (coalesce(baseline::text,'') || coalesce(recent::text,'') || coalesce(finding::text,'')) ~* $2 AS pii
           FROM "TemporalKnowledge" WHERE "businessId" = $1 AND "supersededAt" IS NULL`, b, PII_KEYS.source);
      const covT = temporalRows.filter((t) => covTemporal.some((r) => r.temporalKey === t.temporalKey));
      out.coverageTemporal = Object.fromEntries(covTemporal.map((r) => [r.ruleId,
        covT.filter((t) => t.temporalKey === r.temporalKey).reduce<Record<string, number>>((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {})]));

      /* PROVENANCE */
      const covMeasureIds = measures.filter((m) => covRules.some((d) => d.measureKey === m.measureKey)).map((m) => m.id);
      const links = covMeasureIds.length === 0 ? [] : await q<{ measureId: number; businessId: number; kind: string; rid: number }>(
        `SELECT "measureId", "businessId", "evidenceKind" AS kind, "evidenceRecordId" AS rid FROM "KnowledgeMeasureEvidenceLink" WHERE "measureId" = ANY($1)`, covMeasureIds);
      const refs = [...links.map((l) => ({ kind: l.kind, id: l.rid, linkBusiness: Number(l.businessId) })),
        ...covT.flatMap((t) => (Array.isArray(t.refs) ? t.refs : []).map((r) => ({ kind: r.kind, id: r.id, linkBusiness: b })))];
      let unmapped = 0, missing = 0, foreign = 0;
      const byStore = new Map<string, Set<number>>();
      for (const r of refs) {
        const store = COVERAGE_EVIDENCE_STORES[r.kind];
        if (!store) { unmapped += 1; continue; }
        if (r.linkBusiness !== b) foreign += 1;
        byStore.set(store, (byStore.get(store) ?? new Set()).add(r.id));
      }
      for (const [store, ids] of byStore) {
        const found = await q<{ id: number; b: number }>(`SELECT id, "businessId" AS b FROM "${store}" WHERE id = ANY($1)`, [...ids]);
        missing += ids.size - found.length;
        foreign += found.filter((f) => Number(f.b) !== b).length;
      }
      out.provenance = { links: links.length, temporalRefs: refs.length - links.length, unmapped, missing, foreign };
      check(`B${b}: provenance — every coverage evidence kind maps to a table`, unmapped === 0, unmapped);
      check(`B${b}: provenance — every referenced record exists`, missing === 0, missing);
      check(`B${b}: cross-tenant leakage — 0 evidence from another business`, foreign === 0, foreign);

      /* CUSTOMER */
      const custIds = [...new Set(measures.filter((m) => m.entityType === "customer").map((m) => Number(m.entityId)))];
      const custFound = custIds.length === 0 ? [] : await q<{ id: number; b: number }>(`SELECT id, "businessId" AS b FROM "Customer" WHERE id = ANY($1)`, custIds);
      out.customer = { customerSubjects: custIds.length };
      check(`B${b}: customer subjects are Customers of this business (customerId FK only)`,
        custFound.length === custIds.length && custFound.every((x) => Number(x.b) === b));
      check(`B${b}: no phone / email / tax-id key in any measure or temporal detail`,
        !measures.some((m) => m.pii) && !temporalRows.some((t) => t.pii));

      /* SYNTHETIC */
      let createdInWindow = 0;
      for (const t of SOURCE_TABLES) {
        const col = t === "CollectionAction" ? "occurredAt" : "createdAt"; // CollectionAction is append-only and timed by occurredAt
        const [n] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}" WHERE "businessId" = $1 AND "${col}" BETWEEN $2 AND $3`, b, run.startedAt, run.finishedAt);
        createdInWindow += n?.n ?? 0;
      }
      out.sourceRowsCreatedDuringRun = createdInWindow;
      check(`B${b}: synthetic data — 0 source records created during the derivation`, createdInWindow === 0, createdInWindow);

      /* EXISTING */
      const oldWithRows = oldRules.filter((d) => measures.some((m) => m.measureKey === d.measureKey)).length;
      const oldPinnedWrong = measures.filter((m) => oldRules.some((d) => d.measureKey === m.measureKey && d.policyKey !== m.pkey)).length;
      out.existing = { preCoverageRules: oldRules.length, withRows: oldWithRows };
      check(`B${b}: existing learning — pre-coverage measures stay pinned to their own lineages`, oldPinnedWrong === 0, oldPinnedWrong);

      perBusiness[`B${b}`] = out;
    }
    report.businesses = perBusiness;
    report.coverageDomains = COVERAGE_DOMAINS;
    await verifyReadOnly(db, "owner");

    console.log(JSON.stringify(report, null, 1));
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || c.detail === undefined ? "" : `  (${JSON.stringify(c.detail)})`}`);
    const failed = checks.filter((c) => !c.pass).length;
    console.log(failed === 0 ? `\nLEARNING COVERAGE PRODUCTION PROOF: PASS (${checks.length} checks)` : `\nLEARNING COVERAGE PRODUCTION PROOF: FAIL (${failed} of ${checks.length})`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    if (e instanceof RefusedError) { console.error(`REFUSED: ${e.message}`); process.exitCode = 3; }
    else { console.error(`FAILED: ${e instanceof Error ? e.name : "unknown"} ${(e as { code?: string })?.code ?? ""}`); process.exitCode = 1; }
  } finally {
    await db?.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops/learning-coverage-proof.ts")) void main();
