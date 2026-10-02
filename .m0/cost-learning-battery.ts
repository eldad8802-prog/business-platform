/* eslint-disable @typescript-eslint/no-explicit-any -- reads heterogeneous measure-detail JSON in assertions */
/**
 * Business Cost learning, Wave 1 — the database proof.
 *
 * Real PostgreSQL, the shipped tenant policies replayed, and a MEASURED NOSUPERUSER NOBYPASSRLS
 * runtime role for everything the product does: the ledger is written through the payables services
 * themselves (createCommitment / recordManualPayment / changeRecurringAmountFrom / endCommitment),
 * knowledge is derived by the real `deriveKnowledgeForBusiness`, and insights by the real
 * `generateInsightsForBusiness`.
 *
 * WHAT IT PROVES
 *   G1  FAIL-CLOSED: without the Wave-1 lineage rows the four cost rules write nothing
 *   W1  COST-02 learns a recorded rent change 8,000 → 8,800 (explicit amount-change event)
 *   W2  COST-04 learns a genuinely new, material leasing commitment against the previous baseline
 *   W3  COST-05 learns an explicitly ended subscription
 *   W4  COST-08 measures trustworthy history from recorded truth and names B's unallocated cash
 *   W5  the insights are deterministic FACT text: no interpretation, no suggested action
 *   W6  re-deriving is idempotent: same fingerprints, insights refreshed not duplicated
 *   T1  every evidence link of A's cost measures points at A's own rows
 *   T2  under A's context the runtime sees no B measure / insight / link, and vice versa
 *   T3  with no tenant context the runtime sees nothing
 *
 * Usage (CI provides the database):
 *   M0_ADMIN_URL=postgresql://... node_modules/.bin/tsx .m0/cost-learning-battery.ts
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
const RT_ROLE = `cost_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
const DAY = 86_400_000;

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail: unknown = ""): void {
  if (cond) passed++;
  else failed++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond || detail === "" ? "" : ` — ${JSON.stringify(detail)}`}`);
}
const section = (t: string) => console.log(`\n== ${t} ==`);

const owner = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

function statements(file: string, keep: (s: string) => boolean): string[] {
  const sql = readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return sql.split(";").map((s) => s.trim()).filter((s) => s && keep(s));
}
const tenantPolicies = () =>
  [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260917090100_payables_phase_1a_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
  ].flatMap((f) => statements(f, (s) => /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/.test(s) && !/app_admin/.test(s)));
const priorLineages = () => [
  ...statements("prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql", (s) => /^INSERT INTO "DerivationPolicy/.test(s)),
  ...statements("prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql", (s) => /^INSERT INTO "DerivationPolicyVersion"/.test(s)),
];
const waveOneLineages = () =>
  statements("prisma/migrations/20261005090000_cost_learning_wave1_policies/migration.sql", (s) => /^INSERT INTO "DerivationPolicy/.test(s));

const COST_KEYS = ["payables.cost_data_completeness", "payables.recurring_amount_change", "payables.new_material_commitment", "payables.ended_commitment"];

async function main(): Promise<void> {
  section("Provision — a lab that mirrors Production's enforcement");
  await owner.$executeRawUnsafe(`CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`);
  for (const s of tenantPolicies()) await owner.$executeRawUnsafe(s);
  for (const s of priorLineages()) await owner.$executeRawUnsafe(s);
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);
  const posture = await owner.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${RT_ROLE}'`);
  check("runtime role is NOSUPERUSER and NOBYPASSRLS", posture[0]?.rolsuper === false && posture[0]?.rolbypassrls === false);
  const forced = await owner.$queryRawUnsafe<{ relname: string; f: boolean }[]>(
    `SELECT c.relname, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('KnowledgeMeasure','KnowledgeMeasureEvidenceLink','BusinessInsight','Commitment','Installment','Payment','PaymentAllocation','PayablesAuditEvent')`,
  );
  check("every table this learning reads or writes is FORCE RLS", forced.length === 8 && forced.every((r) => r.f), forced);

  const bizA = await owner.business.create({ data: { name: `Cost A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `Cost B ${NONCE}` } });

  const rtUrl = new URL(ADMIN_URL!);
  rtUrl.username = RT_ROLE;
  rtUrl.password = RT_PW;
  process.env.DATABASE_URL = rtUrl.toString();
  process.env.DIRECT_URL = rtUrl.toString();
  const payables = await import("@/lib/services/payables/payables.service");
  const { deriveKnowledgeForBusiness } = await import("@/lib/knowledge/derive.service");
  const { generateInsightsForBusiness } = await import("@/lib/knowledge/insight.service");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { prisma: rt } = await import("@/lib/prisma");
  const { civilDateInZone, fromDayNumber, toDayNumber } = await import("@/lib/services/business-cost/business-cost-core");

  const NOW = new Date();
  const T = toDayNumber(civilDateInZone(NOW, "Asia/Jerusalem"));
  const at = (day: number, hour = 6) => new Date(day * DAY + hour * 3_600_000);
  const monthStart = (back: number) => {
    const d = new Date(T * DAY);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) / DAY;
  };
  const as = <X>(b: number, fn: () => Promise<X>) => runWithTenantContext({ businessId: b }, fn);
  const latest = async (b: number, commitmentId: number) =>
    owner.installment.findFirstOrThrow({ where: { businessId: b, commitmentId, status: "SCHEDULED" }, orderBy: { sequence: "desc" } });
  /** Pay every occurrence due on or before `untilDay`, on its due date, in full. */
  async function payThrough(b: number, commitmentId: number, untilDay: number): Promise<void> {
    for (let guard = 0; guard < 60; guard++) {
      const i = await latest(b, commitmentId);
      const due = toDayNumber(civilDateInZone(i.dueAt, "Asia/Jerusalem"));
      if (due > untilDay) return;
      await as(b, () => payables.recordManualPayment({ businessId: b, commitmentId, installmentIds: [i.id], amount: i.scheduledAmount.toString(), paidAt: at(due, 9), method: "BANK_TRANSFER" }));
    }
  }
  const create = (b: number, title: string, amount: string, firstDay: number, extra: Record<string, unknown> = {}) =>
    as(b, () => payables.createCommitment({ businessId: b, title, payeeNameSnapshot: title, scheduleKind: "RECURRING", recurrence: "MONTHLY", recurringAmount: amount, firstDueAt: at(firstDay), ...extra } as Parameters<typeof payables.createCommitment>[0]));

  section("Seed through the payables services, as the runtime role");
  // A · rent 8,000 for a year, raised to 8,800 from last month (explicit amount change), both paid.
  const rent = await create(bizA.id, "שכירות", "8000", monthStart(12));
  await payThrough(bizA.id, rent.id, monthStart(1) - 1);
  await as(bizA.id, () => payables.changeRecurringAmountFrom({ businessId: bizA.id, commitmentId: rent.id, effectiveFrom: at(monthStart(1), 0), amount: "8800" }));
  await payThrough(bizA.id, rent.id, T);
  // A · software 450 for six months, explicitly ended yesterday.
  const software = await create(bizA.id, "תוכנה", "450", monthStart(6) + 9);
  await payThrough(bizA.id, software.id, T - 1);
  await as(bizA.id, () => payables.endCommitment({ businessId: bizA.id, commitmentId: software.id, endsOn: new Date((T - 1) * DAY) }));
  // A · leasing 2,400, started ten days ago, recorded today: genuinely new.
  const leasing = await create(bizA.id, "ליסינג", "2400", T - 10);
  await payThrough(bizA.id, leasing.id, T);
  // B · rent 9,000 for six months, plus cash tied to nothing.
  const rentB = await create(bizB.id, "שכירות B", "9000", monthStart(6));
  await payThrough(bizB.id, rentB.id, T);
  const rentBInst = await latest(bizB.id, rentB.id);
  await as(bizB.id, () => payables.createCommitment({ businessId: bizB.id, title: "חד פעמי B", payeeNameSnapshot: "x", scheduleKind: "ONE_OFF", totalAmount: "50000", firstDueAt: at(T) } as Parameters<typeof payables.createCommitment>[0]));
  void rentBInst;
  check("fixtures exist for both tenants", (await owner.commitment.count({ where: { businessId: { in: [bizA.id, bizB.id] } } })) === 5);

  section("G1 · fail-closed before the Wave-1 lineages exist");
  const before = await deriveKnowledgeForBusiness(bizA.id, NOW);
  const costReports = before.rules.filter((r) => COST_KEYS.includes(r.measureKey));
  check("the four cost rules are in the catalogue", costReports.length === 4);
  check("each refuses at the 'policy' stage", costReports.every((r) => r.outcome === "failed" && r.failedStage === "policy"), costReports.map((r) => [r.ruleId, r.failedStage]));
  check("…and nothing was written", (await owner.knowledgeMeasure.count({ where: { businessId: bizA.id, measureKey: { in: COST_KEYS } } })) === 0);

  section("Apply the migration's governance rows");
  for (const s of waveOneLineages()) await owner.$executeRawUnsafe(s);
  const lineages = await owner.derivationPolicy.findMany({ where: { key: { startsWith: "payables-" } }, include: { versions: true } });
  check("four Wave-1 lineages with v1", ["payables-cost-data-completeness", "payables-recurring-amount-change", "payables-new-material-commitment", "payables-ended-commitment"].every((k) => lineages.find((l) => l.key === k)?.versions.some((v) => v.version === "v1")));

  section("W1–W4 · derive");
  const repA = await deriveKnowledgeForBusiness(bizA.id, NOW);
  check("all four cost rules ran ok for A", repA.rules.filter((r) => COST_KEYS.includes(r.measureKey)).every((r) => r.outcome === "ok"), repA.rules.filter((r) => COST_KEYS.includes(r.measureKey)).map((r) => [r.ruleId, r.outcome, r.failureDetail]));
  await deriveKnowledgeForBusiness(bizB.id, NOW);
  const mA = await owner.knowledgeMeasure.findMany({ where: { businessId: bizA.id, measureKey: { in: COST_KEYS } } });
  const one = (k: string, entityId?: number) => mA.find((m) => m.measureKey === k && (entityId === undefined || m.entityId === entityId));
  const d = (m: { detail: unknown } | undefined) => (m?.detail ?? {}) as Record<string, any>;
  const change = one("payables.recurring_amount_change", rent.id);
  check("W1 COST-02: rent changed +800/month, 8,000 → 8,800, explicit", change?.status === "ACTIVE" && Number(change.valueNumeric) === 800 && d(change).fromMinor === 800000 && d(change).toMinor === 880000 && d(change).confirmation === "EXPLICIT_AMOUNT_CHANGE", change && d(change));
  check("W1 …effective on last month's occurrence", d(change).effectiveDate === fromDayNumber(monthStart(1)));
  const added = one("payables.new_material_commitment", leasing.id);
  const expectedBp = Math.round((240000 * 10000) / (880000 + 45000));
  check("W2 COST-04: leasing 2,400 is new and material vs 9,250", added?.status === "ACTIVE" && Number(added.valueNumeric) === 2400 && d(added).priorBaselineMonthlyMinor === 925000 && d(added).shareBp === expectedBp, added && d(added));
  check("W2 …rent and software are NOT reported as new (started long before)", !mA.some((m) => m.measureKey === "payables.new_material_commitment" && m.status === "ACTIVE" && (m.entityId === rent.id || m.entityId === software.id)));
  const ended = one("payables.ended_commitment", software.id);
  check("W3 COST-05: software explicitly ended yesterday, 450/month left", ended?.status === "ACTIVE" && Number(ended.valueNumeric) === 450 && d(ended).endsOn === fromDayNumber(T - 1), ended && d(ended));
  check("W3 …no other commitment is reported as ended", mA.filter((m) => m.measureKey === "payables.ended_commitment").length === 1);
  const gate = one("payables.cost_data_completeness");
  check("W4 COST-08 (A): trustworthy history from recorded truth, ≥ 300 days", gate?.status === "ACTIVE" && Number(gate.valueNumeric) >= 300, gate && Number(gate.valueNumeric));
  const gateB = await owner.knowledgeMeasure.findFirst({ where: { businessId: bizB.id, measureKey: "payables.cost_data_completeness" } });
  check("W4 COST-08 (B): its one-off with unknown coverage is a named gap", ((gateB?.detail as any)?.gaps ?? []).includes("ONE_OFF_COVERAGE_UNKNOWN"), gateB?.detail);
  check("W4 COST-08 (B): six months is not enough for 180-day patterns unless recorded as covered", typeof (gateB?.detail as any)?.eligibility?.["COST-06"]?.eligible === "boolean");

  section("W5 · insights");
  await generateInsightsForBusiness(bizA.id);
  const insA = await owner.businessInsight.findMany({ where: { businessId: bizA.id, insightKey: { startsWith: "cost." } } });
  const ins = (k: string) => insA.find((i) => i.insightKey === k);
  const lines = (k: string) => ((ins(k)?.factLines ?? []) as Array<{ text: string }>).map((l) => l.text);
  check("three fact insights for A", ["cost.recurring_amount_changed", "cost.new_material_commitment", "cost.ended_commitment"].every((k) => !!ins(k)), insA.map((i) => i.insightKey));
  const [y, mo] = fromDayNumber(monthStart(1)).split("-");
  check("rent insight: named from the tenant's own commitment, numbers from the evidence",
    ins("cost.recurring_amount_changed")?.title === "שכירות: הסכום השתנה" && lines("cost.recurring_amount_changed")[0] === `הסכום השתנה מ־8,000 ₪ ל־8,800 ₪ החל מ־1/${Number(mo)}/${y}`, [ins("cost.recurring_amount_changed")?.title, lines("cost.recurring_amount_changed")]);
  check("ended insight: 450 ₪ a month left the fixed cost", lines("cost.ended_commitment")[1] === "450 ₪ לחודש יצאו מהעלות הקבועה");
  check("FACT only: no interpretation, no suggested action", insA.every((i) => i.interpretation === null && Array.isArray(i.suggestedActions) && (i.suggestedActions as unknown[]).length === 0));

  section("W6 · idempotent");
  const fp1 = (await owner.knowledgeMeasure.findMany({ where: { businessId: bizA.id, measureKey: { in: COST_KEYS } }, orderBy: [{ measureKey: "asc" }, { entityId: "asc" }] })).map((m) => `${m.measureKey}:${m.entityId}:${m.evidenceFingerprint}:${m.valueNumeric}`);
  await deriveKnowledgeForBusiness(bizA.id, NOW);
  await generateInsightsForBusiness(bizA.id);
  const fp2 = (await owner.knowledgeMeasure.findMany({ where: { businessId: bizA.id, measureKey: { in: COST_KEYS }, status: { not: "SUPERSEDED" } }, orderBy: [{ measureKey: "asc" }, { entityId: "asc" }] })).map((m) => `${m.measureKey}:${m.entityId}:${m.evidenceFingerprint}:${m.valueNumeric}`);
  check("re-derive: identical measures and fingerprints", JSON.stringify(fp1) === JSON.stringify(fp2), { fp1, fp2 });
  check("re-generate: insights refreshed in place, not duplicated", (await owner.businessInsight.count({ where: { businessId: bizA.id, insightKey: { startsWith: "cost." } } })) === insA.length);

  section("T1–T3 · tenant isolation");
  const links = await owner.knowledgeMeasureEvidenceLink.findMany({ where: { measure: { businessId: bizA.id, measureKey: { in: COST_KEYS } } } });
  const owned = async (kind: string, rid: number): Promise<boolean> => {
    const row =
      kind === "installment" ? await owner.installment.findUnique({ where: { id: rid }, select: { businessId: true } }) :
      kind === "payment" ? await owner.payment.findUnique({ where: { id: rid }, select: { businessId: true } }) :
      kind === "payables-audit-event" ? await owner.payablesAuditEvent.findUnique({ where: { id: rid }, select: { businessId: true } }) :
      kind === "commitment" ? await owner.commitment.findUnique({ where: { id: rid }, select: { businessId: true } }) : null;
    return row?.businessId === bizA.id;
  };
  let allOwned = links.length > 0;
  for (const l of links) if (l.businessId !== bizA.id || !(await owned(l.evidenceKind, l.evidenceRecordId))) allOwned = false;
  check(`T1 every one of A's ${links.length} cost evidence links points at A's own rows`, allOwned);
  const visible = async (ctx: number | null) =>
    rt.$transaction(async (tx) => {
      if (ctx !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', '${ctx}', true)`);
      const m = await tx.$queryRawUnsafe<{ b: number }[]>(`SELECT "businessId" AS b FROM "KnowledgeMeasure" WHERE "measureKey" = ANY($1::text[])`, COST_KEYS);
      const i = await tx.$queryRawUnsafe<{ b: number }[]>(`SELECT "businessId" AS b FROM "BusinessInsight" WHERE "insightKey" LIKE 'cost.%'`);
      const l = await tx.$queryRawUnsafe<{ b: number }[]>(`SELECT "businessId" AS b FROM "KnowledgeMeasureEvidenceLink"`);
      return { m, i, l };
    });
  const underA = await visible(bizA.id);
  check("T2 under A: A's measures/insights/links visible, none of B's",
    underA.m.length > 0 && underA.i.length > 0 && [...underA.m, ...underA.i, ...underA.l].every((r) => r.b === bizA.id));
  const underB = await visible(bizB.id);
  check("T2 under B: none of A's", [...underB.m, ...underB.i, ...underB.l].every((r) => r.b === bizB.id));
  const none = await visible(null);
  check("T3 no tenant context: nothing at all", none.m.length === 0 && none.i.length === 0 && none.l.length === 0, { m: none.m.length, i: none.i.length, l: none.l.length });

  await rt.$disconnect();
}

main()
  .catch((e) => {
    failed++;
    console.error(e);
  })
  .finally(async () => {
    await owner.$executeRawUnsafe(`DROP OWNED BY ${RT_ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => {});
    await owner.$disconnect();
    console.log(`\nCost learning battery: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
