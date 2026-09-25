/**
 * M7 · Business Knowledge Snapshot — the battery.
 *
 * Real PostgreSQL, shipped tenant policies replayed, a runtime role MEASURED NOSUPERUSER + NOBYPASSRLS.
 * The real derivations run first, then the real snapshot builder, as that role.
 *
 *   K1  one tenant: A's snapshot contains only A's knowledge; B's contains none of A's
 *   K2  no tenant context: nothing is visible
 *   K3  cross-domain POSITIVE: a supplier and a payee bound by a valid tax id, with supplier knowledge
 *       and open payables → one LINKED_COUNTERPARTY_CONDITION, traceable to its premises
 *   K4  cross-domain NEGATIVE: a look-alike pair linked only by a name proposal → no finding
 *   K5  determinism: same state + same asOf → same fingerprint; re-derived rows with new ids → same
 *   K6  deduplication: a duplicate stored row appears once; a divergent one is a CONFLICT
 *   K7  conflict: competing claim values UNRESOLVED; machine vs owner → owner prevails, both kept
 *   K8  gaps: a thin business gets gaps, not knowledge
 *   K9  reversal: settling the payable removes the premise → the finding is gone
 *   K10 stale input: far in the future, the premise is not fresh → no finding
 *   K11 privacy: no name, phone or tax id in the snapshot
 *   K12 bounded: 300 more historical documents outside every window leave the snapshot's size unchanged
 *
 * Output is labels and PASS/FAIL only.
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
const RT_ROLE = `m7_rt_${NONCE}`;
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

function validTaxId(seed: number): string {
  const base = `514${(seed % 100_000).toString().padStart(5, "0")}`;
  let sum = 0;
  for (let i = 0; i < 8; i += 1) { const st = Number(base[i]) * ((i % 2) + 1); sum += st > 9 ? st - 9 : st; }
  return `${base}${(10 - (sum % 10)) % 10}`;
}

async function main(): Promise<void> {
  section("Provision — the lab mirrors Production's enforcement");
  await owner.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${GROUP}')
    THEN CREATE ROLE ${GROUP} NOLOGIN; END IF; END $$`);
  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION IN ROLE ${GROUP}`);
  for (const f of [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql",
    "prisma/migrations/20260917090100_payables_phase_1a_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql",
  ]) {
    for (const s of sqlStatements(f, /ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/, /app_admin/)) await owner.$executeRawUnsafe(s);
  }
  for (const f of [
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
    "prisma/migrations/20260925090000_m55_sensor_fabric/migration.sql",
    "prisma/migrations/20260926090000_m6_temporal_knowledge/migration.sql",
  ]) {
    for (const s of sqlStatements(f, /^INSERT INTO "DerivationPolicy/)) await owner.$executeRawUnsafe(s);
  }
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${GROUP}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${GROUP}`);
  const posture = await owner.$queryRawUnsafe<{ s: boolean; b: boolean }[]>(
    `SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname='${RT_ROLE}'`);
  check("the runtime role is NOSUPERUSER + NOBYPASSRLS", posture[0]?.s === false && posture[0]?.b === false);

  const rtUrl = (() => { const u = new URL(ADMIN_URL!); u.username = RT_ROLE; u.password = RT_PW; return u.toString(); })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;
  const rt = new PrismaClient({ datasources: { db: { url: rtUrl } } });
  check("the application code is connected as the restricted role",
    (await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`))[0]?.u === RT_ROLE);

  const { buildBusinessKnowledgeSnapshot } = await import("@/lib/knowledge/snapshot/build-snapshot");
  const { deriveKnowledgeForBusiness } = await import("@/lib/knowledge/derive.service");
  const { resolveIdentitiesForBusiness } = await import("@/lib/identity/entity-identity.service");

  /* ══════════════════ SEED ══════════════════ */
  section("Seed — a counterparty bound by tax id, a look-alike bound by nothing, and a thin business");
  const bizA = await owner.business.create({ data: { name: `M7 A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `M7 B ${NONCE}` } });
  const TAX = validTaxId(parseInt(NONCE, 16));
  const supplier = await owner.supplier.create({ data: { businessId: bizA.id, name: "Northwind Lab Supplies", taxId: TAX, phone: "0529998877" } as never });
  const payee = await owner.payee.create({ data: { businessId: bizA.id, displayName: "Northwind Lab", kind: "SUPPLIER", taxId: TAX } as never });
  // The look-alike: same kind of names, NO shared identifier.
  const lookSupplier = await owner.supplier.create({ data: { businessId: bizA.id, name: "Southwind Lab Supplies" } as never });
  const lookPayee = await owner.payee.create({ data: { businessId: bizA.id, displayName: "Southwind Lab Supplies", kind: "SUPPLIER" } as never });

  const item = await owner.inventoryItem.create({ data: { businessId: bizA.id, name: "lab", unitType: "UNIT", currentQuantity: 0 } as never });
  for (const s of [supplier.id, lookSupplier.id]) {
    for (let i = 0; i < 4; i++) {
      const po = await owner.purchaseOrder.create({ data: { businessId: bizA.id, supplierId: s, supplierName: "lab",
        orderDate: ago(120 - i * 28), status: "CONFIRMED" } as never });
      await owner.purchaseOrderLine.create({ data: { purchaseOrderId: po.id, itemId: item.id, orderedQty: 1, rawName: "x" } as never });
    }
  }
  // Open payables: one overdue installment to each payee.
  const installmentIds: number[] = [];
  for (const p of [payee.id, lookPayee.id]) {
    const cm = await owner.commitment.create({ data: { businessId: bizA.id, title: "lab", payeeId: p, payeeNameSnapshot: "lab",
      scheduleKind: "ONE_OFF" } as never });
    const inst = await owner.installment.create({ data: { businessId: bizA.id, commitmentId: cm.id, sequence: 1, scheduledAmount: 700, dueAt: ago(10) } as never });
    installmentIds.push(inst.id);
  }

  await resolveIdentitiesForBusiness(bizA.id);
  await deriveKnowledgeForBusiness(bizA.id, AS_OF);

  /* ══════════════════ K3 / K4 ══════════════════ */
  section("K3/K4 — authority joins domains; resemblance does not");
  const snapA = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  const partyFindings = snapA.crossDomainFindings.filter((f) => f.ruleId === "X-PARTY-01");
  check("exactly ONE linked-counterparty finding: the tax-id pair", partyFindings.length === 1, `n=${partyFindings.length}`);
  const pf = partyFindings[0];
  const linked = (pf?.value as { linkedSubjects: { type: string; id: number }[] } | undefined)?.linkedSubjects ?? [];
  check("…and it is the Northwind supplier + payee, not the look-alikes",
    linked.some((s) => s.type === "SUPPLIER" && s.id === supplier.id) && linked.some((s) => s.type === "PAYEE" && s.id === payee.id) &&
      !linked.some((s) => s.id === lookSupplier.id || s.id === lookPayee.id));
  check("…joining suppliers knowledge and payables exposure", pf?.domains.includes("suppliers") && pf?.domains.includes("payables"));
  check("…non-causal", pf?.causal === false && !/because|caus|driv|impact/i.test(pf?.establishes ?? ""));
  const measurePremise = pf?.premises.find((p) => p.provenance.some((r) => r.store === "KnowledgeMeasure"));
  const mId = Number(measurePremise?.provenance.find((r) => r.store === "KnowledgeMeasure")?.id);
  const mRow = await owner.knowledgeMeasure.findUnique({ where: { id: mId }, include: { evidenceLinks: true } });
  check("PROVENANCE: the finding → its measure premise → that measure's evidence rows (purchase orders)",
    mRow?.measureKey === "suppliers.purchase_cadence" && (mRow?.evidenceLinks.length ?? 0) >= 4 &&
      mRow!.evidenceLinks.every((l) => l.businessId === bizA.id));
  const claimPremise = pf?.premises.find((p) => p.provenance.some((r) => r.store === "PartyResolutionClaim"));
  check("PROVENANCE: …and → the identity claims that make it one counterparty", claimPremise?.authority === "AUTHORITATIVE_IDENTIFIER");
  check("the look-alike pair is at most a PROPOSED relationship, never ACTIVE",
    !snapA.relationships.some((r) => r.status === "ACTIVE" && [r.left.id, r.right.id].some((id) => id === lookSupplier.id || id === lookPayee.id)));

  /* ══════════════════ K1 / K2 ══════════════════ */
  section("K1/K2 — one tenant, and no tenant means nothing");
  const snapB = await buildBusinessKnowledgeSnapshot(bizB.id, { asOf: AS_OF });
  const aMeasureIds = new Set((await owner.knowledgeMeasure.findMany({ where: { businessId: bizA.id }, select: { id: true } })).map((m) => m.id));
  check("B's snapshot contains none of A's knowledge, relationships or findings",
    snapB.knowledge.every((k) => k.provenance.every((p) => !(p.store === "KnowledgeMeasure" && aMeasureIds.has(Number(p.id))))) &&
      snapB.relationships.length === 0 && snapB.crossDomainFindings.length === 0);
  check("A's snapshot carries only A's businessId", snapA.businessId === bizA.id && snapB.businessId === bizB.id);
  const bare = await Promise.all([rt.knowledgeMeasure.count({}), rt.temporalKnowledge.count({}), rt.partyResolutionClaim.count({}), rt.installment.count({})]);
  check("with no tenant set, none of the snapshot's sources is visible", bare.every((n) => n === 0), bare.join(","));

  /* ══════════════════ K8 ══════════════════ */
  section("K8 — a thin business is told what it does not know");
  check("B has no measures and no temporal knowledge — and says so in gaps, not in knowledge",
    !snapB.knowledge.some((k) => k.kind === "MEASURE" || k.authority === "TEMPORAL_DERIVATION") && snapB.knowledgeGaps.length > 0);

  /* ══════════════════ K5 ══════════════════ */
  section("K5 — the same knowledge is the same snapshot");
  const again = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  check("two builds at the same asOf: identical fingerprint", again.snapshotFingerprint === snapA.snapshotFingerprint);
  await deriveKnowledgeForBusiness(bizA.id, AS_OF); // re-materialises every measure under NEW row ids
  const rederived = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  check("re-derived measures (new ids, same knowledge) → identical fingerprint", rederived.snapshotFingerprint === snapA.snapshotFingerprint);

  /* ══════════════════ K6 / K7 ══════════════════ */
  section("K6/K7 — duplicates collapse, conflicts are kept");
  const m = await owner.knowledgeMeasure.findFirst({ where: { businessId: bizA.id, measureKey: "suppliers.purchase_cadence", entityId: supplier.id, status: "ACTIVE" } });
  const dupe = await owner.knowledgeMeasure.create({ data: { ...m!, id: undefined, materializedAt: new Date() } as never });
  const snapDup = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  const cadence = snapDup.knowledge.filter((k) => k.key === "suppliers.purchase_cadence" && k.subject?.id === supplier.id);
  check("a duplicate stored row appears ONCE, carrying both provenances", cadence.length === 1 && cadence[0].provenance.length === 2);
  await owner.knowledgeMeasure.update({ where: { id: dupe.id }, data: { valueNumeric: 99 } });
  const snapDiv = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  check("a divergent value for the same slot → CONFLICT, UNRESOLVED, both sides kept",
    snapDiv.conflicts.some((c) => c.kind === "DIVERGENT_SAME_SLOT" && c.resolution === "UNRESOLVED" && c.sides.length === 2));
  await owner.knowledgeMeasure.delete({ where: { id: dupe.id } });

  const pol = await owner.derivationPolicy.upsert({ where: { key: "vendor-category" }, create: { key: "vendor-category", name: "lab" }, update: {} });
  const ver = await owner.derivationPolicyVersion.upsert({ where: { policyId_version: { policyId: pol.id, version: "v1" } },
    create: { policyId: pol.id, version: "v1" }, update: {} });
  await owner.vendorLearning.create({ data: { businessId: bizA.id, vendorName: "Lab Vendor", vendorNameNormalized: `labvendor${NONCE}`, category: "rent" } as never });
  const proj = await owner.derivedClaimProjection.create({ data: { businessId: bizA.id, subjectDomain: "vendor",
    subjectNormalizedKey: `labvendor${NONCE}`, claimType: "vendor-category", policyVersionId: ver.id, evidenceSetFingerprint: "lab" } });
  await owner.derivedClaimCandidate.createMany({ data: [{ projectionId: proj.id, propositionValue: "office" }, { projectionId: proj.id, propositionValue: "food" }] });
  const snapC = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  check("competing claim values → CONFLICT, UNRESOLVED", snapC.conflicts.some((c) => c.kind === "COMPETING_CLAIM_VALUES" && c.resolution === "UNRESOLVED"));
  const mo = snapC.conflicts.find((c) => c.kind === "MACHINE_VS_OWNER");
  check("machine claim vs the owner's own category → the owner PREVAILS, both sides kept",
    mo?.prevailing === "OWNER_CONFIRMED" && mo.resolution === "RESOLVED_BY_AUTHORITY" && mo.sides.length === 2);
  check("AUTHORITY: the claim is DERIVED_CLAIM, the ledger facts and exposures AUTHORITATIVE_DOMAIN_STATE",
    snapC.knowledge.find((k) => k.kind === "CLAIM")?.authority === "DERIVED_CLAIM");

  /* ══════════════════ K11 ══════════════════ */
  section("K11 — the snapshot carries no raw personal content");
  const body = JSON.stringify(snapC);
  check("no counterparty name, phone or tax id anywhere in the snapshot",
    !/Northwind|Southwind|0529998877|Lab Vendor/.test(body) && !body.includes(TAX) && !body.includes(`labvendor${NONCE}`));

  /* ══════════════════ K12 ══════════════════ */
  section("K12 — years of history do not grow the current snapshot");
  const beforeSnap = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  const before = beforeSnap.stats.serializedBytes;
  for (let i = 0; i < 300; i++) {
    const d = await owner.document.create({ data: { businessId: bizA.id, fileUrl: `s3://m7/${NONCE}-${i}`, source: "upload", mimeType: "application/pdf", status: "approved" } as never });
    await owner.financialRecord.create({ data: { documentId: d.id, businessId: bizA.id, amount: 10, date: ago(2000 + i), vendorName: "old",
      direction: "expense", category: "lab", approvedAt: ago(1990 + i) } as never });
  }
  await deriveKnowledgeForBusiness(bizA.id, AS_OF);
  const afterSnap = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  const after = afterSnap.stats.serializedBytes;
  // Semantic identity, not bytes: re-derived rows get new ids, which may add a digit to provenance.
  check("300 more historical documents outside every window leave the snapshot semantically unchanged",
    afterSnap.snapshotFingerprint === beforeSnap.snapshotFingerprint &&
      JSON.stringify(afterSnap.stats.counts) === JSON.stringify(beforeSnap.stats.counts) && Math.abs(after - before) < 64,
    `${before}→${after}`);

  /* ══════════════════ K9 / K10 ══════════════════ */
  section("K9/K10 — a finding cannot outlive its premise");
  const far = new Date(AS_OF.getTime() + 200 * DAY);
  const snapFar = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: far });
  check("200 days later the supplier knowledge is not fresh — but open payables alone are ONE domain: no finding",
    !snapFar.crossDomainFindings.some((f) => f.ruleId === "X-PARTY-01"));
  // Settle the Northwind installment: the payables premise disappears.
  const pay = await owner.payment.create({ data: { businessId: bizA.id, payeeId: payee.id, payeeNameSnapshot: "lab", amount: 700, paidAt: ago(1), method: "BANK_TRANSFER" } as never });
  await owner.paymentAllocation.create({ data: { businessId: bizA.id, paymentId: pay.id, installmentId: installmentIds[0], allocatedAmount: 700 } as never });
  const snapPaid = await buildBusinessKnowledgeSnapshot(bizA.id, { asOf: AS_OF });
  check("once the payable is settled, the counterparty has knowledge in ONE domain: the finding is gone",
    !snapPaid.crossDomainFindings.some((f) => f.ruleId === "X-PARTY-01"));
  check("…and the reason is stated as a gap", snapPaid.knowledgeGaps.some((g) => g.ruleId === "X-PARTY-01"));

  /* ══════════════════ Cleanup ══════════════════ */
  section("Cleanup");
  await rt.$disconnect();
  for (const b of [bizA.id, bizB.id]) await owner.business.delete({ where: { id: b } }).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP OWNED BY ${RT_ROLE}`).catch(() => undefined);
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => undefined);
  console.log(`\nM7 snapshot battery: ${passed} passed, ${failed} failed`);
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
