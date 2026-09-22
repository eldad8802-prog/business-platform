/**
 * M0 — Tenant-Safe Knowledge Foundation · the database proof.
 *
 * WHY THIS EXISTS
 *
 * Every Business Memory unit test passes against an injected fake. All 21 of them passed on the day the
 * read and write paths were both silently broken in Production, because the defect was never in the
 * logic — it was in what the DEFAULT argument bound to. `readClaim(query, prisma)` and
 * `client.$transaction(...)` on the bare singleton never set `app.current_business_id`, so under the
 * least-privilege runtime role FORCE row-level security matched zero rows on every read and would have
 * rejected every write. Twenty-one production comparisons reported `absent`; nothing errored; the
 * feature looked like "nothing learned yet" for a month.
 *
 * A fake cannot catch that, and neither can a hand-written SQL equivalent of what the code "should" do.
 * So this battery runs the REAL application entry points — the same `defaultCoordinatorDeps()` the
 * extraction path uses and the same `materializeClaim` default the orchestrator uses — against a real
 * PostgreSQL, connected as a role that is measured (not assumed) to be NOBYPASSRLS.
 *
 * WHAT IT PROVES
 *   P0  the runtime role really cannot bypass RLS, and the policies really are FORCEd
 *   P1  a write through the real writer default lands, under tenant context
 *   P2  a read through the real coordinator default returns the claim — THE HIT
 *   P3  the same identity is invisible to another tenant (no leak)
 *   P4  a tenant-context switch is refused rather than served (no confused deputy)
 *   P5  a write aimed at another tenant is refused and persists nothing
 *   P6  REGRESSION CONTROL — the pre-M0 binding (global client, no context) returns `absent`
 *       for a claim that demonstrably exists. This is the bug, reproduced on demand.
 *
 * P6 is the one that matters most: without it, P2 only proves that a read works, not that it was ever
 * broken. With it, the same run demonstrates the defect and the fix.
 *
 * Usage (CI provides a throwaway PostgreSQL):
 *   M0_ADMIN_URL=postgresql://... npx tsx .m0/knowledge-tenant-battery.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const ADMIN_URL = process.env.M0_ADMIN_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("M0_ADMIN_URL (or DATABASE_URL) must point at a throwaway lab cluster");

// A laboratory only. Production and the shared Preview endpoint are refused outright: this battery
// creates roles and writes rows, and the cost of pointing it at real data is not recoverable.
const DENY = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];
for (const host of DENY) {
  if (ADMIN_URL.includes(host)) throw new Error(`DENY: ${host} is not a laboratory`);
}

const NONCE = crypto.randomBytes(4).toString("hex");
const RT_ROLE = `m0_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    fails.push(label);
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(t: string): void {
  console.log(`\n== ${t} ==`);
}

const owner = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

/**
 * Replay the tenant policies for the knowledge tables out of the SHIPPED migration, rather than
 * retyping them here. A battery that invents its own policy proves only that the battery's policy
 * works; this one fails if the migration ever stops protecting these tables.
 */
function policyStatementsFromMigration(): string[] {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql"),
    "utf8",
  );
  const wanted = ["DerivedClaimProjection", "DerivedClaimCandidate", "DerivedClaimEvidenceLink"];
  const out: string[] = [];
  // Statements are `;`-terminated; keep the ones naming a table we care about.
  for (const raw of sql.split(";")) {
    const stmt = raw.trim();
    if (!stmt) continue;
    if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/.test(stmt)) continue;
    if (wanted.some((t) => stmt.includes(`"${t}"`))) out.push(stmt);
  }
  return out;
}

