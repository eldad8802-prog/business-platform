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
  // `prisma db push` builds the lab from schema.prisma, which carries tables and indexes but NOT
  // policies, and not an expression index written in raw SQL. Both live only in the migrations — so
  // both are replayed from the shipped migrations here, and a lab that drifts from what was shipped
  // fails rather than quietly proving something easier.
  const files = [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
  ];
  const wanted = [
    "DerivedClaimProjection",
    "DerivedClaimCandidate",
    "DerivedClaimEvidenceLink",
    "KnowledgeMeasure",
    "KnowledgeMeasureEvidenceLink",
    "BusinessInsight",
    "EntityLinkProposal",
    "CollectionAction",
  ];
  const out: string[] = [];
  for (const f of files) {
    // Strip `--` comments BEFORE splitting on `;`.
    //
    // Not tidiness. A semicolon inside a comment — "…about one business's behaviour; there is no
    // reading of it that is safe to share." — splits the file mid-sentence, and the prose after it is
    // then handed to Postgres as a statement. That failed in CI with `syntax error at or near "there"`,
    // which is a confusing way to be told that an English sentence was executed as SQL.
    // CRLF is normalised FIRST. In JavaScript `.` does not match `\r` (it is a line terminator), so on
    // a CRLF file `--.*$` matches nothing at all and every comment survives — which is how a stray
    // semicolon in prose reached Postgres in the first place.
    const sql = readFileSync(join(process.cwd(), f), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    // Statements are `;`-terminated; keep policy/RLS statements plus the COALESCE slot index, which is
    // what makes "re-derive replaces" true for a business-level measure whose subject columns are null.
    for (const raw of sql.split(";")) {
      const stmt = raw.trim();
      if (!stmt) continue;
      const isPolicy = /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/.test(stmt);
      const isSlotIndex = /CREATE UNIQUE INDEX "KnowledgeMeasure_slot_key"/.test(stmt);
      if (!isPolicy && !isSlotIndex) continue;
      if (isSlotIndex || wanted.some((t) => stmt.includes(`"${t}"`))) out.push(stmt);
    }
  }

  // Every replayed fragment must actually LOOK like the statement it claims to be.
  //
  // Without this the splitter fails silently in the worst direction: a malformed fragment reaches
  // Postgres, the error names a word from an English sentence, and the real cause — a semicolon in a
  // comment — is nowhere in the message. Better to refuse to start than to debug that twice.
  const malformed = out.filter((s) => !/^(ALTER TABLE|DROP POLICY|CREATE POLICY|CREATE UNIQUE INDEX)/.test(s));
  if (malformed.length > 0) {
    throw new Error(
      `migration replay produced ${malformed.length} fragment(s) that are not SQL statements — ` +
        `the splitter is wrong, not the migration. First: ${JSON.stringify(malformed[0].slice(0, 120))}`,
    );
  }
  return out;
}

/**
 * The rule-version rows, replayed out of the SAME migration that ships them.
 *
 * `prisma db push` builds the lab from schema.prisma, which has tables but no DATA — so the fourteen
 * `DerivationPolicy` lineages the resolver is fail-closed against simply would not exist, and every
 * rule in the catalogue would refuse at the policy stage.
 *
 * Replaying the migration's own INSERTs rather than writing fourteen `create` calls here means the
 * battery proves the migration seeds what the code resolves. If a rule is added with a lineage the
 * migration forgot, this lab goes red in exactly the way Production would.
 */
function policySeedsFromMigration(): string[] {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql"),
    "utf8",
  )
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  const out = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => /^INSERT INTO "DerivationPolicy/.test(s));

  if (out.length !== 2) {
    throw new Error(
      `expected exactly 2 policy-seed statements in the M4/M5 migration, found ${out.length}. ` +
        `The seed is what every rule's version resolution depends on — a lab without it proves nothing.`,
    );
  }
  return out;
}


/** M5.5 — the rule versions registered after M4/M5 (AP-06, SUPP-02, SUPP-03 v2), out of their migration. */
function laterRuleVersions(): string[] {
  const sql = readFileSync(join(process.cwd(), "prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql"), "utf8")
    .replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out = sql.split(";").map((s) => s.trim()).filter((s) => /^INSERT INTO "DerivationPolicyVersion"/.test(s));
  if (out.length !== 1) throw new Error(`expected 1 M5.5 version insert, found ${out.length}`);
  return out;
}

