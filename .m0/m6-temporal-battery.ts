/**
 * M6 · Temporal knowledge — the battery.
 *
 * Real PostgreSQL, the shipped tenant policies and the M6 migration's own grants replayed, and a
 * runtime role MEASURED NOSUPERUSER + NOBYPASSRLS before anything is believed. It runs the real
 * derivation service and writer, as that role, against two tenants that look alike.
 *
 *   T1  tenant isolation: A's temporal knowledge is invisible to B and to a context-less connection;
 *       a cross-tenant write is refused
 *   T2  a new business gets INSUFFICIENT_HISTORY with its reason — never an invented baseline
 *   T3  baseline, stable pattern, anomaly: from real rows, through the real service
 *   T4  idempotency: the same derivation again writes nothing new, it confirms
 *   T5  as-of: a rebuild at the same instant reproduces the same fingerprints
 *   T6  reversal: a reversed allocation stops being evidence; the old artifact is SUPERSEDED, not lost
 *   T7  versioning: a new rule version supersedes the old version's rows
 *   T8  staleness: much later, the quiet subject's baseline is STALE and its anomaly no longer current
 *   T9  identity: two vendor spellings without a confirmed link stay two subjects
 *   T10 append-only: the runtime cannot DELETE temporal history
 *   T11 privacy: the derivation report carries no learned value
 *
 * Output is labels and PASS/FAIL only.
 *
 * Usage (CI provides the database):   M0_ADMIN_URL=postgresql://... npx tsx .m0/m6-temporal-battery.ts
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
const RT_ROLE = `m6_rt_${NONCE}`;
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
  const sql = readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const out: string[] = [];
  for (const m of sql.matchAll(/\s*(?:DO \$do\$[\s\S]*?\$do\$|[^;]+);?/g)) {
    const s = m[0].trim().replace(/;$/, "").trim();
    if (s && keep.test(s) && !(drop && drop.test(s))) out.push(s);
  }
  return out;
}

async function main(): Promise<void> {
  section("Provision — the lab mirrors Production's enforcement");
  await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${GROUP}')
    THEN CREATE ROLE ${GROUP} NOLOGIN; END IF; END $$`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION IN ROLE ${GROUP}`,
  );
  const policyFiles = [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql",
    "prisma/migrations/20260917090100_payables_phase_1a_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql",
  ];
  for (const f of policyFiles) {
    for (const s of sqlStatements(f, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/, /app_admin/)) await owner.$executeRawUnsafe(s);
  }
  for (const f of [
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql",
    "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql",
  ]) {
    for (const s of sqlStatements(f, /^INSERT INTO "DerivationPolicy/)) await owner.$executeRawUnsafe(s);
  }
  const temporalVersions = await owner.derivationPolicyVersion.count({ where: { policy: { key: { startsWith: "temporal-" } } } });
  check("the M6 migration seeds ten temporal rule lineages", temporalVersions === 10, `n=${temporalVersions}`);

  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  // The M6 migration's own grant block, exactly as shipped (it REVOKEs DELETE/TRUNCATE).
  for (const s of sqlStatements("prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql", /GRANT|REVOKE/)) {
    await owner.$executeRawUnsafe(s);
  }

  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(
    `SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  check("the runtime role is NOSUPERUSER", posture[0]?.s === false);
  check("the runtime role is NOBYPASSRLS", posture[0]?.b === false);
  const tk = await owner.$queryRawUnsafe<{ r: boolean; f: boolean }[]>(
    `SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname='TemporalKnowledge'`);
  check("TemporalKnowledge is ENABLE + FORCE RLS", tk[0]?.r === true && tk[0]?.f === true);

  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  check("the application code is connected as the restricted role",
    (await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0]?.u === RT_ROLE);

  const { deriveTemporalForBusiness } = await import("@/lib/knowledge/temporal/derive-temporal.service");
  const { writeTemporalKnowledge } = await import("@/lib/knowledge/temporal/temporal-writer");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { resolveIdentitiesForBusiness } = await import("@/lib/identity/entity-identity.service");

  /* ══════════════════ SEED ══════════════════ */
  section("Seed — a business with a year of filing history, and one with none");
  const bizA = await owner.business.create({ data: { name: `M6 A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `M6 B ${NONCE}` } });
  const bizNew = await owner.business.create({ data: { name: `M6 New ${NONCE}` } });

  let docN = 0;
  async function doc(biz: number, approvedAgo: number, lagDays: number, vendorName = "Lab Vendor", amount = 100, direction = "expense") {
    const d = await owner.document.create({
      data: { businessId: biz, fileUrl: `s3://m6/${NONCE}-${++docN}`, source: "upload", mimeType: "application/pdf", status: "approved" } as never,
    });
    await owner.financialRecord.create({
      data: { documentId: d.id, businessId: biz, amount, date: ago(approvedAgo + lagDays), vendorName, direction,
        category: "lab", approvedAt: ago(approvedAgo) } as never,
    });
  }
  // A: 24 documents over the history window, filed 3–5 days after their date — a steady habit.
  for (let i = 0; i < 24; i++) await doc(bizA.id, 100 + i * 14, 3 + (i % 3));
  // …and a recent window that is normal except for ONE document filed 45 days late.
  for (const [a, lag] of [[10, 4], [25, 3], [40, 5], [60, 45]] as const) await doc(bizA.id, a, lag);
  // B looks similar but files everything a month late — if A ever saw B, A's normal would move.
  for (let i = 0; i < 24; i++) await doc(bizB.id, 100 + i * 14, 30);

  /* ══════════════════ T3 — real derivation ══════════════════ */
  section("T3 — baseline, stable pattern and anomaly, through the real service");
  const repA = await deriveTemporalForBusiness(bizA.id, AS_OF);
  check("every temporal rule ran", repA.rulesFailed === 0 && repA.rulesRun === 10, `failed=${repA.rulesFailed}`);
  const rowsA = await owner.temporalKnowledge.findMany({
    where: { businessId: bizA.id, temporalKey: "documents.paperwork_lag", contextKey: "", status: { in: ["ACTIVE", "INSUFFICIENT_HISTORY"] } },
  });
  const t = (k: string) => rowsA.find((r) => r.knowledgeType === k);
  check("BASELINE is ACTIVE with A's own median (3–5 days, not B's 30)",
    t("BASELINE")?.status === "ACTIVE" && Number((t("BASELINE")?.baseline as { median: number })?.median) <= 5,
    `median=${(t("BASELINE")?.baseline as { median?: number } | undefined)?.median}`);
  check("STABLE_PATTERN: a consistent habit is recognised as one", t("STABLE_PATTERN")?.status === "ACTIVE");
  check("ANOMALY names the one 45-day filing, against A's own history",
    t("ANOMALY")?.status === "ACTIVE" && ((t("ANOMALY")?.finding as { observations: unknown[] })?.observations.length === 1));
  check("…and it is not called a material change or an upward trend",
    !t("MATERIAL_CHANGE") && (t("TREND")?.finding as { direction?: string } | null)?.direction !== "UP");
  check("every artifact carries rule version, asOf, windows, counts and an evidence fingerprint",
    rowsA.every((r) => r.rulePolicyVersionId > 0 && r.asOf.getTime() === AS_OF.getTime() &&
      r.historyCount >= 0 && r.evidenceFingerprint.length === 64 && Array.isArray(r.evidenceRefs)));
  const ctx = await owner.temporalKnowledge.findFirst({
    where: { businessId: bizA.id, temporalKey: "documents.paperwork_lag", contextKey: "direction=income" },
  });
  check("a context slice with no history does not exist rather than borrowing another business",
    ctx == null || ctx.status === "INSUFFICIENT_HISTORY");

  /* ══════════════════ T1 — isolation ══════════════════ */
  section("T1 — temporal knowledge does not cross tenants");
  await deriveTemporalForBusiness(bizB.id, AS_OF);
  const seenByB = await tenantTx(bizB.id, (tx) => tx.temporalKnowledge.count({ where: { businessId: bizA.id } }));
  check("tenant B sees none of A's temporal knowledge", seenByB === 0);
  check("with no tenant set, nothing is visible", (await rt.temporalKnowledge.count({})) === 0);
  const bBase = await owner.temporalKnowledge.findFirst({
    where: { businessId: bizB.id, temporalKey: "documents.paperwork_lag", contextKey: "", knowledgeType: "BASELINE", status: "ACTIVE" },
  });
  check("B's baseline is B's own (≈30 days) — no pooling in either direction",
    Number((bBase?.baseline as { median: number } | null)?.median) === 30);
  let cross = "none";
  try {
    await tenantTx(bizB.id, (tx) => tx.temporalKnowledge.create({ data: {
      businessId: bizA.id, temporalKey: "x", domain: "x", rulePolicyVersionId: rowsA[0].rulePolicyVersionId,
      knowledgeType: "BASELINE", status: "ACTIVE", valueKind: "duration", unit: "days", asOf: AS_OF,
      historyStart: AS_OF, historyEnd: AS_OF, historyCount: 0, recentCount: 0, evidenceRefs: [],
      evidenceFingerprint: "x", semanticHash: "x",
    } }));
    cross = "WROTE";
  } catch { cross = "refused"; }
  check("a write into A from B's context is refused by the policy", cross === "refused", cross);

  /* ══════════════════ T2 — new business ══════════════════ */
  section("T2 — a new business is told it has no history, and gets nothing invented");
  await deriveTemporalForBusiness(bizNew.id, AS_OF);
  const newRows = await owner.temporalKnowledge.findMany({ where: { businessId: bizNew.id } });
  check("no ACTIVE temporal knowledge at all for a business with no evidence",
    newRows.every((r) => r.status !== "ACTIVE"));
  const nb = newRows.find((r) => r.temporalKey === "documents.paperwork_lag" && r.knowledgeType === "BASELINE");
  check("…and its baseline says INSUFFICIENT_HISTORY with have=0 and the need",
    nb?.status === "INSUFFICIENT_HISTORY" && (nb.reason as { have: number; need: number })?.have === 0 &&
      (nb.reason as { need: number }).need === 12);

  /* ══════════════════ T4 / T5 — idempotency and as-of ══════════════════ */
  section("T4/T5 — the same derivation is the same knowledge");
  const before = await owner.temporalKnowledge.findMany({ where: { businessId: bizA.id }, orderBy: { id: "asc" } });
  const again = await deriveTemporalForBusiness(bizA.id, AS_OF);
  const after = await owner.temporalKnowledge.findMany({ where: { businessId: bizA.id }, orderBy: { id: "asc" } });
  check("re-running at the same asOf writes NOTHING new — it confirms",
    after.length === before.length && again.rules.every((r) => r.written === 0 && r.superseded === 0),
    `rows ${before.length}→${after.length}`);
  check("…and every fingerprint and conclusion is byte-identical",
    after.every((r, i) => r.evidenceFingerprint === before[i].evidenceFingerprint && r.semanticHash === before[i].semanticHash));

  /* ══════════════════ T6 — reversal ══════════════════ */
  section("T6 — reversed evidence stops counting; the old conclusion is superseded, not erased");
  const payee = await owner.payee.create({ data: { businessId: bizA.id, displayName: "lab", kind: "SUPPLIER" } as never });
  const cm = await owner.commitment.create({ data: { businessId: bizA.id, title: "lab", payeeId: payee.id, payeeNameSnapshot: "lab",
    scheduleKind: "RECURRING", recurrence: "MONTHLY" } as never });
  const allocIds: number[] = [];
  for (let i = 0; i < 14; i++) {
    const paidAgo = 100 + i * 22;
    const inst = await owner.installment.create({ data: { businessId: bizA.id, commitmentId: cm.id, sequence: i + 1,
      scheduledAmount: 100, dueAt: ago(paidAgo + (i % 2)) } as never });
    const pay = await owner.payment.create({ data: { businessId: bizA.id, payeeId: payee.id, payeeNameSnapshot: "lab",
      amount: 100, paidAt: ago(paidAgo), method: "BANK_TRANSFER" } as never });
    const al = await owner.paymentAllocation.create({ data: { businessId: bizA.id, paymentId: pay.id, installmentId: inst.id, allocatedAmount: 100 } as never });
    allocIds.push(al.id);
  }
  await deriveTemporalForBusiness(bizA.id, AS_OF);
  const apBefore = await owner.temporalKnowledge.findFirst({ where: { businessId: bizA.id, temporalKey: "payables.payment_timing",
    knowledgeType: "BASELINE", status: { in: ["ACTIVE", "INSUFFICIENT_HISTORY"] } } });
  check("payment timing has an ACTIVE baseline from 14 settlements", apBefore?.status === "ACTIVE" && apBefore.historyCount === 14);
  await owner.paymentAllocation.update({ where: { id: allocIds[3] }, data: { reversedAt: ago(1), reversedByUserId: 1, reversalReason: "lab" } as never });
  await deriveTemporalForBusiness(bizA.id, AS_OF);
  const apAfter = await owner.temporalKnowledge.findFirst({ where: { businessId: bizA.id, temporalKey: "payables.payment_timing",
    knowledgeType: "BASELINE", status: { in: ["ACTIVE", "INSUFFICIENT_HISTORY"] } } });
  check("the reversed allocation is no longer evidence (13 observations, new fingerprint)",
    apAfter?.historyCount === 13 && apAfter.evidenceFingerprint !== apBefore?.evidenceFingerprint);
  const oldRow = await owner.temporalKnowledge.findUnique({ where: { id: apBefore!.id } });
  check("…and the previous baseline is SUPERSEDED and still there to audit", oldRow?.status === "SUPERSEDED" && oldRow.supersededAt != null);

  /* ══════════════════ T7 — versioning ══════════════════ */
  section("T7 — a new rule version supersedes the old version's rows");
  const pol = await owner.derivationPolicy.findUnique({ where: { key: "temporal-documents-paperwork-lag" } });
  const v2 = await owner.derivationPolicyVersion.create({ data: { policyId: pol!.id, version: "v2" } });
  const liveV1 = await owner.temporalKnowledge.count({ where: { businessId: bizA.id, temporalKey: "documents.paperwork_lag", status: { in: ["ACTIVE", "INSUFFICIENT_HISTORY"] } } });
  const w = await writeTemporalKnowledge({ businessId: bizA.id, temporalKey: "documents.paperwork_lag", domain: "documents",
    rulePolicyVersionId: v2.id, valueKind: "duration", unit: "days", asOf: AS_OF, artifacts: [] });
  check("every live v1 row became SUPERSEDED under v2", w.superseded === liveV1 && liveV1 > 0, `${w.superseded}/${liveV1}`);
  await owner.derivationPolicyVersion.delete({ where: { id: v2.id } }).catch(() => undefined);

  /* ══════════════════ T8 — staleness ══════════════════ */
  section("T8 — much later, a quiet subject's knowledge ages instead of pretending to be current");
  const later = new Date(AS_OF.getTime() + 300 * DAY);
  await deriveTemporalForBusiness(bizB.id, later);
  const bLive = await owner.temporalKnowledge.findMany({ where: { businessId: bizB.id, temporalKey: "documents.paperwork_lag", contextKey: "" },
    orderBy: { id: "desc" } });
  check("B filed nothing for 300 days: its baseline is now INSUFFICIENT or STALE, never still ACTIVE",
    bLive.filter((r) => r.knowledgeType === "BASELINE" && r.status === "ACTIVE").length === 0);

  /* ══════════════════ T9 — identity ══════════════════ */
  section("T9 — two spellings of a vendor are two subjects until someone with authority says otherwise");
  // Two learned vendor rows whose names normalize alike — exactly the resemblance that must stay a
  // question. Without a confirmed link or a valid tax id, identity keeps them apart.
  for (const vendorName of ["NORTH SUPPLIES LTD", "North Supplies Ltd."]) {
    await owner.vendorLearning.create({ data: { businessId: bizA.id, vendorName, category: "supplies" } as never });
  }
  for (let i = 0; i < 3; i++) { await doc(bizA.id, 30 + i * 30, 2, "NORTH SUPPLIES LTD", 500); await doc(bizA.id, 35 + i * 30, 2, "North Supplies Ltd.", 500); }
  await resolveIdentitiesForBusiness(bizA.id);
  await deriveTemporalForBusiness(bizA.id, AS_OF);
  const parties = await owner.temporalKnowledge.findMany({ where: { businessId: bizA.id, temporalKey: "documents.vendor_amount", entityType: "party" },
    select: { entityId: true }, distinct: ["entityId"] });
  check("each spelling has its OWN vendor-amount history (no weak-name merge)", parties.length >= 2, `parties=${parties.length}`);

  /* ══════════════════ T10 — append-only ══════════════════ */
  section("T10 — temporal history cannot be deleted by the application");
  const priv = await rt.$queryRawUnsafe<{ ins: boolean; upd: boolean; del: boolean }[]>(
    `SELECT has_table_privilege(current_user,'"TemporalKnowledge"','INSERT') AS ins,
            has_table_privilege(current_user,'"TemporalKnowledge"','UPDATE') AS upd,
            has_table_privilege(current_user,'"TemporalKnowledge"','DELETE') AS del`);
  check("the runtime may append and supersede", priv[0]?.ins === true && priv[0]?.upd === true);
  check("the runtime may NOT delete", priv[0]?.del === false);

  /* ══════════════════ T11 — privacy ══════════════════ */
  section("T11 — the derivation report is operational only");
  const report = JSON.stringify(await deriveTemporalForBusiness(bizA.id, AS_OF));
  check("no baseline, median, value, entity id or evidence ref in the report",
    !/"median"|"baseline"|"evidenceRefs"|"entityId"|"value"/.test(report));

  /* ══════════════════ Cleanup ══════════════════ */
  section("Cleanup");
  await rt.$disconnect();
  for (const b of [bizA.id, bizB.id, bizNew.id]) await owner.business.delete({ where: { id: b } }).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP OWNED BY ${RT_ROLE}`).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => undefined);

  console.log(`\nM6 temporal battery: ${passed} passed, ${failed} failed`);
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