async function main(): Promise<void> {
  section("Provision — role, policies, grants (mirroring Production)");

  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  );

  const policies = policyStatementsFromMigration();
  check("shipped migration still carries the DerivedClaim* tenant policies", policies.length >= 9,
    `found ${policies.length} statements`);
  for (const stmt of policies) await owner.$executeRawUnsafe(stmt);

  // Production grants, as QUERIED from the production catalog on 2026-09-22 — not as the repo's
  // scripts/security/d2-p7-wave2-grants.sql describes them (that artifact says these tables are
  // ungranted, which Production contradicts). The lab must mirror what Production actually enforces.
  for (const t of ["DerivedClaimProjection", "DerivedClaimCandidate", "DerivedClaimEvidenceLink",
    "ReviewEvent", "ExtractionSnapshot", "DerivationPolicy", "DerivationPolicyVersion", "Business",
    "Document", "User", "VendorLearning"]) {
    await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${t}" TO ${RT_ROLE}`);
  }
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);

  section("P0 — the role posture is MEASURED, not assumed");
  const posture = await owner.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${RT_ROLE}'`,
  );
  check("runtime role is NOSUPERUSER", posture[0]?.rolsuper === false);
  check("runtime role is NOBYPASSRLS", posture[0]?.rolbypassrls === false);

  const forced = await owner.$queryRawUnsafe<{ relname: string; f: boolean }[]>(
    `SELECT c.relname, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('DerivedClaimProjection','DerivedClaimCandidate','DerivedClaimEvidenceLink')`,
  );
  check("all three DerivedClaim tables are FORCE RLS", forced.length === 3 && forced.every((r) => r.f === true));

  section("Seed — two tenants, the SAME vendor string in both");
  const bizA = await owner.business.create({ data: { name: `M0 Tenant A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `M0 Tenant B ${NONCE}` } });
  const policy = await owner.derivationPolicy.create({
    data: { key: "vendor-category", name: "vendor-category" },
  });
  const version = await owner.derivationPolicyVersion.create({
    data: { policyId: policy.id, version: "v1" },
  });

  // The same vendor, approved into DIFFERENT categories by each tenant. If tenancy ever collapses, the
  // two claims contend for one slot and the categories bleed — a failure that is visible, not subtle.
  const mk = async (businessId: number, category: string) => {
    const doc = await owner.document.create({
      data: { businessId, fileUrl: `s3://m0/${NONCE}`, source: "upload", mimeType: "application/pdf", status: "approved" },
    });
    await owner.reviewEvent.create({
      data: {
        documentId: doc.id, businessId, reviewerUserId: 1, approvedAs: "financial", explicitFinancial: true,
        vendorBelief: "ACME SUPPLIES", vendorFinal: "ACME SUPPLIES",
        directionBelief: "expense", directionFinal: "expense",
        verdicts: { category: { belief: null, final: category, verdict: "corrected" } },
        rawBelief: {}, rawFinal: { category },
      },
    });
  };
  await mk(bizA.id, "office");
  await mk(bizB.id, "fuel");

  // Everything below runs as the RESTRICTED role, through the real application code.
  const rtUrl = (() => {
    const u = new URL(ADMIN_URL!);
    u.username = RT_ROLE;
    u.password = RT_PW;
    return u.toString();
  })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;

  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { runVendorCategoryOrchestration } = await import("@/lib/business-memory/orchestration");
  const { defaultCoordinatorDeps } = await import("@/lib/business-memory/read/coordinator");
  const { readClaim } = await import("@/lib/business-memory/read/claim-reader");
  const { prisma: runtimePrisma } = await import("@/lib/prisma");

  const whoami = await runtimePrisma.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`);
  check("application code is connected as the restricted runtime role", whoami[0]?.u === RT_ROLE,
    `current_user=${whoami[0]?.u}`);

  const subjectKey = "acme supplies"; // normalizeVendorForLearning("ACME SUPPLIES")
  const identity = (businessId: number) => ({
    businessId,
    subjectDomain: "vendor" as const,
    subjectNormalizedKey: subjectKey,
    claimType: "vendor-category" as const,
    policyVersionId: version.id,
  });

  section("P1 — WRITE through the real orchestrator + writer default");
  const outA = await runWithTenantContext({ businessId: bizA.id }, () =>
    runVendorCategoryOrchestration({ businessId: bizA.id, vendorInput: "ACME SUPPLIES" }),
  );
  check("tenant A materialized a claim", outA.kind === "materialized", `outcome=${outA.kind}${
    outA.kind === "failed" ? ` stage=${(outA as { stage?: string }).stage}` : ""}`);

  const outB = await runWithTenantContext({ businessId: bizB.id }, () =>
    runVendorCategoryOrchestration({ businessId: bizB.id, vendorInput: "ACME SUPPLIES" }),
  );
  check("tenant B materialized its own claim for the same vendor", outB.kind === "materialized");

  const rowCount = await owner.derivedClaimProjection.count();
  check("two separate projections exist, one per tenant (the slot did not collapse)", rowCount === 2,
    `count=${rowCount}`);

  section("P2 — READ through the real coordinator default: THE HIT");
  const deps = defaultCoordinatorDeps();
  const hitA = await deps.readClaim(identity(bizA.id));
  check("tenant A reads its own claim as `supported`", hitA.status === "supported", `status=${hitA.status}`);
  check("tenant A's claim carries A's category, not B's",
    hitA.status === "supported" && hitA.category === "office",
    hitA.status === "supported" ? `category=${hitA.category}` : "");

  const hitB = await deps.readClaim(identity(bizB.id));
  check("tenant B reads its own, different category", hitB.status === "supported" && hitB.category === "fuel",
    hitB.status === "supported" ? `category=${hitB.category}` : "");

  section("P3/P4 — isolation: another tenant cannot reach it");
  // Under an established context for B, ask for A's claim. `runWithTenantContext` refuses to switch
  // tenants, so the seam degrades to a typed `unavailable` — it must never answer with A's row.
  const confused = await runWithTenantContext({ businessId: bizB.id }, () => deps.readClaim(identity(bizA.id)));
  check("a tenant-context switch is REFUSED, not served", confused.status !== "supported",
    `status=${confused.status}`);
  check("the refusal leaks no category", !("category" in confused) || confused.status !== "supported");

  section("P5 — a write aimed at another tenant persists nothing");
  const before = await owner.derivedClaimProjection.count();
  let writeRefused = false;
  try {
    await runWithTenantContext({ businessId: bizB.id }, () =>
      runVendorCategoryOrchestration({ businessId: bizA.id, vendorInput: "ACME SUPPLIES" }),
    );
  } catch {
    writeRefused = true;
  }
  const after = await owner.derivedClaimProjection.count();
  check("a cross-tenant write is refused or written nowhere", writeRefused || after === before,
    `before=${before} after=${after}`);
  check("no extra projection appeared", after === before, `before=${before} after=${after}`);

  section("P6 — REGRESSION CONTROL: the pre-M0 binding reproduces the bug");
  // Exactly what `coordinator.ts` did before M0: the bare singleton, no tenant context anywhere.
  const preM0 = await readClaim(identity(bizA.id), runtimePrisma as never);
  check(
    "pre-M0 global-client read returns `absent` for a claim that DOES exist (the defect)",
    preM0.status === "absent",
    `status=${preM0.status}`,
  );
  check(
    "…and the M0 binding returns `supported` for that same identity (the fix)",
    hitA.status === "supported",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const f of fails) console.log(`  - ${f}`);
  }
}

main()
  .catch((e) => {
    console.error("\nBATTERY ERROR:", e);
    failed++;
  })
  .finally(async () => {
    try {
      await owner.$executeRawUnsafe(`REASSIGN OWNED BY ${RT_ROLE} TO CURRENT_USER`);
      await owner.$executeRawUnsafe(`DROP OWNED BY ${RT_ROLE}`);
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`);
    } catch {
      /* teardown is best-effort; isolation comes from the nonce, not from cleanup */
    }
    await owner.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  });
