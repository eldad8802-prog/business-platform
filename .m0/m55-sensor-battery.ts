/**
 * M5.5 · Business Sensor Fabric — the battery.
 *
 * A real PostgreSQL, the shipped tenant policies replayed, and a runtime role that is MEASURED
 * NOSUPERUSER + NOBYPASSRLS before anything is believed. Proves, against the database rather than
 * against a mock:
 *
 *   S1  a sensor lands in the right tenant, with the actor, source, entity, version and time it was given
 *   S2  a tenant cannot read another tenant's sensors, and a sensor cannot be written into another tenant
 *   S3  a retry of the same action is ONE fact — outside a transaction and, critically, inside one
 *       (where a unique violation would otherwise abort the caller's business write)
 *   S4  UNKNOWN stays UNKNOWN; historical NULL actors/sources are not rewritten by anything
 *   S5  a refused payload writes nothing and never reaches a log with its content
 *   S6  decisions keep their history: deciding twice is two facts, and silence writes nothing
 *   S7  CollectionAction stays append-only through the same privilege inheritance Production uses
 *   S8  the two M4 corrections: a CHEQUE is not external backing (AP-06 v2), and an order created and
 *       received by draft approval is not delivery evidence (SUPP-02/03 v2)
 *   D*  one meaningful positive per newly instrumented domain, through the real service
 *
 * Output is labels and PASS/FAIL only. No payload, no value, no name is ever printed.
 *
 * Usage (CI provides the database):
 *   M0_ADMIN_URL=postgresql://... npx tsx .m0/m55-sensor-battery.ts
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
const RT_ROLE = `m55_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
// The group role Production's runtime inherits from. Created if the lab lacks it, so the #515 revoke
// is replayed through the SAME inheritance path it relies on in Production.
const GROUP = "app_runtime";
const DAY = 86_400_000;
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

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
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  // DO $do$ … $do$ blocks contain semicolons; keep them whole.
  const blocks: string[] = [];
  const re = /DO \$do\$[\s\S]*?\$do\$;?|[^;]+;?/g;
  for (const m of sql.matchAll(re)) {
    const s = m[0].trim().replace(/;$/, "").trim();
    if (s && keep.test(s) && !(drop && drop.test(s))) blocks.push(s);
  }
  return blocks;
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
  ];
  let nPolicies = 0;
  for (const f of policyFiles) {
    for (const s of sqlStatements(f, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/, /app_admin/)) {
      await owner.$executeRawUnsafe(s);
      nPolicies++;
    }
  }
  check("the shipped tenant policies were replayed", nPolicies >= 60, `n=${nPolicies}`);

  // Rule lineages (M4/M5) and the three v2 versions (M5.5), out of the migrations that ship them.
  for (const s of sqlStatements("prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql", /^INSERT INTO "DerivationPolicy/)) {
    await owner.$executeRawUnsafe(s);
  }
  const v2 = sqlStatements("prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql", /^INSERT INTO "DerivationPolicyVersion"/);
  check("the M5.5 migration registers the v2 rule versions", v2.length === 1);
  for (const s of v2) await owner.$executeRawUnsafe(s);

  // Grants go to the GROUP role, as in Production, and reach the runtime by inheritance.
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  // …and then the append-only revoke exactly as #515 shipped it.
  for (const s of sqlStatements("prisma/migrations/20260924180000_m5_collection_action_append_only/migration.sql", /REVOKE/)) {
    await owner.$executeRawUnsafe(s);
  }

  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(
    `SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`,
  );
  check("the runtime role is NOSUPERUSER", posture[0]?.s === false);
  check("the runtime role is NOBYPASSRLS — isolation is enforced, not assumed", posture[0]?.b === false);
  const le = await owner.$queryRawUnsafe<{ r: boolean; f: boolean }[]>(
    `SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname='LearningEvent'`,
  );
  check("LearningEvent is ENABLE + FORCE RLS", le[0]?.r === true && le[0]?.f === true);

  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  const who = await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`);
  check("the application code is connected as the restricted role", who[0]?.u === RT_ROLE);

  const { recordSensor } = await import("@/lib/sensors/record-sensor");
  const { logAuditEvent } = await import("@/lib/services/audit.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  const bizA = await owner.business.create({ data: { name: `M55 A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `M55 B ${NONCE}` } });
  const userA = await owner.user.create({
    data: { businessId: bizA.id, email: `m55-${NONCE}@lab.test`, password: "x", name: "lab" } as never,
  }).catch(() => null);
  const uid = userA?.id ?? 4242;

  /* ══════════════════ S1 — the right tenant, actor, source, entity, version, time ══════════════════ */
  section("S1 — a sensor records exactly what it was given, where it was given");
  const occurred = ago(3);
  await recordSensor({
    businessId: bizA.id, sensor: "CUSTOMER_CREATED", entityId: 501,
    actor: { type: "OWNER_USER", userId: uid }, source: "IMPORT",
    payload: { origin: "IMPORT", importRunId: 9, sourceRowNumber: 4 },
    occurredAt: occurred, idempotencyKey: `import:9:4:customer:${NONCE}`,
  });
  const s1 = await owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "CUSTOMER_CREATED" } });
  check("it landed in tenant A", s1?.businessId === bizA.id);
  check("the actor is the person, and the source is the file — two facts, both kept",
    s1?.actorType === "OWNER_USER" && s1?.actorUserId === uid && s1?.source === "IMPORT");
  check("the entity is the one named", s1?.entityType === "CUSTOMER" && s1?.entityId === 501);
  check("the sensor version is recorded", s1?.sensorVersion === 1);
  check("business time is kept apart from recording time",
    s1?.occurredAt?.getTime() === occurred.getTime() && (s1?.createdAt.getTime() ?? 0) > occurred.getTime());

  /* ══════════════════ S2 — isolation ══════════════════ */
  section("S2 — sensors do not cross tenants");
  const seenByB = await tenantTx(bizB.id, (tx) => tx.learningEvent.count({ where: {} }));
  check("tenant B sees none of tenant A's sensors", seenByB === 0, `n=${seenByB}`);
  const bare = await rt.learningEvent.count({});
  check("with no tenant set, nothing is visible at all", bare === 0, `n=${bare}`);
  let crossWrite = "none";
  try {
    await tenantTx(bizB.id, (tx) => tx.learningEvent.create({
      data: { businessId: bizA.id, eventType: "CUSTOMER_CREATED", entityType: "CUSTOMER" },
    }));
    crossWrite = "WROTE";
  } catch { crossWrite = "refused"; }
  check("a write into tenant A from tenant B's context is refused by the policy", crossWrite === "refused", crossWrite);
  const viaWriter = await recordSensor({
    businessId: bizB.id, sensor: "CUSTOMER_ARCHIVED", entityId: 1,
    actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI",
  });
  const inA = await owner.learningEvent.count({ where: { businessId: bizA.id, eventType: "CUSTOMER_ARCHIVED" } });
  check("the writer puts B's sensor in B and nowhere else", viaWriter.ok && inA === 0);

  /* ══════════════════ S3 — idempotency ══════════════════ */
  section("S3 — a retry is not a second business action");
  const key = `pos-sale:EXT-${NONCE}`;
  const once = { businessId: bizA.id, sensor: "POS_SALE_INGESTED" as const, actor: { type: "INTEGRATION" as const },
    source: "INTEGRATION" as const, payload: { externalSaleId: `EXT-${NONCE}`, outcome: "APPLIED" }, idempotencyKey: key };
  const r1 = await recordSensor(once);
  const r2 = await recordSensor(once);
  const nPos = await owner.learningEvent.count({ where: { businessId: bizA.id, idempotencyKey: key } });
  check("the webhook retry wrote nothing new", r1.ok && r2.ok && nPos === 1, `n=${nPos}`);

  // Inside a caller's transaction: the retry must NOT raise, or it would abort the business write.
  let txSurvived = false;
  await tenantTx(bizA.id, async (tx) => {
    await recordSensor(once, { tx });
    await tx.learningEvent.create({ data: { businessId: bizA.id, eventType: "LAB_PROBE", entityType: "LAB" } });
    txSurvived = true;
  });
  const probe = await owner.learningEvent.count({ where: { businessId: bizA.id, eventType: "LAB_PROBE" } });
  check("inside a transaction, a retried sensor is a no-op and the business write still commits",
    txSurvived && probe === 1 && (await owner.learningEvent.count({ where: { businessId: bizA.id, idempotencyKey: key } })) === 1);
  // A sensor that FAILS inside the caller's transaction (here: an entity id no INTEGER column can
  // hold) must roll back to its savepoint and leave the business write alive.
  let bizWriteSurvived = false;
  await tenantTx(bizA.id, async (tx) => {
    const r = await recordSensor({ businessId: bizA.id, sensor: "CUSTOMER_ARCHIVED", entityId: 3_000_000_000,
      actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI" }, { tx });
    await tx.learningEvent.create({ data: { businessId: bizA.id, eventType: "LAB_PROBE_2", entityType: "LAB" } });
    bizWriteSurvived = r.ok && r.written === false;
  });
  check("a sensor that fails inside a business transaction costs the business nothing (savepoint)",
    bizWriteSurvived && (await owner.learningEvent.count({ where: { businessId: bizA.id, eventType: "LAB_PROBE_2" } })) === 1);

  const sameKeyOtherTenant = await recordSensor({ ...once, businessId: bizB.id });
  check("the same key in another tenant is another tenant's fact, not a collision",
    sameKeyOtherTenant.ok && (await owner.learningEvent.count({ where: { idempotencyKey: key } })) === 2);

  /* ══════════════════ S4 — UNKNOWN stays UNKNOWN ══════════════════ */
  section("S4 — nothing invents an actor");
  const legacy = await owner.learningEvent.create({
    data: { businessId: bizA.id, eventType: "LEAD_CREATED", entityType: "LEAD", entityId: 1 },
  });
  await logAuditEvent({ businessId: bizA.id, eventType: "LEAD_CREATED", entityType: "LEAD", entityId: 2 });
  const legacyAfter = await owner.learningEvent.findUnique({ where: { id: legacy.id } });
  check("a historical row with no actor keeps NULL actor and NULL source",
    legacyAfter?.actorType === null && legacyAfter?.source === null && legacyAfter?.actorUserId === null);
  const unstated = await owner.learningEvent.findFirst({
    where: { businessId: bizA.id, eventType: "LEAD_CREATED", entityId: 2 },
  });
  check("a legacy caller that states nothing is recorded as NOT KNOWN, not guessed",
    unstated?.actorType === null && unstated?.source === null);
  await recordSensor({ businessId: bizA.id, sensor: "DATA_EXPORTED", actor: { type: "UNKNOWN" }, source: "UNKNOWN",
    payload: { kind: "lab" } });
  const unk = await owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "DATA_EXPORTED" } });
  check("an explicit UNKNOWN is stored as UNKNOWN, with no user attached",
    unk?.actorType === "UNKNOWN" && unk?.actorUserId === null);
  await recordSensor({ businessId: bizA.id, sensor: "PURCHASE_ORDER_STATUS_SETTLED", entityId: 3,
    actor: { type: "SYSTEM" }, source: "SYSTEM", payload: { from: "AWAITING_DELIVERY", to: "CLOSED" } });
  const sys = await owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "PURCHASE_ORDER_STATUS_SETTLED" } });
  check("a SYSTEM event never carries a person's id", sys?.actorType === "SYSTEM" && sys?.actorUserId === null);

  /* ══════════════════ S5 — refusal writes nothing ══════════════════ */
  section("S5 — a payload that could carry personal data is refused, and nothing is written");
  const before = await owner.learningEvent.count({ where: { businessId: bizA.id } });
  const refusedName = await recordSensor({ businessId: bizA.id, sensor: "CUSTOMER_UPDATED", entityId: 1,
    actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI", payload: { customerName: "lab-secret" } as never });
  const refusedLie = await recordSensor({ businessId: bizA.id, sensor: "CUSTOMER_UPDATED", entityId: 1,
    actor: { type: "SYSTEM" }, source: "OWNER_UI", payload: { fields: ["name"] } });
  const after = await owner.learningEvent.count({ where: { businessId: bizA.id } });
  check("a forbidden key is refused", !refusedName.ok);
  check("a system job claiming the owner's UI is refused", !refusedLie.ok);
  check("…and neither wrote a row", after === before, `before=${before} after=${after}`);

  /* ══════════════════ S6 — decisions keep history; silence is not rejection ══════════════════ */
  section("S6 — deciding twice is two facts; not deciding is none");
  await recordSensor({ businessId: bizA.id, sensor: "INSIGHT_DECIDED", entityId: 77,
    actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI", payload: { from: "OPEN", to: "DISMISSED", noteGiven: false } });
  await recordSensor({ businessId: bizA.id, sensor: "INSIGHT_DECIDED", entityId: 77,
    actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI", payload: { from: "DISMISSED", to: "ADOPTED", noteGiven: true } });
  const decisions = await owner.learningEvent.findMany({
    where: { businessId: bizA.id, eventType: "INSIGHT_DECIDED", entityId: 77 }, orderBy: { id: "asc" },
  });
  check("the owner's change of mind is preserved, in order, rather than overwritten",
    decisions.length === 2 &&
      (decisions[0].payload as Record<string, unknown>)?.to === "DISMISSED" &&
      (decisions[1].payload as Record<string, unknown>)?.from === "DISMISSED");
  check("an insight nobody decided on has no decision event — silence is not rejection",
    (await owner.learningEvent.count({ where: { businessId: bizA.id, eventType: "INSIGHT_DECIDED", entityId: 78 } })) === 0);

  /* ══════════════════ S7 — CollectionAction append-only ══════════════════ */
  section("S7 — CollectionAction is append-only through inheritance, exactly as in Production");
  const priv = await rt.$queryRawUnsafe<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>(
    `SELECT has_table_privilege(current_user,'"CollectionAction"','SELECT') AS sel,
            has_table_privilege(current_user,'"CollectionAction"','INSERT') AS ins,
            has_table_privilege(current_user,'"CollectionAction"','UPDATE') AS upd,
            has_table_privilege(current_user,'"CollectionAction"','DELETE') AS del`,
  );
  check("the runtime may record and read reminders", priv[0]?.sel === true && priv[0]?.ins === true);
  check("the runtime may NOT revise or remove one", priv[0]?.upd === false && priv[0]?.del === false,
    `upd=${priv[0]?.upd} del=${priv[0]?.del}`);

  // Domain positives (D*) and the M4 corrections (S8) are appended below.
  await domainChecks({ owner, rt, bizA, bizB, uid, tenantTx });

  /* ══════════════════ Cleanup ══════════════════ */
  section("Cleanup");
  await rt.$disconnect();
  for (const b of [bizA.id, bizB.id]) {
    await owner.business.delete({ where: { id: b } }).catch(() => undefined);
  }
  await owner.$executeRawUnsafe(`DROP OWNED BY ${RT_ROLE}`).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => undefined);

  console.log(`\nM5.5 sensor battery: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
}

type Ctx = {
  owner: PrismaClient;
  rt: PrismaClient;
  bizA: { id: number };
  bizB: { id: number };
  uid: number;
  tenantTx: typeof import("@/lib/tenant/tenant-tx").tenantTx;
};

async function domainChecks(ctx: Ctx): Promise<void> {
  const { owner, bizA, uid, tenantTx } = ctx;
  const ev = (eventType: string, entityId?: number) =>
    owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType, ...(entityId != null ? { entityId } : {}) }, orderBy: { id: "desc" } });

  /* ══════════════════ D-customers — through the real service ══════════════════ */
  section("D-customers — a customer created in the UI says so, and says who");
  const { customerService } = await import("@/lib/services/crm/customer.service");
  const c = await tenantTx(bizA.id, (tx) =>
    customerService.createCustomer(
      { businessId: bizA.id, name: "lab customer", phone: null } as never,
      { tx, sensor: { actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI", origin: "UI" } },
    ),
  ) as { id: number };
  const cc = await ev("CUSTOMER_CREATED", c.id);
  check("CUSTOMER_CREATED, by the person, through the UI, about this customer",
    cc?.actorType === "OWNER_USER" && cc?.actorUserId === uid && cc?.source === "OWNER_UI" && cc?.entityType === "CUSTOMER");
  check("…and its payload carries the path, never the customer's name",
    (cc?.payload as Record<string, unknown>)?.origin === "UI" && !JSON.stringify(cc?.payload ?? {}).includes("lab customer"));
  await tenantTx(bizA.id, (tx) =>
    customerService.createCustomer(
      { businessId: bizA.id, name: "lab customer 2", phone: null } as never,
      { tx },
    ),
  );
  check("a caller that states no actor writes NO customer sensor rather than a guessed one",
    (await owner.learningEvent.count({ where: { businessId: bizA.id, eventType: "CUSTOMER_CREATED" } })) === 2,
    "expected only the import probe from S1 and the stated one above");

  /* ══════════════════ D-leads — owner vs auto-capture are two different facts ══════════════════ */
  section("D-leads — an owner's lead and an auto-captured lead no longer look the same");
  const { leadService } = await import("@/lib/services/crm/lead.service");
  const byOwner = await tenantTx(bizA.id, (tx) => leadService.createLead(
    { businessId: bizA.id, name: "lab lead one", phone: "0501111111", sourceChannel: "PHONE",
      actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI" },
    { tx },
  )) as { id: number };
  const byJob = await tenantTx(bizA.id, (tx) => leadService.createLead(
    { businessId: bizA.id, name: "lab lead two", phone: "0502222222", sourceChannel: "WHATSAPP",
      actor: { type: "SYSTEM" }, source: "SYSTEM" },
    { tx },
  )) as { id: number };
  const e1 = await ev("LEAD_CREATED", byOwner.id);
  const e2 = await ev("LEAD_CREATED", byJob.id);
  check("the owner's lead is OWNER_USER / OWNER_UI", e1?.actorType === "OWNER_USER" && e1?.source === "OWNER_UI");
  check("the system's lead is SYSTEM / SYSTEM with no person attached",
    e2?.actorType === "SYSTEM" && e2?.source === "SYSTEM" && e2?.actorUserId === null);
  await tenantTx(bizA.id, (tx) => leadService.updateLeadStatus(
    { businessId: bizA.id, leadId: byOwner.id, status: "LOST", lostReason: "lab private reason",
      actor: { type: "OWNER_USER", userId: uid }, source: "OWNER_UI" } as never,
    { tx },
  ));
  const lost = await ev("LEAD_LOST", byOwner.id);
  check("LEAD_LOST records THAT a reason was given, not the owner's words",
    (lost?.payload as Record<string, unknown>)?.reasonGiven === true &&
      !JSON.stringify(lost?.payload ?? {}).includes("lab private reason"));

  /* ══════════════════ D-insights — the real decision path ══════════════════ */
  section("D-insights — an explicit decision is a fact with a before and an after");
  const { recordOwnerDecision } = await import("@/lib/knowledge/insight.service");
  const ins = await owner.businessInsight.create({
    data: {
      businessId: bizA.id, insightKey: "lab.insight", dedupeKey: `lab-${NONCE}`, severity: "LOW",
      title: "lab", factLines: [], contributingRules: [], composerVersion: "lab",
    } as never,
  });
  await recordOwnerDecision(bizA.id, ins.id, "DISMISSED", uid);
  await recordOwnerDecision(bizA.id, ins.id, "ADOPTED", uid, "changed my mind");
  const hist = await owner.learningEvent.findMany({
    where: { businessId: bizA.id, eventType: "INSIGHT_DECIDED", entityId: ins.id }, orderBy: { id: "asc" },
  });
  check("both decisions exist, in order, even though the row itself now shows only the last",
    hist.length === 2 && (hist[0].payload as Record<string, unknown>)?.to === "DISMISSED" &&
      (hist[1].payload as Record<string, unknown>)?.from === "DISMISSED" &&
      (hist[1].payload as Record<string, unknown>)?.noteGiven === true);
  check("the note itself is not copied into the event",
    !JSON.stringify(hist.map((h) => h.payload)).includes("changed my mind"));

  /* ══════════════════ S8 — the two M4 corrections, derived for real ══════════════════ */
  section("S8 — AP-06 v2: a cheque is the owner's word; SUPP-02/03 v2: a one-click order is not a delivery");
  const bizC = await owner.business.create({ data: { name: `M55 C ${NONCE}` } });
  const payee = await owner.payee.create({ data: { businessId: bizC.id, displayName: "lab payee", kind: "SUPPLIER" } as never });
  const commitment = await owner.commitment.create({
    data: { businessId: bizC.id, title: "lab", payeeId: payee.id, payeeNameSnapshot: "lab",
      scheduleKind: "RECURRING", recurrence: "MONTHLY" } as never,
  });
  const kinds = ["DOCUMENT", "DOCUMENT", "CHEQUE", "CHEQUE", "CHEQUE"] as const;
  for (let i = 0; i < kinds.length; i++) {
    const inst = await owner.installment.create({
      data: { businessId: bizC.id, commitmentId: commitment.id, sequence: i + 1, scheduledAmount: 100, dueAt: ago(100 - i * 10) } as never,
    });
    const pay = await owner.payment.create({
      data: { businessId: bizC.id, payeeId: payee.id, payeeNameSnapshot: "lab", amount: 100, paidAt: ago(100 - i * 10), method: "BANK_TRANSFER" } as never,
    });
    await owner.paymentAllocation.create({ data: { businessId: bizC.id, paymentId: pay.id, installmentId: inst.id, allocatedAmount: 100 } as never });
    await owner.paymentEvidence.create({ data: { businessId: bizC.id, paymentId: pay.id, kind: kinds[i] } as never });
  }
  const supplier = await owner.supplier.create({ data: { businessId: bizC.id, name: "lab supplier" } as never });
  const item = await owner.inventoryItem.create({ data: { businessId: bizC.id, name: "lab item", unitType: "UNIT", currentQuantity: 0 } as never });
  // Three orders by draft approval: created and received in the same instant, all complete.
  const draft = await owner.supplierPurchaseDraft.create({ data: { businessId: bizC.id, supplierId: supplier.id, supplierName: "lab" } as never });
  for (let i = 0; i < 3; i++) {
    const po = await owner.purchaseOrder.create({
      data: { businessId: bizC.id, supplierId: supplier.id, supplierName: "lab", orderDate: ago(90 - i * 20),
        status: "CLOSED", sourceSupplierPurchaseDraftId: draft.id } as never,
    });
    const line = await owner.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, itemId: item.id, orderedQty: 5, rawName: "x" } as never });
    const rs = await owner.receivingSession.create({
      data: { businessId: bizC.id, purchaseOrderId: po.id, status: "POSTED", receivedAt: ago(90 - i * 20), postedAt: ago(90 - i * 20) } as never,
    });
    await owner.receivingLine.create({ data: { receivingSessionId: rs.id, purchaseOrderLineId: line.id, itemId: item.id, receivedQty: 5 } as never });
  }
  const { deriveKnowledgeForBusiness } = await import("@/lib/knowledge/derive.service");
  const rep = await deriveKnowledgeForBusiness(bizC.id, NOW);
  const rule = (id: string) => rep.rules.find((r) => r.ruleId === id);
  check("every rule ran", rep.rulesFailed === 0, `failed=${rep.rulesFailed}`);
  check("AP-06 runs as v2", rule("AP-06")?.ruleVersion === "v2");
  check("AP-06 v2: two documents of five are backed; the three cheques are the owner's word (0.4, not 1.0)",
    rule("AP-06")?.measures[0]?.valueNumeric === 0.4, `value=${rule("AP-06")?.measures[0]?.valueNumeric}`);
  check("SUPP-02 and SUPP-03 run as v2", rule("SUPP-02")?.ruleVersion === "v2" && rule("SUPP-03")?.ruleVersion === "v2");
  check("SUPP-02 v2: orders created-and-received by one click are not delivery evidence — no measure at all",
    (rule("SUPP-02")?.measures.length ?? -1) === 0 && (rule("SUPP-03")?.measures.length ?? -1) === 0,
    `supp02=${rule("SUPP-02")?.measures.length} supp03=${rule("SUPP-03")?.measures.length}`);
  check("SUPP-01 still counts them: the business DID buy three times",
    (rule("SUPP-01")?.measures[0]?.observationCount ?? 0) === 3, `n=${rule("SUPP-01")?.measures[0]?.observationCount}`);
  await owner.business.delete({ where: { id: bizC.id } }).catch(() => undefined);
}

main()
  .catch((e) => {
    // Name only: a Prisma error can quote the values it failed on.
    console.error("battery crashed:", e instanceof Error ? `${e.name}: ${e.message.split("\n")[0].slice(0, 160)}` : "unknown");
    process.exit(1);
  })
  .finally(async () => { await owner.$disconnect(); });
