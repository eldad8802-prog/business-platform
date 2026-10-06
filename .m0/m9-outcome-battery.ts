/**
 * M9 · The outcome loop against a real database — as a MEASURED NOSUPERUSER + NOBYPASSRLS role.
 *
 * The shipped M9 migration's constraints, guards, policies and grants are replayed onto the lab schema,
 * and the real service runs the whole chain for two look-alike businesses:
 *
 *   O1  enforcement: RLS + FORCE, per-command policies, and the runtime's exact privileges
 *   O2  recommendations come from governed knowledge (and cite a validated finding when one exists)
 *   O3  tenant isolation: invisible across tenants and without one; cross-tenant writes and links refused
 *   O4  memory: the same situation is not re-issued
 *   O5  owner decisions: append-only authority, version-bound, idempotent, tenant-bound
 *   O6  history cannot be rewritten — not by the runtime, not by the table owner
 *   O7  causal attribution cannot be STORED
 *   O8  the full chain: recommendation → decision → real domain action → outcome → assessment
 *   O9  replay / duplicate: nothing new is written, assessments are confirmed
 *   O10 reversal: a voided payment appends a reversal; the old assessment is superseded, not lost
 *   O11 deterministic rebuild: wiped tracking and assessments are rebuilt to the same hashes
 *   O12 feedback: the next snapshot (and the Brain context) carries the learning, per business
 *   O13 no business record is mutated by the loop; failures and the kill switch write nothing
 *   E1  Closed Loop: every issued version carries its durable WHY (append-only, FORCE RLS, no money),
 *       the owner surface reads it back intact, and the after view is worded as a sequence only
 *
 * Output is labels and PASS/FAIL only. Synthetic lab data; nothing here touches Production.
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
const RT_ROLE = `m9_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
const GROUP = "app_runtime";
const DAY = 86_400_000;
// The L0 fact layer reads the real clock, so the lab's "now" is the real now; later derivations are
// run AS OF future instants, with domain events stamped in between.
const NOW = new Date();
const at = (d: number) => new Date(NOW.getTime() + d * DAY);
const M9_MIGRATION = "prisma/migrations/20260928090000_m9_outcome_learning/migration.sql";
const EVIDENCE_MIGRATION = "prisma/migrations/20261011090000_closed_loop_recommendation_evidence/migration.sql";

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  [PASS] ${label}`); }
  else { failed++; fails.push(label); console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}
function section(t: string): void { console.log(`\n== ${t} ==`); }
const owner = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

/** Statements of a migration file: comments stripped, split on `;` outside dollar-quoted bodies. */
function sqlStatements(file: string, keep: RegExp, drop?: RegExp): string[] {
  const sql = readFileSync(join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out: string[] = [];
  let cur = "";
  let tag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const m = /^\$\w*\$/.exec(sql.slice(i, i + 40));
    if (m) { tag = tag === null ? m[0] : tag === m[0] ? null : tag; cur += m[0]; i += m[0].length - 1; continue; }
    if (sql[i] === ";" && tag === null) { out.push(cur.trim()); cur = ""; continue; }
    cur += sql[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s && keep.test(s) && !(drop && drop.test(s)));
}

async function refused(p: Promise<unknown>, pattern?: RegExp): Promise<boolean> {
  try { await p; return false; } catch (e) { return pattern ? pattern.test(String((e as Error).message ?? e)) : true; }
}

const DOMAIN_TABLES = ["Document", "ReviewEvent", "FinancialRecord", "Payment", "PaymentAllocation", "Installment", "Commitment", "Payee", "BusinessInsight", "KnowledgeMeasure"];
async function domainCounts(): Promise<string> {
  const parts = await Promise.all(DOMAIN_TABLES.map(async (t) => `${t}=${(await owner.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n}`));
  return parts.join(",");
}

async function main(): Promise<void> {
  section("Provision — the lab mirrors Production's enforcement, plus the shipped M9 DDL");
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
  // The M9 DDL that `db push` cannot express: CHECKs, partial unique indexes, guards, RLS, policies.
  const m9 = sqlStatements(M9_MIGRATION,
    /^ALTER TABLE "\w+" ADD CONSTRAINT "\w+_chk"|^CREATE UNIQUE INDEX "\w+_one_active_key"|^CREATE OR REPLACE FUNCTION|^REVOKE ALL ON FUNCTION|^CREATE TRIGGER|ROW LEVEL SECURITY|^CREATE POLICY/);
  for (const s of m9) await owner.$executeRawUnsafe(s);
  check("the shipped M9 DDL replays (checks, partial indexes, 3 guards, 5 triggers, RLS, 12 policies)",
    m9.filter((s) => /^CREATE TRIGGER/.test(s)).length === 5 && m9.filter((s) => /^CREATE POLICY/.test(s)).length === 12 &&
    m9.filter((s) => /^CREATE OR REPLACE FUNCTION public\.m9_/.test(s)).length === 3 && m9.length === 45, `n=${m9.length}`);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  // …then the M9 grant block exactly as shipped, which REVOKEs what the blanket grant just gave.
  for (const s of sqlStatements(M9_MIGRATION, /^DO \$do\$/)) await owner.$executeRawUnsafe(s);
  // Closed Loop evidence: its CHECKs, append-only trigger, RLS, policies, then its grant block as shipped.
  const ev = sqlStatements(EVIDENCE_MIGRATION, /^ALTER TABLE "OutcomeRecommendationEvidence" ADD CONSTRAINT "\w+_chk"|^CREATE TRIGGER|ROW LEVEL SECURITY|^CREATE POLICY/);
  for (const s of ev) await owner.$executeRawUnsafe(s);
  for (const s of sqlStatements(EVIDENCE_MIGRATION, /^DO \$do\$/)) await owner.$executeRawUnsafe(s);
  check("the shipped evidence DDL replays (2 checks, 1 trigger, ENABLE + FORCE, 2 policies)",
    ev.length === 7 && ev.filter((s) => /^CREATE POLICY/.test(s)).length === 2 && ev.filter((s) => /^CREATE TRIGGER/.test(s)).length === 1, `n=${ev.length}`);

  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(`SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  check("the runtime role is NOSUPERUSER + NOBYPASSRLS", posture[0]?.s === false && posture[0]?.b === false);
  check("the application code is connected as the restricted role", (await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0]?.u === RT_ROLE);

  section("O1 — enforcement on the five M9 tables");
  const M9_TABLES = ["OutcomeRecommendation", "OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation", "OutcomeAssessment"];
  const cat = await rt.$queryRawUnsafe<{ t: string; r: boolean; f: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>(
    `SELECT c.relname AS t, c.relrowsecurity AS r, c.relforcerowsecurity AS f,
            has_table_privilege(current_user, c.oid, 'SELECT') AS sel, has_table_privilege(current_user, c.oid, 'INSERT') AS ins,
            has_table_privilege(current_user, c.oid, 'UPDATE') AS upd, has_table_privilege(current_user, c.oid, 'DELETE') AS del
       FROM pg_class c WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`, M9_TABLES);
  const row = (t: string) => cat.find((c) => c.t === t)!;
  check("all five are ENABLE + FORCE RLS", cat.length === 5 && cat.every((c) => c.r && c.f));
  check("decisions, actions, observations: SELECT + INSERT only (no UPDATE, no DELETE)",
    ["OutcomeDecision", "OutcomeActionEvent", "OutcomeObservation"].every((t) => row(t).sel && row(t).ins && !row(t).upd && !row(t).del));
  check("recommendations, assessments: no DELETE", ["OutcomeRecommendation", "OutcomeAssessment"].every((t) => row(t).upd && !row(t).del));
  const forAll = await owner.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM pg_policies WHERE tablename = ANY($1::text[]) AND cmd = 'ALL'`, M9_TABLES);
  check("no FOR ALL policy on any M9 table (per-command only)", forAll[0].n === 0);

  const { buildBusinessKnowledgeSnapshot } = await import("@/lib/knowledge/snapshot/build-snapshot");
  const { deriveOutcomesForBusiness } = await import("@/lib/knowledge/outcomes/outcome.service");
  const { appendOwnerDecision } = await import("@/lib/knowledge/outcomes/outcome-store");
  const { buildBrainContext, stableSerialize } = await import("@/lib/knowledge/brain/context-builder");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  section("Seed — two look-alike businesses: a review backlog and two overdue payments each");
  type Seed = { biz: number; docs: number[]; inst1: number; inst2: number; payee: number };
  const seeds: Seed[] = [];
  for (const label of ["A", "B"]) {
    const b = await owner.business.create({ data: { name: `M9 ${label} ${NONCE}` } });
    const docs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const d = await owner.document.create({ data: { businessId: b.id, fileUrl: `s3://m9/${NONCE}-${label}-${i}`, source: "upload",
        mimeType: "application/pdf", status: "needs_review", createdAt: at(-5) } as never });
      docs.push(d.id);
    }
    const payee = await owner.payee.create({ data: { businessId: b.id, displayName: "Secret Supplier Ltd", kind: "SUPPLIER" } as never });
    const cm = await owner.commitment.create({ data: { businessId: b.id, title: "lab", payeeId: payee.id, payeeNameSnapshot: "Secret Supplier Ltd",
      scheduleKind: "RECURRING", recurrence: "MONTHLY" } as never });
    const i1 = await owner.installment.create({ data: { businessId: b.id, commitmentId: cm.id, sequence: 1, scheduledAmount: 4321, dueAt: at(-10) } as never });
    const i2 = await owner.installment.create({ data: { businessId: b.id, commitmentId: cm.id, sequence: 2, scheduledAmount: 4322, dueAt: at(-8) } as never });
    seeds.push({ biz: b.id, docs, inst1: i1.id, inst2: i2.id, payee: payee.id });
  }
  const [A, B] = seeds;
  const snapAt = (b: number, d: number) => buildBusinessKnowledgeSnapshot(b, { asOf: at(d) });
  const derive = async (b: number, d: number, brain: Parameters<typeof deriveOutcomesForBusiness>[1]["brain"] = null) =>
    deriveOutcomesForBusiness(b, { asOf: at(d), snapshot: await snapAt(b, d), brain });
  const recsOf = (b: number) => owner.outcomeRecommendation.findMany({ where: { businessId: b }, orderBy: [{ recommendationKey: "asc" }, { version: "asc" }] });

  section("O2 — recommendations from governed knowledge (one linked to a validated finding)");
  const snapA0 = await snapAt(A.biz, 0);
  const instSlot = `fact|payables-schedule|installment|${A.inst1}`;
  check("A's snapshot states both overdue installments and the waiting documents",
    snapA0.knowledge.some((k) => k.slot === instSlot) && snapA0.knowledge.filter((k) => k.key === "documents-inbox").length === 4);
  const fakeBrain = {
    businessId: A.biz, status: "FINDINGS" as const, rejected: [],
    findings: [{ findingKey: "fk-lab-1", type: "ATTENTION" as const, priority: "HIGH" as const, uncertainty: "SUPPORTED" as const,
      observation: "x", interpretation: null, knowledgeSlots: [instSlot], findingSlots: [], conflictIds: [], gapSlots: [], subjects: [] }],
    meta: { contractVersion: "brain.v1" as const, promptVersion: "brain-prompt.v2", contextVersion: "brain-context.v2", provider: "fake", model: "fake-1",
      snapshotFingerprint: snapA0.snapshotFingerprint, contextFingerprint: "cfp", contextBytes: 1, contextOmitted: {}, modelCalled: true,
      latencyMs: 1, inputTokens: 1, outputTokens: 1, failureStage: null },
  };
  const r1 = await deriveOutcomesForBusiness(A.biz, { asOf: at(0), snapshot: snapA0, brain: fakeBrain });
  const rB = await derive(B.biz, 0);
  const recsA = await recsOf(A.biz);
  check("A: three recommendations — one review backlog, one per overdue installment",
    r1.failureStage === null && recsA.length === 3 && recsA.filter((r) => r.type === "SETTLE_OVERDUE_INSTALLMENT").length === 2, JSON.stringify(r1));
  const docRec = recsA.find((r) => r.type === "REVIEW_PENDING_DOCUMENTS")!;
  const rec1 = recsA.find((r) => r.type === "SETTLE_OVERDUE_INSTALLMENT" && r.subjectId === A.inst1)!;
  const rec2 = recsA.find((r) => r.type === "SETTLE_OVERDUE_INSTALLMENT" && r.subjectId === A.inst2)!;
  const aIds0 = recsA.map((r) => r.id);
  check("the backlog targets exactly A's four waiting documents", JSON.stringify(docRec.targets) === JSON.stringify([...A.docs].sort((a, b) => a - b)));
  check("every supporting slot exists in the snapshot it was derived from",
    recsA.every((r) => (r.supportingSlots as string[]).every((s) => snapA0.knowledge.some((k) => k.slot === s))));
  check("the finding-backed recommendation records the finding and Brain versions as its SOURCE",
    rec1.sourceKind === "BRAIN_FINDING" && rec1.sourceFindingKey === "fk-lab-1" && rec1.brainPromptVersion === "brain-prompt.v2" && rec1.type === "SETTLE_OVERDUE_INSTALLMENT");
  check("the others are KNOWLEDGE_RULE", rec2.sourceKind === "KNOWLEDGE_RULE" && docRec.sourceKind === "KNOWLEDGE_RULE");
  check("B got its own three, independently", rB.failureStage === null && (await recsOf(B.biz)).length === 3);

  section("E1 — the durable WHY: one evidence row per issued version, captured with it");
  const { loadOwnerRecommendations } = await import("@/lib/knowledge/outcomes/outcome-store");
  const { buildOwnerView, CAUSAL_PHRASES } = await import("@/lib/knowledge/outcomes/owner-view");
  const evA = await tenantTx(A.biz, (tx) => tx.outcomeRecommendationEvidence.findMany({ where: { businessId: A.biz } }));
  check("every one of A's three recommendations has exactly one evidence row, captured at issue",
    evA.length === 3 && new Set(evA.map((e) => e.recommendationId)).size === 3 && evA.every((e) => !e.capturedAfterIssue &&
      recsA.some((r) => r.id === e.recommendationId && r.issuedAt.getTime() === e.capturedAt.getTime())));
  const evInst = evA.find((e) => e.recommendationId === rec1.id);
  const fI = evInst?.facts as { installmentId?: number; daysOverdue?: number; coverage?: string } | undefined;
  check("installment evidence: the installment, 10 days overdue, nothing paid",
    evInst?.kind === "OVERDUE_INSTALLMENT" && fI?.installmentId === A.inst1 && fI?.daysOverdue === 10 && fI?.coverage === "NONE", JSON.stringify(fI));
  const evDoc = evA.find((e) => e.recommendationId === docRec.id);
  check("backlog evidence: four waiting documents, referenced by id",
    evDoc?.kind === "REVIEW_BACKLOG" && (evDoc.facts as { pendingCount?: number }).pendingCount === 4 &&
    JSON.stringify((evDoc.evidenceRefs as { id: number }[]).map((r) => r.id)) === JSON.stringify([...A.docs].sort((a, b) => a - b)));
  check("evidence carries no money and no names", !/4321|4322|Secret|s3:/.test(JSON.stringify(evA.map((e) => [e.facts, e.evidenceRefs]))));
  check("A's evidence is invisible inside B's tenant and without a tenant",
    (await tenantTx(B.biz, (tx) => tx.outcomeRecommendationEvidence.count({ where: { recommendationId: { in: aIds0 } } }))) === 0 &&
    (await rt.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "OutcomeRecommendationEvidence"`))[0].n === 0);
  check("the runtime cannot UPDATE or DELETE evidence",
    await refused(tenantTx(A.biz, (tx) => tx.outcomeRecommendationEvidence.updateMany({ where: { businessId: A.biz }, data: { factFingerprint: "x" } }))) &&
    await refused(tenantTx(A.biz, (tx) => tx.outcomeRecommendationEvidence.deleteMany({ where: { businessId: A.biz } }))));
  check("even the table owner cannot rewrite evidence (append-only trigger)",
    await refused(owner.outcomeRecommendationEvidence.update({ where: { id: evA[0].id }, data: { factFingerprint: "x" } }), /M9_APPEND_ONLY/));
  check("a second evidence row for the same version is refused",
    await refused(owner.outcomeRecommendationEvidence.create({ data: { businessId: A.biz, recommendationId: rec1.id, evidenceVersion: "rec-evidence.v1",
      kind: "OVERDUE_INSTALLMENT", facts: {}, evidenceRefs: [], factFingerprint: "x", capturedAt: at(0) } })));
  const surfaceA = await loadOwnerRecommendations(A.biz, at(0.1));
  check("the owner surface shows A's three, each intact (facts still hash to their fingerprint)",
    surfaceA.items.length === 3 && surfaceA.withoutEvidence === 0 && surfaceA.items.every((i) => i.evidence.intact));
  check("the owner surface of B never shows A's", (await loadOwnerRecommendations(B.biz, at(0.1))).items.every((i) => !aIds0.includes(i.id)));
  const rowI1 = surfaceA.items.find((i) => i.id === rec1.id)!;
  const viewI1 = buildOwnerView(rowI1, at(0.1));
  check("the owner view: WHAT names the installment, WHY says 10 days, ACCEPT hands off to the payment form",
    viewI1.what.includes("תשלום 1") && viewI1.why[0].includes("10 ימים") && viewI1.options[0].href === `/payables/${rowI1.context.commitment?.id}?pay=${A.inst1}`,
    JSON.stringify([viewI1.what, viewI1.why[0], viewI1.options[0]]));

  section("O3 — tenant isolation");
  const aIds = aIds0;
  const seenFromB = await tenantTx(B.biz, (tx) => tx.outcomeRecommendation.count({ where: { id: { in: aIds } } }));
  check("A's recommendations are invisible inside B's tenant", seenFromB === 0);
  const bare = await rt.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "OutcomeRecommendation"`);
  check("nothing is visible without a tenant", bare[0].n === 0);
  check("a write for A from inside B's tenant is refused by RLS",
    await refused(tenantTx(B.biz, (tx) => tx.outcomeRecommendation.create({ data: { ...recsA[0], id: undefined, businessId: A.biz, recommendationKey: "x", version: 9 } as never }))));
  check("a decision of B pointing at A's recommendation is refused by the composite key (even for the owner role)",
    await refused(owner.outcomeDecision.create({ data: { businessId: B.biz, recommendationId: rec1.id, recommendationVersion: 1, decision: "ACCEPT",
      actorUserId: 1, source: "OWNER_UI", decidedAt: at(0), idempotencyKey: `x-${NONCE}` } })));

  section("O4 — memory: the same situation is not raised twice");
  const r2 = await derive(A.biz, 0.01);
  check("a second derivation issues nothing and reports the dedupe",
    r2.recommendations?.issued === 0 && (r2.recommendations?.suppressed.DEDUPED_ACTIVE ?? 0) === 3 && (await recsOf(A.biz)).length === 3);
  check("… and the database allows only one ACTIVE version per identity",
    await refused(owner.outcomeRecommendation.create({ data: { ...recsA[0], id: undefined, version: 2, createdAt: undefined } as never }), /Unique constraint|one_active|duplicate key/i));

  section("O5 — owner decisions");
  const k1 = `idem-${NONCE}-1`;
  const d1 = await appendOwnerDecision(A.biz, rec1.id, 11, { recommendationVersion: 1, decision: "ACCEPT", idempotencyKey: k1 }, at(0.5));
  const d1b = await appendOwnerDecision(A.biz, rec1.id, 11, { recommendationVersion: 1, decision: "ACCEPT", idempotencyKey: k1 }, at(0.6));
  check("ACCEPT is appended; a retry with the same key returns the SAME decision",
    d1.ok && d1b.ok && d1.decisionId === d1b.decisionId && d1b.duplicate === true);
  const d2 = await appendOwnerDecision(A.biz, rec2.id, 11, { recommendationVersion: 1, decision: "REJECT", reasonCode: "ALREADY_HANDLED", idempotencyKey: `idem-${NONCE}-2` }, at(0.5));
  const keep = [...A.docs].sort((a, b) => a - b).slice(0, 2);
  const d3 = await appendOwnerDecision(A.biz, docRec.id, 11, { recommendationVersion: 1, decision: "MODIFY", modification: { targets: keep }, idempotencyKey: `idem-${NONCE}-3` }, at(0.5));
  check("REJECT (with a structured reason) and MODIFY (narrowed targets) are appended", d2.ok && d3.ok);
  const vm = await appendOwnerDecision(A.biz, rec1.id, 11, { recommendationVersion: 2, decision: "ACCEPT", idempotencyKey: `idem-${NONCE}-4` }, at(0.5));
  check("a decision about the wrong version is refused (VERSION_MISMATCH)", !vm.ok && vm.code === "VERSION_MISMATCH");
  const bRec = (await recsOf(B.biz))[0];
  const xt = await appendOwnerDecision(A.biz, bRec.id, 11, { recommendationVersion: 1, decision: "ACCEPT", idempotencyKey: `idem-${NONCE}-5` }, at(0.5));
  check("A's owner cannot decide B's recommendation (NOT_FOUND — it does not exist for A)", !xt.ok && xt.code === "NOT_FOUND");
  const bad = await appendOwnerDecision(A.biz, docRec.id, 11, { recommendationVersion: 1, decision: "MODIFY", modification: { targets: [999999] }, idempotencyKey: `idem-${NONCE}-6` }, at(0.5));
  check("MODIFY to a target outside the recommendation is refused", !bad.ok && bad.code === "INVALID_MODIFICATION");
  check("no decision exists for B: silence is recorded as nothing", (await owner.outcomeDecision.count({ where: { businessId: B.biz } })) === 0);

  section("O6 — history cannot be rewritten");
  const decRow = await owner.outcomeDecision.findFirst({ where: { businessId: A.biz } });
  check("the runtime cannot UPDATE a decision (no privilege)",
    await refused(tenantTx(A.biz, (tx) => tx.outcomeDecision.updateMany({ where: { id: decRow!.id }, data: { decision: "REJECT" } }))));
  check("the runtime cannot DELETE a decision (no privilege)",
    await refused(tenantTx(A.biz, (tx) => tx.outcomeDecision.deleteMany({ where: { id: decRow!.id } }))));
  check("even the table owner cannot UPDATE or DELETE a decision (trigger)",
    await refused(owner.outcomeDecision.update({ where: { id: decRow!.id }, data: { decision: "REJECT" } }), /M9_APPEND_ONLY/) &&
    await refused(owner.outcomeDecision.delete({ where: { id: decRow!.id } }), /M9_APPEND_ONLY/));
  check("a recommendation's content cannot change, even by the owner (trigger)",
    await refused(owner.outcomeRecommendation.update({ where: { id: rec1.id }, data: { targetCount: 99 } }), /M9_IMMUTABLE/));

  section("O7 — causal attribution cannot be stored");
  check("an assessment claiming a cause is refused by the database",
    await refused(owner.outcomeAssessment.create({ data: { businessId: A.biz, recommendationId: rec1.id, assessorVersion: "x", decisionState: "ACCEPT",
      actionState: "COMPLETED", outcomeState: "OBSERVED", direction: "SETTLED", attribution: "CAUSED", uncertainty: "x", windowStart: at(0), windowEnd: at(1),
      observationCount: 0, evidenceRefs: [], detail: {}, semanticHash: "x", assessedAt: at(0), confirmedAt: at(0) } })));

  section("O8 — the chain, from the ledger: review two documents, pay one installment");
  const before = await domainCounts();
  for (const [i, docId] of keep.entries()) {
    await owner.reviewEvent.create({ data: { documentId: docId, businessId: A.biz, reviewerUserId: 11, occurredAt: at(2 + i), approvedAs: "financial",
      explicitFinancial: true, verdicts: {}, rawBelief: {}, rawFinal: {} } as never });
    await owner.document.update({ where: { id: docId }, data: { status: "approved" } as never });
  }
  const pay = await owner.payment.create({ data: { businessId: A.biz, payeeId: A.payee, payeeNameSnapshot: "Secret Supplier Ltd", amount: 4321,
    paidAt: at(3), method: "BANK_TRANSFER", createdAt: at(3) } as never });
  const al = await owner.paymentAllocation.create({ data: { businessId: A.biz, paymentId: pay.id, installmentId: A.inst1, allocatedAmount: 4321, createdAt: at(3), createdByUserId: 11 } as never });
  const seeded = await domainCounts();
  const r40 = await derive(A.biz, 40);
  check("the derivation itself changed no business record", (await domainCounts()) === seeded);
  const asm = async (recId: number) => owner.outcomeAssessment.findFirst({ where: { businessId: A.biz, recommendationId: recId, status: "ACTIVE" } });
  const aDoc = await asm(docRec.id);
  const aI1 = await asm(rec1.id);
  const aI2 = await asm(rec2.id);
  check("backlog: MODIFY honoured → COMPLETED; backlog 4 → 2 at window end → DECREASED, OBSERVED_SEQUENCE",
    aDoc?.decisionState === "MODIFY" && aDoc.actionState === "COMPLETED" && aDoc.direction === "DECREASED" && aDoc.attribution === "OBSERVED_SEQUENCE", JSON.stringify(aDoc));
  check("installment 1: ACCEPT → payment recorded → settled → OBSERVED_SEQUENCE, uncertainty SEQUENCE_NOT_CAUSE",
    aI1?.decisionState === "ACCEPT" && aI1.actionState === "COMPLETED" && aI1.outcomeState === "OBSERVED" && aI1.attribution === "OBSERVED_SEQUENCE" && aI1.uncertainty === "SEQUENCE_NOT_CAUSE", JSON.stringify(aI1));
  check("installment 2: REJECT, nothing done → NOT_ASSESSABLE", aI2?.decisionState === "REJECT" && aI2.actionState === "NOT_STARTED" && aI2.attribution === "NOT_ASSESSABLE");
  const acts = await owner.outcomeActionEvent.findMany({ where: { businessId: A.biz } });
  check("the action events link the REAL domain records (ReviewEvent ×2, PaymentAllocation) and the owner's decisions",
    acts.filter((x) => x.domainStore === "ReviewEvent" && x.decisionId === (d3.ok ? d3.decisionId : -1)).length === 2 &&
    acts.some((x) => x.domainStore === "PaymentAllocation" && x.domainRecordId === al.id && x.decisionId === (d1.ok ? d1.decisionId : -1)));
  const recsA40 = await recsOf(A.biz);
  const afterI1 = buildOwnerView((await loadOwnerRecommendations(A.biz, at(40), { id: rec1.id })).items[0], at(40));
  check("AFTER view: the payment is stated in sequence, never as a cause",
    afterI1.after.some((l) => l.startsWith("לאחר ההמלצה והפעולה, התשלום נרשם")) &&
    !CAUSAL_PHRASES.some((p) => [afterI1.what, ...afterI1.why, ...afterI1.after].join(" ").includes(p)), JSON.stringify(afterI1.after));
  check("lifecycle: backlog and installment 1 RESOLVED; installment 2 EXPIRED (unanswered is not the case — it was rejected) and NOT re-issued",
    recsA40.find((r) => r.id === docRec.id)?.status === "RESOLVED" && recsA40.find((r) => r.id === rec1.id)?.status === "RESOLVED" &&
    recsA40.find((r) => r.id === rec2.id)?.status === "EXPIRED" && (r40.recommendations?.suppressed.SUPPRESSED_REJECTED ?? 0) === 1 && recsA40.length === 3);

  section("O9 — replay: nothing new, assessments confirmed");
  const r40b = await derive(A.biz, 40);
  check("the same derivation again inserts no action, no observation, no assessment",
    r40b.tracking?.actionsInserted === 0 && r40b.tracking?.observationsInserted === 0 && r40b.assessments?.written === 0 && (r40b.assessments?.confirmed ?? 0) === 3,
    JSON.stringify(r40b.assessments));

  section("O10 — reversal: the payment is voided");
  await owner.payment.update({ where: { id: pay.id }, data: { status: "VOID", voidedAt: at(41), voidedByUserId: 11, voidReason: "lab" } as never });
  const r42 = await derive(A.biz, 42);
  const aI1b = await asm(rec1.id);
  const obsA = await owner.outcomeObservation.findMany({ where: { businessId: A.biz, recommendationId: rec1.id } });
  check("a REVERSED action and a settlement-reversal observation are APPENDED",
    (await owner.outcomeActionEvent.count({ where: { businessId: A.biz, eventType: "REVERSED", domainRecordId: al.id } })) === 1 &&
    obsA.some((o) => o.kind === "INSTALLMENT_SETTLEMENT_REVERSED" && o.reversesObservationId != null) && obsA.some((o) => o.kind === "INSTALLMENT_SETTLED"));
  check("the old assessment is SUPERSEDED (kept), the new one says REVERSED and no longer claims a sequence",
    (await owner.outcomeAssessment.count({ where: { businessId: A.biz, recommendationId: rec1.id, status: "SUPERSEDED" } })) >= 1 &&
    aI1b?.actionState === "REVERSED" && aI1b.attribution === "NOT_ASSESSABLE");
  check("the installment is overdue again, so its situation recurs as version 2 (the owner had accepted, and it had resolved)",
    (await recsOf(A.biz)).some((r) => r.type === "SETTLE_OVERDUE_INSTALLMENT" && r.subjectId === A.inst1 && r.version === 2 && r.status === "ACTIVE") && r42.recommendations?.issued === 1);

  section("O11 — deterministic rebuild from the ledger");
  const hashes = async () => (await owner.outcomeAssessment.findMany({ where: { businessId: A.biz, status: "ACTIVE" }, select: { recommendationId: true, semanticHash: true } }))
    .map((x) => `${x.recommendationId}:${x.semanticHash}`).sort().join();
  const obsKeys = async () => (await owner.outcomeObservation.findMany({ where: { businessId: A.biz }, select: { idempotencyKey: true } })).map((x) => x.idempotencyKey).sort().join();
  const h1 = await hashes();
  const o1 = await obsKeys();
  for (const t of ["OutcomeObservation", "OutcomeActionEvent", "OutcomeAssessment"]) {
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    await owner.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "businessId" = $1`, A.biz);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
  }
  await derive(A.biz, 42);
  check("wiped tracking and assessments are rebuilt from the ledger to the SAME observation keys and assessment hashes",
    (await hashes()) === h1 && (await obsKeys()) === o1, `${(await hashes()) === h1} ${(await obsKeys()) === o1}`);

  section("O12 — feedback: the next snapshot carries the learning, per business");
  const snapA = await snapAt(A.biz, 42);
  const mem = snapA.knowledge.filter((k) => k.kind === "RECOMMENDATION_MEMORY");
  check("A's snapshot remembers every recommendation identity, with the owner's decision beside the ledger's action",
    mem.length === 3 && mem.some((m) => m.value.ownerDecision === "REJECT") && mem.some((m) => m.value.ownerDecision === "MODIFY"));
  check("patterns below five decisions are GAPS, and the causal question is a standing gap",
    !snapA.knowledge.some((k) => k.kind === "DECISION_PATTERN") && snapA.knowledgeGaps.some((g) => g.key === "outcomes.decision_pattern.SETTLE_OVERDUE_INSTALLMENT")
    && snapA.knowledgeGaps.some((g) => g.slot === "gap|outcomes|CAUSAL_ATTRIBUTION"));
  const ctx = buildBrainContext(snapA);
  const out = stableSerialize(ctx.context);
  check("the Brain context carries the memory — and no name, amount or id", ctx.context.knowledge.some((k) => k.kind === "RECOMMENDATION_MEMORY") &&
    !/Secret Supplier|4321|4322/.test(out) && !out.includes('"businessId"') && !out.includes('"id"'));
  const snapB = await snapAt(B.biz, 42);
  const bRecIds = new Set((await recsOf(B.biz)).map((r) => r.id));
  check("B's snapshot learns only from B (no cross-business outcome learning)",
    snapB.knowledge.filter((k) => k.kind === "RECOMMENDATION_MEMORY").every((k) => k.provenance.every((p) => p.store !== "OutcomeRecommendation" || bRecIds.has(Number(p.id)))) &&
    !snapB.knowledge.some((k) => k.value.ownerDecision === "REJECT"));

  section("O12b — the Production guard probe, run here as the same restricted role");
  const { probeOutcomeGuards } = await import("@/lib/knowledge/outcomes/outcome-store");
  const countsBeforeProbe = `${await owner.outcomeRecommendation.count()}|${await owner.outcomeDecision.count()}|${await owner.outcomeAssessment.count()}`;
  const probe = await probeOutcomeGuards(A.biz);
  check("the guard probe HOLDS as the runtime: catalog as designed; every forbidden write refused with the expected code",
    probe.holds, JSON.stringify(probe));
  check("… and it persisted nothing", `${await owner.outcomeRecommendation.count()}|${await owner.outcomeDecision.count()}|${await owner.outcomeAssessment.count()}` === countsBeforeProbe);

  section("O13 — no mutation, failures and the kill switch");
  check("across the whole loop, no business record was changed by M9 (only the lab's own seeding)", (await domainCounts()) !== before && (await domainCounts()) === seeded);
  const recCount = await owner.outcomeRecommendation.count();
  const mism = await deriveOutcomesForBusiness(A.biz, { asOf: at(43), snapshot: snapB, brain: null });
  check("knowledge of another business is refused before any read or write", mism.failureStage === "tenant_mismatch" && (await owner.outcomeRecommendation.count()) === recCount);
  process.env.OUTCOMES_MODE = "off";
  const off = await derive(A.biz, 43);
  delete process.env.OUTCOMES_MODE;
  check("OUTCOMES_MODE=off writes nothing", off.mode === "off" && (await owner.outcomeRecommendation.count()) === recCount);
  const report = JSON.stringify(r40);
  check("the operational report carries counts and codes only — no names, amounts or text",
    !/Secret|4321|4322|needs_review/.test(report) && typeof r40.recommendations?.issued === "number");

  console.log(`\nM9 outcome battery: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(fails.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
  await rt.$disconnect();
}

main().catch((e) => { console.error("battery crashed:", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => owner.$disconnect());
