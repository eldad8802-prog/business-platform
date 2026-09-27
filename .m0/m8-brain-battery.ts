/**
 * M8 · The Brain against a real database — as a MEASURED NOSUPERUSER + NOBYPASSRLS role.
 *
 * The model is a scripted fake (no paid call). What is proven is everything AROUND it:
 *   B1  the Brain's input is the server-built bks.v1 snapshot of ONE business, not the database
 *   B2  what would leave for the provider contains no names, phones, tax ids, amounts or row ids
 *   B3  a grounded answer is accepted and maps back to real snapshot slots (the "why?" path)
 *   B4  references taken from ANOTHER business's context are rejected
 *   B5  a run — accepted, rejected or failed — writes NOTHING: every table's row count is unchanged
 *   B6  a provider failure leaves the business, its knowledge and the snapshot exactly as they were
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const ADMIN_URL = process.env.M0_ADMIN_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("M0_ADMIN_URL (or DATABASE_URL) must point at a throwaway lab cluster");
for (const host of ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"]) {
  if (ADMIN_URL.includes(host)) throw new Error(`DENY: ${host} is not a laboratory`);
}
const NONCE = crypto.randomBytes(4).toString("hex");
const RT_ROLE = `m8_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
const GROUP = "app_runtime";
const DAY = 86_400_000;
const AS_OF = new Date("2026-09-01T12:00:00.000Z");
const ago = (d: number) => new Date(AS_OF.getTime() - d * DAY);

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; fails.push(label); console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}
function section(t: string): void { console.log(`\n== ${t} ==`); }
const owner = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

function sqlStatements(file: string, keep: RegExp, drop?: RegExp): string[] {
  const sql = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out: string[] = [];
  for (const m of sql.matchAll(/\s*(?:DO \$do\$[\s\S]*?\$do\$|[^;]+);?/g)) {
    const s = m[0].trim().replace(/;$/, "").trim();
    if (s && keep.test(s) && !(drop && drop.test(s))) out.push(s);
  }
  return out;
}

async function tableCounts(): Promise<string> {
  const rows = await owner.$queryRawUnsafe<{ t: string; n: bigint }[]>(
    `SELECT relname AS t, n_live_tup AS n FROM pg_stat_user_tables ORDER BY relname`);
  // n_live_tup lags; count the tables a Brain run could conceivably touch exactly.
  const exact = await Promise.all(["KnowledgeMeasure", "TemporalKnowledge", "BusinessInsight", "LearningEvent", "FinancialRecord",
    "Document", "Customer", "Payment", "PaymentAllocation", "Installment", "PartyResolutionClaim", "EntityLinkProposal", "CollectionAction"]
    .map(async (t) => `${t}=${(await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n}`));
  return `${exact.join(",")}|tables=${rows.length}`;
}

async function main(): Promise<void> {
  section("Provision — the lab mirrors Production's enforcement");
  await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${GROUP}') THEN CREATE ROLE ${GROUP} NOLOGIN; END IF; END $$`);
  await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION IN ROLE ${GROUP}`);
  for (const f of [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql",
    "prisma/migrations/20260917090100_payables_phase_1a_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql",
  ]) for (const s of sqlStatements(f, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/, /app_admin/)) await owner.$executeRawUnsafe(s);
  for (const f of ["prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql", "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql"]) {
    for (const s of sqlStatements(f, /^INSERT INTO "DerivationPolicy/)) await owner.$executeRawUnsafe(s);
  }
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  check("the runtime role is NOSUPERUSER + NOBYPASSRLS", posture[0]?.s === false && posture[0]?.b === false);
  check("the application code is connected as the restricted role", (await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0]?.u === RT_ROLE);

  const { buildBusinessKnowledgeSnapshot } = await import("@/lib/knowledge/snapshot/build-snapshot");
  const { deriveKnowledgeForBusiness } = await import("@/lib/knowledge/derive.service");
  const { runBrain } = await import("@/lib/knowledge/brain/brain.service");
  const { buildBrainContext, stableSerialize } = await import("@/lib/knowledge/brain/context-builder");

  section("Seed — two businesses with real, similar filing history");
  const bizA = await owner.business.create({ data: { name: `M8 A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `M8 B ${NONCE}` } });
  for (const b of [bizA.id, bizB.id]) {
    for (let i = 0; i < 8; i++) {
      const d = await owner.document.create({ data: { businessId: b, fileUrl: `s3://m8/${NONCE}-${b}-${i}`, source: "upload", mimeType: "application/pdf", status: "approved" } as never });
      // A files in ~3 days, B in ~20: similar businesses, different knowledge — so their contexts differ.
      const lag = b === bizA.id ? 3 : 20;
      await owner.financialRecord.create({ data: { documentId: d.id, businessId: b, amount: 4321 + i, date: ago(17 + lag + i * 15), vendorName: "Secret Vendor Ltd",
        direction: "expense", category: "lab", approvedAt: ago(17 + i * 15) } as never });
    }
    await owner.customer.create({ data: { businessId: b, name: "Dana Private", phone: "0541112233" } as never });
    await deriveKnowledgeForBusiness(b, AS_OF);
  }
  const build = (b: number) => buildBusinessKnowledgeSnapshot(b, { asOf: AS_OF });

  section("B1/B2 — the Brain sees one business's snapshot, minimised");
  const snapA = await build(bizA.id);
  const { context, fingerprint } = buildBrainContext(snapA);
  const outbound = stableSerialize(context);
  check("the context is built from A's snapshot and carries knowledge", snapA.businessId === bizA.id && context.knowledge.length > 0);
  check("nothing identifying leaves: no name, phone, amount, row id or businessId",
    !/Secret Vendor|Dana Private|0541112233|4321|4322/.test(outbound) && !outbound.includes('"id"') && !outbound.includes('"businessId"'));

  section("B3 — a grounded answer is accepted and walks back to real slots");
  let calls = 0;
  const fake = (make: (fp: string) => unknown) => ({
    name: "fake", model: "fake-1",
    async complete(_s: string, user: string) {
      calls += 1;
      const fp = /contextFingerprint: (\w+)/.exec(user)![1];
      return { ok: true as const, text: JSON.stringify(make(fp)), inputTokens: 1, outputTokens: 1, latencyMs: 1 };
    },
  });
  const before = await tableCounts();
  const good = await runBrain(bizA.id, { mode: "shadow", buildSnapshot: build, provider: fake((fp) => ({
    contextFingerprint: fp, outcome: "FINDINGS",
    findings: [{ findingId: "a", type: "ATTENTION", priority: "LOW", knowledgeRefs: ["K1"], findingRefs: [], conflictRefs: [], gapRefs: [],
      observation: "יש ידע פעיל על העסק בתחום הזה.", interpretation: null, hypothesis: null, causalClaim: false, uncertainty: "SUPPORTED" }],
  })) });
  check("accepted, and its provenance is a real slot of A's snapshot",
    good.status === "FINDINGS" && snapA.knowledge.some((k) => k.slot === good.findings[0].knowledgeSlots[0]));
  check("the run's snapshot fingerprint is A's", good.meta.snapshotFingerprint === snapA.snapshotFingerprint && good.meta.contextFingerprint === fingerprint);

  section("B4 — another business's references are not this business's");
  const ctxB = buildBrainContext(await build(bizB.id));
  const cross = await runBrain(bizA.id, { mode: "shadow", buildSnapshot: build, provider: fake(() => ({
    contextFingerprint: ctxB.fingerprint, outcome: "FINDINGS",
    findings: [{ findingId: "x", type: "ATTENTION", priority: "LOW", knowledgeRefs: ["K1"], findingRefs: [], conflictRefs: [], gapRefs: [],
      observation: "ידע.", interpretation: null, hypothesis: null, causalClaim: false, uncertainty: "SUPPORTED" }],
  })) });
  check("B's context is not A's (different knowledge → different fingerprint)", ctxB.fingerprint !== fingerprint);
  check("an answer built on B's context is rejected for A", cross.status === "INVALID_OUTPUT" && cross.rejected.some((r) => r.code === "CONTEXT_FINGERPRINT_MISMATCH"));
  // Structural guarantee, independent of fingerprints: refs are resolved ONLY through A's own alias
  // map, so any accepted ref can only ever name A's knowledge.
  check("every ref the Brain ever accepted for A resolves inside A's snapshot",
    good.findings.every((f) => f.knowledgeSlots.every((s) => snapA.knowledge.some((k) => k.slot === s))));
  const callsBefore = calls;
  const wrongTenant = await runBrain(bizA.id, { mode: "shadow", buildSnapshot: () => build(bizB.id), provider: fake(() => ({})) });
  check("a snapshot of B handed to A's run stops before any model call", wrongTenant.status === "INVALID_OUTPUT" && !wrongTenant.meta.modelCalled && calls === callsBefore);

  section("B5/B6 — the Brain writes nothing, whatever happens");
  await runBrain(bizA.id, { mode: "shadow", buildSnapshot: build, provider: { name: "fake", model: "fake-1", complete: async () => ({ ok: false as const, reason: "TIMEOUT" as const, latencyMs: 1 }) } });
  await runBrain(bizA.id, { mode: "shadow", buildSnapshot: build, provider: fake(() => "not json") });
  const after = await tableCounts();
  check("after accepted, rejected and failed runs, every counted table is unchanged", before === after, `${before} vs ${after}`);
  check("…and the snapshot is exactly as it was", (await build(bizA.id)).snapshotFingerprint === snapA.snapshotFingerprint);

  section("Cleanup");
  await rt.$disconnect();
  for (const b of [bizA.id, bizB.id]) await owner.business.delete({ where: { id: b } }).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP OWNED BY ${RT_ROLE}`).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => undefined);
  console.log(`\nM8 brain battery: ${passed} passed, ${failed} failed`);
  if (failed > 0) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
}

main()
  .catch((e) => {
    const code = (e as { code?: string })?.code ?? "";
    const line = e instanceof Error ? (e.message.split("\n").find((l) => l.trim()) ?? "").slice(0, 160) : "";
    console.error("battery crashed:", e instanceof Error ? `${e.name} ${code} ${line}` : "unknown");
    process.exit(1);
  })
  .finally(async () => { await owner.$disconnect(); });