async function main(): Promise<void> {
  section("Provision — role, policies, grants (mirroring Production)");

  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  );

  const policies = policyStatementsFromMigration();
  check("shipped migrations still carry the knowledge tenant policies", policies.length >= 21,
    `found ${policies.length} statements`);
  check("…including KnowledgeMeasure", policies.some((s) => s.includes('"KnowledgeMeasure"')));
  check("…and the COALESCE slot index", policies.some((s) => s.includes("KnowledgeMeasure_slot_key")));
  check("…and the M5 identity proposal ledger", policies.some((s) => s.includes('"EntityLinkProposal"')));
  check("…and the collection action log", policies.some((s) => s.includes('"CollectionAction"')));
  for (const stmt of policies) await owner.$executeRawUnsafe(stmt);

  // The fourteen rule lineages, from the migration that ships them. Without these every rule in the
  // catalogue refuses at the policy stage — which is the resolver being correctly fail-closed, and
  // would make this whole battery prove nothing about the rules themselves.
  for (const stmt of policySeedsFromMigration()) await owner.$executeRawUnsafe(stmt);
  for (const stmt of laterRuleVersions()) await owner.$executeRawUnsafe(stmt);
  const seeded = await owner.derivationPolicyVersion.count();
  check("the migration seeds a version for every rule in the catalogue", seeded === 14, `versions=${seeded}`);

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

  section("M1 — the L0 fact layer is tenant-scoped, and equals a direct query");

  // Three of the Business Status loaders read through the global client until M1: inventory alerts,
  // leads and supplier drafts. Under this exact role that returned zero rows behind a green 200, so the
  // owner's Attention list silently dropped three domains. This proves the facts now arrive AND belong
  // to the right tenant — the two halves of "correct" that a silent empty satisfies neither of.
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "Installment", "Commitment", "PaymentAllocation", "Payment", "Payee" TO ${RT_ROLE}`,
  );

  const seedPayable = async (businessId: number, dueAt: Date, amount: string) => {
    const c = await owner.commitment.create({
      data: {
        businessId, title: `M0 rent ${NONCE}`, payeeNameSnapshot: `Landlord ${businessId}`,
        currency: "ILS", scheduleKind: "ONE_OFF", status: "ACTIVE", startAt: new Date(),
      },
    });
    await owner.installment.create({
      data: { businessId, commitmentId: c.id, sequence: 1, scheduledAmount: amount, currency: "ILS", dueAt, status: "SCHEDULED" },
    });
  };
  const past = new Date(Date.now() - 10 * 86_400_000);
  const soon = new Date(Date.now() + 3 * 86_400_000);
  await seedPayable(bizA.id, past, "5000");
  await seedPayable(bizA.id, soon, "1200");
  await seedPayable(bizB.id, past, "9999");

  const { runWithTenantContext: ctx2 } = await import("@/lib/tenant/context");
  const { loadPayablesOverdue, loadPayablesDueSoon } = await import("@/lib/business-status/loaders");

  const overdueA = await ctx2({ businessId: bizA.id }, () => loadPayablesOverdue(bizA.id, new Date()));
  const dueSoonA = await ctx2({ businessId: bizA.id }, () => loadPayablesDueSoon(bizA.id, new Date()));
  const overdueB = await ctx2({ businessId: bizB.id }, () => loadPayablesOverdue(bizB.id, new Date()));

  check("tenant A sees its own overdue installment", overdueA.length === 1, `n=${overdueA.length}`);
  check("tenant A's overdue amount is A's, not B's", Number(overdueA[0]?.scheduledAmount) === 5000);
  check("tenant A sees its own upcoming installment", dueSoonA.length === 1, `n=${dueSoonA.length}`);
  check("an upcoming payment is NOT reported as overdue", overdueA.every((r) => r.dueAt < new Date()));
  check("tenant B sees only its own", overdueB.length === 1 && Number(overdueB[0]?.scheduledAmount) === 9999);

  // Direct-query equivalence: the fact must equal what the database says, not merely be non-empty.
  const directA = await owner.installment.count({
    where: { businessId: bizA.id, status: "SCHEDULED", dueAt: { lt: new Date() } },
  });
  check("the L0 fact equals a direct owner-side query", overdueA.length === directA,
    `fact=${overdueA.length} direct=${directA}`);

  // A settled installment is not a fact about anything.
  const pay = await owner.payment.create({
    data: { businessId: bizA.id, payeeNameSnapshot: "Landlord", amount: "5000", currency: "ILS",
      paidAt: new Date(), method: "BANK_TRANSFER", status: "RECORDED", idempotencyKey: `m0-${NONCE}` },
  });
  const instA = await owner.installment.findFirst({ where: { businessId: bizA.id, dueAt: { lt: new Date() } } });
  await owner.paymentAllocation.create({
    data: { businessId: bizA.id, paymentId: pay.id, installmentId: instA!.id, allocatedAmount: "5000", currency: "ILS" },
  });
  const afterPay = await ctx2({ businessId: bizA.id }, () => loadPayablesOverdue(bizA.id, new Date()));
  check("a fully-allocated installment stops being an overdue fact", afterPay.length === 0,
    `n=${afterPay.length}`);

  // …and a reversed allocation brings the debt back. "Paid" is derived, never asserted.
  await owner.paymentAllocation.updateMany({
    where: { installmentId: instA!.id },
    data: { reversedAt: new Date(), reversalReason: "M0 proof" },
  });
  const afterReversal = await ctx2({ businessId: bizA.id }, () => loadPayablesOverdue(bizA.id, new Date()));
  check("reversing the allocation restores the debt (paid is derived, not stored)", afterReversal.length === 1,
    `n=${afterReversal.length}`);

  // The loaders must FAIL LOUD without a tenant context rather than return an empty world.
  let loudFailure = false;
  try {
    await loadPayablesOverdue(bizA.id, new Date());
  } catch {
    loudFailure = true;
  }
  check("a context-less fact read throws instead of returning an empty world", loudFailure);

  section("M2 — the first real MEASURE, and the silence next to it");

  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "KnowledgeMeasure", "KnowledgeMeasureEvidenceLink", "FinancialRecord" TO ${RT_ROLE}`,
  );
  // M4 runs the whole catalogue, not one rule, so the other thirteen need to be able to LOOK. Read-only
  // is the right shape here: this section is about DOC-04, and the rest should be able to find nothing
  // and say so rather than fail on a missing privilege — which would report as a broken rule instead of
  // an empty domain.
  await owner.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);

  // Tenant A files paperwork with a growing lag; tenant B has filed only twice. The asymmetry is the
  // point: one business gets an answer, the other gets an explained silence, from the same rule.
  const seedRecord = async (businessId: number, approvedDaysAgo: number, lagDays: number, n: number) => {
    const approvedAt = new Date(Date.now() - approvedDaysAgo * 86_400_000);
    const doc = await owner.document.create({
      data: { businessId, fileUrl: `s3://m0/fr-${NONCE}-${n}`, source: "upload", mimeType: "application/pdf", status: "approved" },
    });
    await owner.financialRecord.create({
      data: {
        documentId: doc.id, businessId, amount: 100 + n, date: new Date(approvedAt.getTime() - lagDays * 86_400_000),
        vendorName: "ACME SUPPLIES", direction: "expense", category: "office", approvedAt,
      },
    });
  };
  // Older half: filed within ~2 days. Recent half: ~12 days. A real, explainable deterioration.
  const lagsA = [[170, 2], [160, 3], [150, 2], [20, 12], [12, 13], [5, 11]];
  for (let i = 0; i < lagsA.length; i++) await seedRecord(bizA.id, lagsA[i][0], lagsA[i][1], i);
  await seedRecord(bizB.id, 30, 4, 100);
  await seedRecord(bizB.id, 20, 5, 101);

  // M4 folded DOC-04 into the catalogue, so it is now reached the way every rule is: through the
  // derivation service, which resolves its version, loads its evidence, writes it and reconciles it.
  // The rule's own pure derivation is unchanged — only how it is invoked — and these assertions are
  // the same ones, which is the point of keeping them.
  const { deriveKnowledgeForBusiness } = await import("@/lib/knowledge/derive.service");
  const MEASURE_KEY = "documents.paperwork_lag";
  const doc04 = async (businessId: number) => {
    const report = await deriveKnowledgeForBusiness(businessId);
    const rule = report.rules.find((r) => r.ruleId === "DOC-04");
    return { report, rule, measure: rule?.measures[0] };
  };

  const mA = await doc04(bizA.id);
  check("tenant A's measure was derived and written", mA.rule?.outcome === "ok",
    mA.rule?.outcome === "failed" ? `stage=${mA.rule.failedStage} ${mA.rule.failureDetail}` : "");
  check("tenant A's measure is ACTIVE", mA.measure?.status === "ACTIVE");
  check("tenant A's measure carries a real number of days",
    typeof mA.measure?.valueNumeric === "number" && mA.measure.valueNumeric > 0,
    `value=${mA.measure?.valueNumeric}`);
  check("tenant A's measure rests on all six observations",
    mA.measure?.observationCount === 6, `n=${mA.measure?.observationCount}`);
  check("tenant A's measure detected the deterioration",
    mA.measure?.trend === "WORSENING", `trend=${mA.measure?.trend}`);

  // Every rule in the catalogue ran, and every one of them REPORTED — including the twelve that had
  // nothing to say. A rule that stays silent is indistinguishable from a rule that never ran, and
  // that difference is the whole answer to "why did Dubiz tell me nothing?".
  check("the whole catalogue ran for this tenant", (mA.report.rulesRun ?? 0) === 14,
    `rules=${mA.report.rulesRun}`);
  check("no rule failed on a missing version, a broken query or an unwritable measure",
    mA.report.rulesFailed === 0,
    mA.report.rules.filter((r) => r.outcome === "failed")
      .map((r) => `${r.ruleId}:${r.failedStage}:${r.failureDetail}`).join(" | "));
  check("the rules with no evidence said INSUFFICIENT_EVIDENCE rather than nothing at all",
    mA.report.measuresInsufficient >= 3, `insufficient=${mA.report.measuresInsufficient}`);
  check("every rule reports how long it took, so cadence can be decided on numbers",
    mA.report.rules.every((r) => typeof r.durationMs === "number"));
  check("each evidence source was loaded ONCE, not once per rule",
    new Set(mA.report.sourcesLoaded.map((s) => s.key)).size === mA.report.sourcesLoaded.length &&
    mA.report.sourcesLoaded.length < mA.report.rulesRun,
    `sources=${mA.report.sourcesLoaded.length} rules=${mA.report.rulesRun}`);

  const mB = await doc04(bizB.id);
  check("tenant B, with two observations, is told nothing was learned",
    mB.measure?.status === "INSUFFICIENT_EVIDENCE");
  check("…and that silence carries NO number", mB.measure?.valueNumeric === null);
  check("…and can explain itself (`have` vs `minSupport`)",
    (await owner.knowledgeMeasure.findFirst({
      where: { businessId: bizB.id, measureKey: MEASURE_KEY },
      select: { detail: true },
    }))?.detail !== null);

  // The silence is PERSISTED, not skipped: an absent row is indistinguishable from a rule that never
  // ran, and the difference is the whole answer to "why did Dubiz say nothing?".
  const storedB = await owner.knowledgeMeasure.findFirst({ where: { businessId: bizB.id, measureKey: MEASURE_KEY } });
  check("the refusal is stored, not skipped", storedB?.status === "INSUFFICIENT_EVIDENCE");

  // Evidence links must point at real FinancialRecords of the SAME tenant.
  const storedA = await owner.knowledgeMeasure.findFirst({
    where: { businessId: bizA.id, measureKey: MEASURE_KEY },
    include: { evidenceLinks: true },
  });
  check("the measure links its evidence", (storedA?.evidenceLinks.length ?? 0) === 6);
  const linkedIds = (storedA?.evidenceLinks ?? []).map((l) => l.evidenceRecordId);
  const realA = await owner.financialRecord.findMany({ where: { businessId: bizA.id }, select: { id: true } });
  check("every evidence link points at a real record of THIS tenant",
    linkedIds.every((id) => realA.some((r) => r.id === id)));
  check("no evidence link belongs to another tenant",
    (storedA?.evidenceLinks ?? []).every((l) => l.businessId === bizA.id));

  section("M2 — cross-tenant invisibility of derived knowledge");
  const seenByB = await ctx2({ businessId: bizB.id }, () =>
    runtimePrisma.knowledgeMeasure.findMany({ where: { measureKey: MEASURE_KEY } }),
  );
  check("tenant B cannot see tenant A's measure", seenByB.every((m) => m.businessId === bizB.id),
    `ids=${seenByB.map((m) => m.businessId).join(",")}`);

  section("M2 — DETERMINISTIC REBUILD");
  const before2 = await owner.knowledgeMeasure.findFirst({ where: { businessId: bizA.id, measureKey: MEASURE_KEY } });
  // Destroy every derived measure for this tenant, then rebuild from canonical evidence alone.
  await owner.knowledgeMeasure.deleteMany({ where: { businessId: bizA.id } });
  const gone = await owner.knowledgeMeasure.count({ where: { businessId: bizA.id } });
  check("all derived knowledge for the tenant was dropped", gone === 0);

  const rebuilt = await doc04(bizA.id);
  const after2 = await owner.knowledgeMeasure.findFirst({ where: { businessId: bizA.id, measureKey: MEASURE_KEY } });
  check("the measure rebuilt from evidence alone", rebuilt.rule?.outcome === "ok");
  check("the rebuilt fingerprint is identical",
    !!before2 && !!after2 && before2.evidenceFingerprint === after2.evidenceFingerprint,
    `${before2?.evidenceFingerprint} vs ${after2?.evidenceFingerprint}`);
  check("the rebuilt value is identical",
    !!before2 && !!after2 && String(before2.valueNumeric) === String(after2.valueNumeric),
    `${before2?.valueNumeric} vs ${after2?.valueNumeric}`);
  check("the rebuilt observation count is identical",
    before2?.observationCount === after2?.observationCount);

  // Re-deriving REPLACES rather than accumulates — the COALESCE slot index is what makes that true for
  // a business-level measure, whose entityType/entityId are null.
  await doc04(bizA.id);
  await doc04(bizA.id);
  const slotCount = await owner.knowledgeMeasure.count({ where: { businessId: bizA.id, measureKey: MEASURE_KEY } });
  check("re-deriving replaces the slot instead of accumulating rows", slotCount === 1, `rows=${slotCount}`);

  section("M3 — the first cross-domain Dubiz Insight, and the owner's decision");

  // The insight composer reads the whole Business Status snapshot, which spans a dozen tables and their
  // relations. Enumerating them was a losing game — the previous run failed on `ExtractedData`, reached
  // through a nested select inside the documents loader.
  //
  // So: grant broadly, and be explicit about why that weakens nothing. This battery proves ROW
  // visibility under RLS; grants are the other gate, asserted by the exact-grant batteries elsewhere in
  // CI. A missing grant here would only prove a table was ungranted in the LAB. The knowledge-table
  // grants above stay enumerated, because those document what Production actually holds.
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);

  // Tenant A already has: overdue + upcoming payables (M1 seed) and an ACTIVE paperwork-lag measure
  // (M2). It needs documents awaiting review so the composition spans two domains.
  for (let i = 0; i < 2; i++) {
    await owner.document.create({
      data: { businessId: bizA.id, fileUrl: `s3://m0/nr-${NONCE}-${i}`, source: "upload",
        mimeType: "application/pdf", status: "needs_review" },
    });
  }

  const { generateInsightsForBusiness, recordOwnerDecision, listOpenInsights } =
    await import("@/lib/knowledge/insight.service");

  const gen = await generateInsightsForBusiness(bizA.id);
  check("an insight was generated for tenant A", gen.length === 1, `n=${gen.length}`);
  check("…and it is the cross-domain composition",
    gen[0]?.insightKey === "payables.pressure_with_paperwork_backlog");

  const openA = await listOpenInsights(bizA.id);
  const ins = openA[0];
  check("the insight is OPEN and awaiting the owner", ins?.status === "OPEN");
  check("it belongs to tenant A", ins?.businessId === bizA.id);

  const lines = ins?.factLines as { text: string; sourceKind: string; sourceRef: string }[];
  check("it states facts from BOTH domains",
    lines.some((l) => /תשלומים/.test(l.text)) && lines.some((l) => /מסמכים/.test(l.text)));
  check("every fact line points at the artifact it came from", lines.every((l) => l.sourceRef.length > 0));
  check("it consumed the ACTIVE measure", lines.some((l) => l.sourceKind === "measure"));
  check("…and cites it by artifact id",
    lines.some((l) => l.sourceRef.startsWith("knowledge-measure:")));

  const cites = ins?.contributingRules as { ruleId: string; ruleVersion: string }[];
  check("DOC-04 is credited with its rule version",
    cites.some((r) => r.ruleId === "DOC-04" && r.ruleVersion.length > 0));
  check("interpretation is stored SEPARATELY from the facts", typeof ins?.interpretation === "string");
  check("uncertainty is stated in words, not as a score",
    typeof ins?.uncertainty === "string" && !/\d+%/.test(ins!.uncertainty!));

  // Tenant B has payables and documents too, but its measure is INSUFFICIENT_EVIDENCE — the insight
  // must still compose from facts, and must NOT quote a number it does not have.
  await owner.document.create({
    data: { businessId: bizB.id, fileUrl: `s3://m0/nrb-${NONCE}`, source: "upload",
      mimeType: "application/pdf", status: "needs_review" },
  });
  const genB = await generateInsightsForBusiness(bizB.id);
  check("tenant B also gets an insight from its own facts", genB.length === 1);
  const insB = (await listOpenInsights(bizB.id))[0];
  check("tenant B's insight quotes NO habit (its measure is insufficient)",
    (insB?.factLines as { sourceKind: string }[]).every((l) => l.sourceKind !== "measure"));
  check("…and offers no interpretation it cannot support", insB?.interpretation === null);

  section("M3 — insights are tenant-private");
  const insightsSeenByB = await ctx2({ businessId: bizB.id }, () =>
    runtimePrisma.businessInsight.findMany({}),
  );
  check("tenant B cannot see tenant A's insight",
    insightsSeenByB.every((i) => i.businessId === bizB.id),
    `ids=${insightsSeenByB.map((i) => i.businessId).join(",")}`);

  section("M3 — THE OWNER DECISION LOOP");
  const actor = await owner.user.create({
    data: { email: `m0-${NONCE}@example.test`, password: "x", businessId: bizA.id },
  });
  const decided = await recordOwnerDecision(bizA.id, ins!.id, "DISMISSED", actor.id, "כבר טיפלתי בזה");
  check("the owner's decision was recorded", decided.ok === true, decided.reason);

  const decidedRow = await owner.businessInsight.findUnique({ where: { id: ins!.id } });
  check("the decision is DURABLE", decidedRow?.status === "DISMISSED");
  check("the ACTOR is known", decidedRow?.ownerDecisionByUserId === actor.id);
  check("the decision is timestamped", decidedRow?.ownerDecisionAt instanceof Date);
  check("the owner's REASON was captured", decidedRow?.ownerDecisionNote === "כבר טיפלתי בזה");

  // Regenerating must not resurrect a decided insight — the owner said no, and tomorrow is not a
  // fresh chance to ask again.
  await generateInsightsForBusiness(bizA.id);
  const afterRegen = await owner.businessInsight.findUnique({ where: { id: ins!.id } });
  check("regenerating does NOT reopen a dismissed insight", afterRegen?.status === "DISMISSED");
  check("…and does not erase who decided it", afterRegen?.ownerDecisionByUserId === actor.id);
  const countA = await owner.businessInsight.count({ where: { businessId: bizA.id } });
  check("regenerating refreshes one row instead of breeding new ones", countA === 1, `rows=${countA}`);

  // A decision aimed at another tenant's insight must not land.
  const crossDecision = await recordOwnerDecision(bizB.id, ins!.id, "ADOPTED", actor.id);
  check("a decision cannot be written onto another tenant's insight", crossDecision.ok === false);
  const untouched = await owner.businessInsight.findUnique({ where: { id: ins!.id } });
  check("…and that insight is unchanged", untouched?.status === "DISMISSED");

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
