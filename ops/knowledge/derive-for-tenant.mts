/**
 * M2/M3 · Run the knowledge derivation for ONE tenant, in Production, as the runtime role.
 *
 * WHY THIS EXISTS
 *
 * The rules, the writer and the composer all shipped with M2/M3, and nothing calls them. There is no
 * route, no cron and no queue — by design, because a scheduled derivation is an M4 decision and adding
 * one early would have meant choosing a cadence before knowing what the rules cost.
 *
 * But code that cannot be run cannot be proven. This is the trigger: explicit, one tenant at a time,
 * behind the same `production-db` approval that gates a migration.
 *
 * WHAT MAKES IT A PROOF RATHER THAN A SCRIPT
 *
 * It connects with DATABASE_URL — the RUNTIME credential (`app_runtime_prod`, NOBYPASSRLS) — and
 * MEASURES that posture before doing anything. Running this as the owner role would prove only that
 * the SQL is valid; running it as the restricted role proves the tenant context reaches the database,
 * which is the whole of M0. If the role can bypass RLS, this refuses to run.
 *
 * Output is deliberately opaque: ids, counts, statuses and rule versions. No vendor, no payee, no
 * fact text. The proof is that the pipeline works, not what any business owes anyone.
 *
 *   KNOWLEDGE_BUSINESS_ID=9 npx tsx ops/knowledge/derive-for-tenant.mts
 */
import { PrismaClient } from "@prisma/client";

const businessId = Number(process.env.KNOWLEDGE_BUSINESS_ID);
if (!Number.isInteger(businessId) || businessId <= 0) {
  console.error("KNOWLEDGE_BUSINESS_ID must be a positive integer — this runs for ONE tenant.");
  process.exit(2);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (the runtime credential) is required.");
  process.exit(2);
}

// Posture is measured, never assumed. A run as an owner/BYPASSRLS role would silently prove nothing
// about the tenant context, which is the single thing this is here to demonstrate.
const probe = new PrismaClient({ datasources: { db: { url } } });
const posture = await probe.$queryRawUnsafe<{ u: string; s: boolean; b: boolean }[]>(
  `SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`,
);
const me = posture[0];
console.log(`connected as: ${me?.u} (superuser=${me?.s} bypassrls=${me?.b})`);
if (me?.b !== false || me?.s !== false) {
  console.error("REFUSING: this must run as a NOBYPASSRLS, NOSUPERUSER runtime role, or it proves nothing.");
  await probe.$disconnect();
  process.exit(1);
}
await probe.$disconnect();

const { derivePaperworkLagForBusiness } = await import("../../lib/knowledge/paperwork-lag.service.js");
const { generateInsightsForBusiness, listOpenInsights } = await import("../../lib/knowledge/insight.service.js");

console.log(`\n== M2 · deriving DOC-04 for business ${businessId} ==`);
const measure = await derivePaperworkLagForBusiness(businessId);
if (measure.kind === "failed") {
  console.error(`DERIVATION FAILED at stage=${measure.stage}: ${measure.detail}`);
  process.exit(1);
}
console.log(
  JSON.stringify({
    status: measure.result.status,
    valueNumeric: measure.result.valueNumeric,
    valueUnit: measure.result.valueUnit,
    observationCount: measure.result.observationCount,
    trend: measure.result.trend,
    windowStart: measure.result.windowStart.toISOString(),
    windowEnd: measure.result.windowEnd.toISOString(),
    evidenceRefs: measure.result.evidenceSet.refs.length,
    writerAction: measure.write.action,
    measureId: measure.write.measureId,
  }),
);

console.log(`\n== M3 · composing insights for business ${businessId} ==`);
const generated = await generateInsightsForBusiness(businessId);
console.log(JSON.stringify(generated));

const open = await listOpenInsights(businessId);
console.log(
  JSON.stringify(
    open.map((i) => ({
      id: i.id,
      insightKey: i.insightKey,
      severity: i.severity,
      status: i.status,
      factLineCount: Array.isArray(i.factLines) ? i.factLines.length : 0,
      hasInterpretation: i.interpretation != null,
      hasUncertainty: i.uncertainty != null,
      contributingRules: Array.isArray(i.contributingRules)
        ? (i.contributingRules as { ruleId: string; ruleVersion: string }[]).map(
            (r) => `${r.ruleId}@${r.ruleVersion}`,
          )
        : [],
      composerVersion: i.composerVersion,
    })),
  ),
);

console.log("\nOK");
process.exit(0);
