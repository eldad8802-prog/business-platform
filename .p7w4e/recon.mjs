/**
 * D2 / P7-W4E — READ-ONLY Preview reconnaissance.
 *
 * Answers the questions W4E's architecture depends on, from the live Preview
 * substrate rather than from memory:
 *   - exact table membership of every existing policy family (incl. the P4-B
 *     pilot, which is applied out-of-band and named nowhere in the repo)
 *   - which W4E candidates already carry a policy (never double-protect)
 *   - runtime + admin grant posture on every W4E candidate
 *   - whether the pre-context provider->PaymentRequest resolution read can
 *     work at all under the pilot's FORCE RLS (the load-bearing question)
 *   - schema presence of W4E-relevant tables (Preview catch-up planning)
 *
 * ZERO writes. ZERO DDL. ZERO provider calls.
 */
import { PrismaClient } from "@prisma/client";

const DENY = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];
const CANDIDATES = [
  "PaymentRequest", "PaymentTransaction", "PaymentAuditEvent",
  "BusinessPaymentConnection", "FinancialEvent", "PaymentWebhookEvent",
  "BillingDocument", "BillingDocumentLine", "BillingReceiptPayment",
  "BillingPaymentAllocation", "BillingDocumentNumberSequence",
  "BillingAuditEvent", "BillingAuthorityConnection", "BillingAuthoritySubmission",
  "BusinessBot", "BusinessBotSettings", "BusinessFeatureAccess",
  "ProductUsageEvent", "Offer", "Coupon", "RedemptionEvent",
];

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  for (const bad of DENY) {
    if (OWNER_URL.includes(bad)) throw new Error("DENY: forbidden endpoint");
  }
  if (!OWNER_URL.includes("ep-wispy-dawn-amr74bwz")) {
    throw new Error("DENY: not the approved Preview endpoint");
  }
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });

  console.log("=== 1. policy families (name -> tables) ===");
  const pols = await owner.$queryRawUnsafe(
    `SELECT policyname, tablename FROM pg_policies ORDER BY policyname, tablename`);
  const byName = {};
  for (const p of pols) (byName[p.policyname] ??= []).push(p.tablename);
  for (const [name, tables] of Object.entries(byName)) {
    console.log(`  ${name} (${tables.length}): ${tables.join(", ")}`);
  }

  console.log("\n=== 2. W4E candidates: policy + RLS posture ===");
  const rls = await owner.$queryRawUnsafe(
    `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
       FROM pg_class WHERE relname IN (${CANDIDATES.map((t) => `'${t}'`).join(",")})`);
  const rlsBy = Object.fromEntries(rls.map((r) => [r.relname, r]));
  for (const t of CANDIDATES) {
    const owning = Object.entries(byName)
      .filter(([, tables]) => tables.includes(t)).map(([n]) => n);
    const r = rlsBy[t];
    console.log(`  ${t.padEnd(30)} exists=${r ? "yes" : "NO"} rls=${r?.enabled ?? "-"} force=${r?.forced ?? "-"} policies=[${owning.join(",") || "none"}]`);
  }

  console.log("\n=== 3. grants (runtime app_runtime_preview_p4b / group app_admin) ===");
  for (const t of CANDIDATES) {
    if (!rlsBy[t]) continue;
    const g = (await owner.$queryRawUnsafe(
      `SELECT
         has_table_privilege('app_runtime_preview_p4b', '"${t}"', 'SELECT') AS rs,
         has_table_privilege('app_runtime_preview_p4b', '"${t}"', 'INSERT') AS ri,
         has_table_privilege('app_runtime_preview_p4b', '"${t}"', 'UPDATE') AS ru,
         has_table_privilege('app_runtime_preview_p4b', '"${t}"', 'DELETE') AS rd,
         has_table_privilege('app_admin', '"${t}"', 'SELECT') AS as_`))[0];
    console.log(`  ${t.padEnd(30)} runtime S=${+g.rs} I=${+g.ri} U=${+g.ru} D=${+g.rd} | admin S=${+g.as_}`);
  }

  console.log("\n=== 4. LOAD-BEARING: can the webhook resolve a tenant pre-context? ===");
  // The provider callback looks up PaymentRequest by (provider, providerRequestId)
  // BEFORE any businessId is known. If PaymentRequest is FORCE-RLS'd, that read
  // returns 0 rows without a GUC and the callback can never resolve its tenant.
  const prPosture = rlsBy["PaymentRequest"];
  const prPolicies = Object.entries(byName)
    .filter(([, t]) => t.includes("PaymentRequest")).map(([n]) => n);
  console.log(`  PaymentRequest rls=${prPosture?.enabled} force=${prPosture?.forced} policies=[${prPolicies.join(",")}]`);
  console.log(`  => pre-context resolution ${prPosture?.enabled ? "IS BLOCKED (needs a bootstrap path)" : "still works (no RLS yet)"}`);

  console.log("\n=== 5. role postures ===");
  for (const role of ["app_runtime_preview_p4b", "app_admin", "app_admin_preview"]) {
    const r = (await owner.$queryRawUnsafe(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${role}'`))[0];
    console.log(`  ${role}: ${r ? `super=${r.rolsuper} bypassrls=${r.rolbypassrls} login=${r.rolcanlogin}` : "MISSING"}`);
  }

  console.log("\n=== 6. Preview migration tail (catch-up planning) ===");
  const migs = await owner.$queryRawUnsafe(
    `SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 12`);
  for (const m of migs) console.log(`  ${m.migration_name}`);

  await owner.$disconnect();
  console.log("\nRECON COMPLETE (read-only)");
}

main().catch((e) => { console.error("[recon] FATAL:", e); process.exit(1); });
