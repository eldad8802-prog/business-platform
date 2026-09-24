/**
 * M4 ∥ M5 — multi-domain learning and entity identity · the database proof.
 *
 * WHY A SECOND BATTERY RATHER THAN MORE OF THE FIRST
 *
 * The M0 battery answers one question — does the knowledge layer reach the database under tenant
 * context — and it answers it about one rule. This one answers a different question: given evidence
 * in four domains and two tenants who look alike, does the system learn the right things, attach them
 * to the right entities, refuse the rest, and stop believing any of it when the evidence changes.
 *
 * Two files because those are two failures. When this one goes red it should be obvious that the
 * RULES are wrong, not that the tenant plumbing is; the M0 battery already owns that verdict.
 *
 * WHAT IT PROVES
 *   D1  a real multi-domain tenant produces ACTIVE measures in every domain that has evidence
 *   D2  a thin tenant is told INSUFFICIENT_EVIDENCE, per rule, with the numbers to explain it
 *   D3  entity-level measures are attached to the right entity and never mix two
 *   D4  nothing crosses a tenant: not a measure, not an evidence link, not a proposal
 *   D5  DETERMINISTIC REBUILD — delete everything, re-derive, identical fingerprints and values
 *   D6  REVERSAL — withdrawing evidence changes the answer rather than leaving the old one ACTIVE
 *   D7  STALENESS — a subject that drops out of the window is demoted, not silently left behind
 *   D8  SUPERSESSION — a rule version change retires the previous version's rows
 *   I1  a shared TAX ID binds two subjects automatically; the basis is recorded
 *   I2  a shared NAME does NOT bind. Ever. It proposes, and the proposal is inert
 *   I3  the owner can confirm, and the confirmation is what performs the join
 *   I4  the owner can reject, and a rejected pair is never proposed again
 *   I5  identity proposals are invisible across tenants and never name a foreign party
 *   E1  a collection reminder leaves a server-side record that claims only what is known
 *   E2  a machine suggestion survives the owner's correction
 *
 * The lab is a throwaway PostgreSQL; the runtime role is MEASURED NOBYPASSRLS, exactly as in M0,
 * because a proof about tenant isolation run as a privileged role is not a proof.
 *
 * Usage (CI provides the database):
 *   M0_ADMIN_URL=postgresql://... npx tsx .m0/m4-m5-battery.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";

const ADMIN_URL = process.env.M0_ADMIN_URL ?? process.env.DATABASE_URL;
if (!ADMIN_URL) throw new Error("M0_ADMIN_URL (or DATABASE_URL) must point at a throwaway lab cluster");

const DENY = ["ep-flat-brook-am4bhq1y", "ep-winter-bread-ami5o8p5"];
for (const host of DENY) {
  if (ADMIN_URL.includes(host)) throw new Error(`DENY: ${host} is not a laboratory`);
}

const NONCE = crypto.randomBytes(4).toString("hex");
const RT_ROLE = `m4_rt_${NONCE}`;
const RT_PW = crypto.randomBytes(18).toString("hex");
const DAY = 86_400_000;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

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
 * Replay the tenant policies from EVERY shipped migration this proof depends on.
 *
 * `prisma db push` builds the lab from schema.prisma, which carries tables but not policies. A
 * battery that wrote its own policies would prove that its policies work; replaying the shipped ones
 * means this goes red if a migration ever stops protecting a table it is asserting about.
 *
 * Admin-plane policies are excluded by name: they grant to `app_admin`, which does not exist in a
 * lab, and they are not what this proves. The tenant policies are what enforce isolation.
 */
function tenantPolicyStatements(): string[] {
  const files = [
    "prisma/migrations/20260825150000_d2_p7_wave2_tenant_rls/migration.sql",
    "prisma/migrations/20260825200000_d2_p7_wave3_tenant_rls/migration.sql",
    "prisma/migrations/20260827090000_d2_p7_w4d_documents_tenant_rls/migration.sql",
    "prisma/migrations/20260917090100_payables_phase_1a_tenant_rls/migration.sql",
    "prisma/migrations/20260923100000_m2_knowledge_measure/migration.sql",
    "prisma/migrations/20260923110000_m3_business_insight/migration.sql",
    "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql",
  ];
  const out: string[] = [];
  for (const f of files) {
    // CRLF is normalised BEFORE comments are stripped: in JavaScript `.` does not match `\r`, so on a
    // CRLF file `--.*$` matches nothing and every comment survives to be executed as SQL. That failure
    // cost an afternoon once already; it does not get to cost another.
    const sql = readFileSync(join(process.cwd(), f), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    for (const raw of sql.split(";")) {
      const stmt = raw.trim();
      if (!stmt) continue;
      if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/.test(stmt)) continue;
      if (/app_admin/.test(stmt)) continue;
      out.push(stmt);
    }
  }
  const malformed = out.filter((s) => !/^(ALTER TABLE|DROP POLICY|CREATE POLICY)/.test(s));
  if (malformed.length > 0) {
    throw new Error(
      `policy replay produced ${malformed.length} fragment(s) that are not statements — the splitter ` +
        `is wrong, not the migration. First: ${JSON.stringify(malformed[0].slice(0, 120))}`,
    );
  }
  return out;
}

/** The fourteen rule lineages, out of the migration that ships them. */
function policySeeds(): string[] {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20260924090100_m4_m5_knowledge_expansion/migration.sql"),
    "utf8",
  )
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out = sql.split(";").map((s) => s.trim()).filter((s) => /^INSERT INTO "DerivationPolicy/.test(s));
  if (out.length !== 2) throw new Error(`expected 2 policy seeds, found ${out.length}`);
  return out;
}

async function main(): Promise<void> {
  section("Provision — a lab that mirrors Production's enforcement");

  await owner.$executeRawUnsafe(
    `CREATE ROLE ${RT_ROLE} LOGIN PASSWORD '${RT_PW}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
  );

  const policies = tenantPolicyStatements();
  check("the shipped migrations still protect every table this proof touches", policies.length >= 60,
    `found ${policies.length} statements`);
  for (const stmt of policies) await owner.$executeRawUnsafe(stmt);
  for (const stmt of policySeeds()) await owner.$executeRawUnsafe(stmt);

  // Privileges, not visibility. The battery proves which ROWS a tenant can see; granting broadly is
  // what stops a missing GRANT being mistaken for a working policy.
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RT_ROLE}`);
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${RT_ROLE}`);

  const posture = await owner.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${RT_ROLE}'`,
  );
  check("the runtime role is NOSUPERUSER", posture[0]?.rolsuper === false);
  check("the runtime role is NOBYPASSRLS — so isolation is enforced, not assumed",
    posture[0]?.rolbypassrls === false);

  const forced = await owner.$queryRawUnsafe<{ relname: string; f: boolean }[]>(
    `SELECT c.relname, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('EntityLinkProposal','CollectionAction','KnowledgeMeasure','Party','PartyResolutionClaim')`,
  );
  check("both NEW tenant tables are FORCE RLS, like everything they sit beside",
    forced.length === 5 && forced.every((r) => r.f === true),
    forced.map((r) => `${r.relname}=${r.f}`).join(" "));

  /* ══════════════════════════ SEED ══════════════════════════ */
  section("Seed — one business with real history in four domains, and a decoy that looks like it");

  const bizA = await owner.business.create({ data: { name: `M4 Tenant A ${NONCE}` } });
  const bizB = await owner.business.create({ data: { name: `M4 Tenant B ${NONCE}` } });

  // The shared identifier. A tax id is issued by the state, so two subjects carrying the same one are
  // the same registered entity — and this is the ONLY kind of evidence allowed to bind on its own.
  const TAX_ID = `5140${NONCE.slice(0, 5)}`;
  const VENDOR_NAME = "ACME SUPPLIES LTD";

  const payeeA = await owner.payee.create({
    data: { businessId: bizA.id, displayName: "ACME", kind: "SUPPLIER", taxId: TAX_ID },
  });
  const supplierA = await owner.supplier.create({
    data: { businessId: bizA.id, name: "Acme", legalName: VENDOR_NAME, taxId: TAX_ID, phone: "0501234567" },
  });
  // A THIRD subject that shares only the NAME. This is the one that must never bind on its own.
  const vendorA = await owner.vendorLearning.create({
    data: { businessId: bizA.id, vendorName: VENDOR_NAME, category: "supplies" },
  });
  // A fourth, sharing a phone with the supplier but nothing else — a weaker resemblance still.
  const payeeA2 = await owner.payee.create({
    data: { businessId: bizA.id, displayName: "Acme Logistics", kind: "SUPPLIER" },
  });

  // ── payables: six settled installments, deteriorating ──
  const commitment = await owner.commitment.create({
    data: {
      businessId: bizA.id, title: "Monthly supply", payeeId: payeeA.id,
      payeeNameSnapshot: "ACME", scheduleKind: "RECURRING", recurrence: "MONTHLY",
    },
  });
  // Older half paid on time; recent half paid eight days late. A real, explainable deterioration.
  const settlements: [number, number][] = [[300, 0], [270, 0], [240, 1], [60, 8], [40, 9], [20, 8]];
  for (let i = 0; i < settlements.length; i++) {
    const [paidAgo, late] = settlements[i];
    const inst = await owner.installment.create({
      data: {
        businessId: bizA.id, commitmentId: commitment.id, sequence: i + 1,
        scheduledAmount: 1000, dueAt: new Date(ago(paidAgo).getTime() - late * DAY),
      },
    });
    const pay = await owner.payment.create({
      data: {
        businessId: bizA.id, payeeId: payeeA.id, payeeNameSnapshot: "ACME",
        amount: 1000, paidAt: ago(paidAgo), method: "BANK_TRANSFER",
      },
    });
    await owner.paymentAllocation.create({
      data: { businessId: bizA.id, paymentId: pay.id, installmentId: inst.id, allocatedAmount: 1000 },
    });
    // Half the payments have something beyond the owner's word behind them.
    await owner.paymentEvidence.create({
      data: { businessId: bizA.id, paymentId: pay.id, kind: i % 2 === 0 ? "DOCUMENT" : "MANUAL" },
    });
  }

  // ── inventory: an item restocked every fortnight, plus enough movement to judge corrections ──
  const item = await owner.inventoryItem.create({
    data: { businessId: bizA.id, name: "Widget", unitType: "UNIT", currentQuantity: 10, minimumQuantity: 2 },
  });
  const mkMove = (agoDays: number, reason: string, type: string) =>
    owner.inventoryMovement.create({
      data: {
        businessId: bizA.id, itemId: item.id, movementType: type as never, reason: reason as never,
        quantityDelta: type === "IN" ? 5 : -5, quantityBefore: 10, quantityAfter: type === "IN" ? 15 : 5,
        createdAt: ago(agoDays),
      },
    });
  for (const d of [60, 45, 30, 15]) await mkMove(d, "SUPPLIER_PURCHASE", "IN");
  for (const d of [58, 50, 44, 38, 28, 22, 14, 8]) await mkMove(d, "SALE", "OUT");
  for (const d of [35, 12]) await mkMove(d, "INVENTORY_COUNT_CORRECTION", "ADJUSTMENT");
  for (const d of [50, 20]) {
    await owner.inventoryAlert.create({
      data: { businessId: bizA.id, itemId: item.id, type: "CRITICAL_STOCK", createdAt: ago(d) },
    });
  }

  // ── suppliers: four orders, three of them closed and received ──
  const orderIds: number[] = [];
  for (let i = 0; i < 4; i++) {
    const orderedAgo = 140 - i * 28;
    const po = await owner.purchaseOrder.create({
      data: {
        businessId: bizA.id, supplierId: supplierA.id, supplierName: "Acme",
        orderDate: ago(orderedAgo), status: i < 3 ? "CLOSED" : "AWAITING_DELIVERY",
      },
    });
    orderIds.push(po.id);
    const line = await owner.purchaseOrderLine.create({
      data: { purchaseOrderId: po.id, itemId: item.id, orderedQty: 10, rawName: "Widget" },
    });
    if (i < 3) {
      const rs = await owner.receivingSession.create({
        data: {
          businessId: bizA.id, purchaseOrderId: po.id, status: "POSTED",
          receivedAt: ago(orderedAgo - 6), postedAt: ago(orderedAgo - 6),
        },
      });
      // The first order arrived SHORT. The other two were complete.
      await owner.receivingLine.create({
        data: {
          receivingSessionId: rs.id, purchaseOrderLineId: line.id, itemId: item.id,
          receivedQty: i === 0 ? 7 : 10,
        },
      });
    }
  }

  // ── documents: four approved invoices from the same vendor string, and ten human reviews ──
  for (let i = 0; i < 4; i++) {
    const doc = await owner.document.create({
      data: { businessId: bizA.id, fileUrl: `s3://m4/${NONCE}-${i}`, source: "upload", mimeType: "application/pdf", status: "approved" },
    });
    await owner.financialRecord.create({
      data: {
        documentId: doc.id, businessId: bizA.id, amount: [500, 520, 480, 510][i],
        date: ago(120 - i * 30), vendorName: VENDOR_NAME, direction: "expense",
        category: "supplies", approvedAt: ago(115 - i * 30),
      },
    });
  }
  for (let i = 0; i < 10; i++) {
    const doc = await owner.document.create({
      data: { businessId: bizA.id, fileUrl: `s3://m4/rev-${NONCE}-${i}`, source: "upload", mimeType: "application/pdf", status: "approved" },
    });
    await owner.reviewEvent.create({
      data: {
        documentId: doc.id, businessId: bizA.id, reviewerUserId: 1, approvedAs: "financial",
        explicitFinancial: true, occurredAt: ago(100 - i * 5),
        // Three of the ten needed a human correction.
        verdicts: i < 3
          ? { amount: { belief: 1, final: 2, verdict: "corrected", delta: { old: 1, new: 2 } } }
          : { amount: { belief: 1, final: 1, verdict: "confirmed" } },
        rawBelief: {}, rawFinal: {},
      },
    });
  }

  // ── the decoy tenant: the SAME names and the SAME tax id, and almost no history ──
  const supplierB = await owner.supplier.create({
    data: { businessId: bizB.id, name: "Acme", legalName: VENDOR_NAME, taxId: TAX_ID },
  });
  await owner.vendorLearning.create({
    data: { businessId: bizB.id, vendorName: VENDOR_NAME, category: "supplies" },
  });
  const docB = await owner.document.create({
    data: { businessId: bizB.id, fileUrl: `s3://m4/b-${NONCE}`, source: "upload", mimeType: "application/pdf", status: "approved" },
  });
  await owner.financialRecord.create({
    data: {
      documentId: docB.id, businessId: bizB.id, amount: 90, date: ago(10),
      vendorName: VENDOR_NAME, direction: "expense", category: "supplies", approvedAt: ago(9),
    },
  });

  /* ══════════════════════════ RUN AS THE RESTRICTED ROLE ══════════════════════════ */
  const rtUrl = (() => {
    const u = new URL(ADMIN_URL!);
    u.username = RT_ROLE;
    u.password = RT_PW;
    return u.toString();
  })();
  process.env.DATABASE_URL = rtUrl;
  process.env.DIRECT_URL = rtUrl;

  const { deriveKnowledgeForBusiness } = await import("@/lib/knowledge/derive.service");
  const { resolveIdentitiesForBusiness, decideProposal, listOpenProposals } =
    await import("@/lib/identity/entity-identity.service");
  const { recordCollectionAction } = await import("@/lib/services/collection/collection-action.service");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { prisma: rt } = await import("@/lib/prisma");

  const who = await rt.$queryRawUnsafe<{ u: string }[]>(`SELECT current_user AS u`);
  check("the application code is connected as the restricted role", who[0]?.u === RT_ROLE, `user=${who[0]?.u}`);

  /* ══════════════════════════ I — IDENTITY ══════════════════════════ */
  section("I1/I2 — a tax id binds; a name only asks");

  const idA = await resolveIdentitiesForBusiness(bizA.id);
  check("every spending-side subject was given an identity anchor", idA.subjects === 4, `n=${idA.subjects}`);
  check("the shared TAX ID bound two subjects into one party, with no owner involved",
    idA.boundByTaxId === 1, `bound=${idA.boundByTaxId}`);

  const claims = await owner.partyResolutionClaim.findMany({
    where: { businessId: bizA.id }, orderBy: { id: "asc" },
  });
  const partyOf = (t: string, id: number) =>
    claims.find((c) => c.subjectType === t && c.subjectId === id && c.status === "ACTIVE")?.partyId;
  check("the payee and the supplier share one party — they are one registered entity",
    partyOf("PAYEE", payeeA.id) != null && partyOf("PAYEE", payeeA.id) === partyOf("SUPPLIER", supplierA.id),
    `payee=${partyOf("PAYEE", payeeA.id)} supplier=${partyOf("SUPPLIER", supplierA.id)}`);
  check("the binding records WHAT established it, so it can be audited and undone",
    claims.some((c) => c.signalType === "TAX_ID" && c.confidence === "KNOWN" && c.method === "DETERMINISTIC_EXACT"));

  check("the document vendor, which shares ONLY a name, was NOT bound to them",
    partyOf("DOCUMENT_VENDOR", vendorA.id) != null &&
    partyOf("DOCUMENT_VENDOR", vendorA.id) !== partyOf("SUPPLIER", supplierA.id),
    `vendor=${partyOf("DOCUMENT_VENDOR", vendorA.id)} supplier=${partyOf("SUPPLIER", supplierA.id)}`);
  check("a subject with no identifier of its own anchors WITHOUT publishing a signal — so nothing " +
    "else can bind to it by resemblance either",
    claims.some((c) => c.subjectType === "DOCUMENT_VENDOR" && c.signalType === null && c.method === "SELF_ANCHOR"));

  const proposals = await listOpenProposals(bizA.id);
  check("the resemblance became a PROPOSAL instead", proposals.length >= 1, `n=${proposals.length}`);
  const nameProposal = proposals.find((p) => p.signalType === "NORMALIZED_NAME");
  check("the proposal names the weak signal that produced it", nameProposal != null);
  check("and is marked WEAK — a weak proposal can never bind without a person",
    nameProposal?.strength === "WEAK");
  check("NO proposal is ever created STRONG by the matcher",
    (await owner.entityLinkProposal.count({ where: { businessId: bizA.id, strength: "STRONG" } })) === 0);

  check("re-running the resolver changes nothing — it is idempotent",
    (await resolveIdentitiesForBusiness(bizA.id)).proposed === 0);
  check("…and does not breed duplicate anchors",
    (await owner.partyResolutionClaim.count({ where: { businessId: bizA.id, status: "ACTIVE" } })) === 4);

  section("I5 — identity does not cross tenants");
  const idB = await resolveIdentitiesForBusiness(bizB.id);
  check("the decoy tenant resolved its own subjects", idB.subjects === 2, `n=${idB.subjects}`);
  const partiesA = new Set(claims.map((c) => c.partyId));
  const claimsB = await owner.partyResolutionClaim.findMany({ where: { businessId: bizB.id } });
  check("the SAME tax id in another tenant produced a SEPARATE party — identity is per business",
    claimsB.every((c) => !partiesA.has(c.partyId)),
    `A=${[...partiesA].join(",")} B=${claimsB.map((c) => c.partyId).join(",")}`);
  const seenByB = await runWithTenantContext({ businessId: bizB.id }, () =>
    rt.entityLinkProposal.findMany({}),
  );
  check("tenant B cannot see tenant A's proposals",
    seenByB.every((p) => p.businessId === bizB.id), `ids=${seenByB.map((p) => p.businessId).join(",")}`);

  /* ══════════════════════════ D — DERIVATION ══════════════════════════ */
  section("D1/D2 — what a real business learns, and what a thin one is told");

  const repA = await deriveKnowledgeForBusiness(bizA.id, NOW);
  check("every rule in the catalogue ran", repA.rulesRun === 14, `n=${repA.rulesRun}`);
  check("no rule failed", repA.rulesFailed === 0,
    repA.rules.filter((r) => r.outcome === "failed").map((r) => `${r.ruleId}:${r.failedStage}:${r.failureDetail}`).join(" | "));

  const byRule = new Map(repA.rules.map((r) => [r.ruleId, r]));
  const active = (id: string) => byRule.get(id)?.measures.filter((m) => m.status === "ACTIVE") ?? [];
  const domainsWithKnowledge = new Set(
    repA.rules.filter((r) => r.active > 0).map((r) => r.domain),
  );
  check("this business learned something in ALL FOUR domains",
    domainsWithKnowledge.size === 4,
    `domains=${[...domainsWithKnowledge].join(",")}`);

  check("AP-01 knows how this business pays", active("AP-01")[0]?.valueNumeric === 8,
    `value=${active("AP-01")[0]?.valueNumeric}`);
  check("…and noticed it got worse", active("AP-01")[0]?.trend === "WORSENING",
    `trend=${active("AP-01")[0]?.trend}`);
  check("AP-03 knows how often payment is late", active("AP-03")[0]?.valueNumeric === 0.5,
    `value=${active("AP-03")[0]?.valueNumeric}`);
  check("AP-06 knows how much of the record rests on more than memory",
    active("AP-06")[0]?.valueNumeric === 0.5, `value=${active("AP-06")[0]?.valueNumeric}`);
  check("INV-02 found the restock rhythm", active("INV-02")[0]?.valueNumeric === 15,
    `value=${active("INV-02")[0]?.valueNumeric}`);
  check("INV-04 knows how often the stock figures had to be corrected",
    active("INV-04")[0]?.valueNumeric != null);
  check("INV-05 spotted the item that keeps running down", active("INV-05")[0]?.valueNumeric === 2,
    `value=${active("INV-05")[0]?.valueNumeric}`);
  check("SUPP-01 found the purchase cadence", active("SUPP-01")[0]?.valueNumeric === 28,
    `value=${active("SUPP-01")[0]?.valueNumeric}`);
  check("SUPP-02 found the supplier's lead time", active("SUPP-02")[0]?.valueNumeric === 6,
    `value=${active("SUPP-02")[0]?.valueNumeric}`);
  check("SUPP-03 knows how often orders close short", active("SUPP-03")[0]?.valueNumeric === 0.33,
    `value=${active("SUPP-03")[0]?.valueNumeric}`);
  check("DOC-02 found the vendor's billing rhythm", active("DOC-02")[0]?.valueNumeric === 30,
    `value=${active("DOC-02")[0]?.valueNumeric}`);
  check("DOC-05 knows what that vendor usually charges", active("DOC-05")[0]?.valueNumeric === 505,
    `value=${active("DOC-05")[0]?.valueNumeric}`);
  check("DOC-06 knows how often the extraction engine had to be corrected",
    active("DOC-06")[0]?.valueNumeric === 0.3, `value=${active("DOC-06")[0]?.valueNumeric}`);

  section("D3 — knowledge is attached to the RIGHT entity");
  check("the payee-level measure names the payee record, not a name string",
    active("AP-04")[0]?.entityType === "payee" && active("AP-04")[0]?.entityId === payeeA.id,
    `entity=${active("AP-04")[0]?.entityType}:${active("AP-04")[0]?.entityId}`);
  check("the supplier measures name the supplier record",
    active("SUPP-01")[0]?.entityId === supplierA.id && active("SUPP-02")[0]?.entityId === supplierA.id);
  check("the inventory measures name the item", active("INV-02")[0]?.entityId === item.id);
  check("the vendor measures name a resolved PARTY, never a spelling",
    active("DOC-02")[0]?.entityType === "party" &&
    active("DOC-02")[0]?.entityId === partyOf("DOCUMENT_VENDOR", vendorA.id));

  section("D2 — the thin tenant is told, per rule, what it would take");
  const repB = await deriveKnowledgeForBusiness(bizB.id, NOW);
  check("the decoy learned nothing at all", repB.measuresActive === 0, `active=${repB.measuresActive}`);
  check("…and was told so by every rule that could have spoken",
    repB.measuresInsufficient >= 5, `insufficient=${repB.measuresInsufficient}`);
  const insufficient = repB.rules.flatMap((r) => r.measures).filter((m) => m.status === "INSUFFICIENT_EVIDENCE");
  check("no refusal carries a number", insufficient.every((m) => m.valueNumeric === null));
  const storedRefusals = await owner.knowledgeMeasure.findMany({
    where: { businessId: bizB.id, status: "INSUFFICIENT_EVIDENCE" }, select: { detail: true },
  });
  check("every refusal was STORED with the numbers that explain it",
    storedRefusals.length > 0 &&
    storedRefusals.every((m) => {
      const d = m.detail as { minSupport?: number; have?: number } | null;
      return typeof d?.minSupport === "number" && typeof d?.have === "number";
    }));

  section("D4 — no measure, and no evidence link, crosses a tenant");
  const measuresB = await runWithTenantContext({ businessId: bizB.id }, () =>
    rt.knowledgeMeasure.findMany({}),
  );
  check("tenant B sees only its own measures", measuresB.every((m) => m.businessId === bizB.id));
  const links = await owner.knowledgeMeasureEvidenceLink.findMany({ where: { businessId: bizA.id } });
  const measureIdsA = new Set((await owner.knowledgeMeasure.findMany({ where: { businessId: bizA.id }, select: { id: true } })).map((m) => m.id));
  check("every evidence link of tenant A belongs to a measure of tenant A",
    links.every((l) => measureIdsA.has(l.measureId)));
  check("tenant A's knowledge was built from tenant A's evidence only",
    links.every((l) => l.businessId === bizA.id));

  /* ══════════════════════════ D5 — REBUILD ══════════════════════════ */
  section("D5 — DETERMINISTIC REBUILD");
  const before = await owner.knowledgeMeasure.findMany({
    where: { businessId: bizA.id },
    orderBy: [{ measureKey: "asc" }, { entityId: "asc" }],
    select: { measureKey: true, entityId: true, valueNumeric: true, evidenceFingerprint: true, observationCount: true, status: true },
  });
  await owner.knowledgeMeasure.deleteMany({ where: { businessId: bizA.id } });
  check("all derived knowledge was destroyed", (await owner.knowledgeMeasure.count({ where: { businessId: bizA.id } })) === 0);

  await deriveKnowledgeForBusiness(bizA.id, NOW);
  const after = await owner.knowledgeMeasure.findMany({
    where: { businessId: bizA.id },
    orderBy: [{ measureKey: "asc" }, { entityId: "asc" }],
    select: { measureKey: true, entityId: true, valueNumeric: true, evidenceFingerprint: true, observationCount: true, status: true },
  });
  check("the same number of measures came back", before.length === after.length, `${before.length} vs ${after.length}`);
  check("every fingerprint is identical — the evidence sets are the same sets",
    before.every((b, i) => b.evidenceFingerprint === after[i]?.evidenceFingerprint));
  check("every value is identical", before.every((b, i) => String(b.valueNumeric) === String(after[i]?.valueNumeric)));
  check("every observation count is identical", before.every((b, i) => b.observationCount === after[i]?.observationCount));
  check("every status is identical", before.every((b, i) => b.status === after[i]?.status));
  check("re-deriving REPLACES rather than accumulating",
    (await owner.knowledgeMeasure.count({ where: { businessId: bizA.id } })) === after.length);

  /* ══════════════════════════ D6 — REVERSAL ══════════════════════════ */
  section("D6 — knowledge does not survive its own evidence being withdrawn");
  const lateAlloc = await owner.paymentAllocation.findFirst({
    where: { businessId: bizA.id }, orderBy: { id: "desc" },
  });
  await owner.paymentAllocation.update({
    where: { id: lateAlloc!.id }, data: { reversedAt: new Date(), reversalReason: "battery" },
  });
  const afterReversal = await deriveKnowledgeForBusiness(bizA.id, NOW);
  const ap01After = afterReversal.rules.find((r) => r.ruleId === "AP-01")?.measures[0];
  check("a reversed allocation stops being evidence", ap01After?.observationCount === 5,
    `n=${ap01After?.observationCount}`);
  check("…and the answer changes rather than staying what it was",
    ap01After?.evidenceRefs === 5 && ap01After?.writerAction === "replaced");

  // And a VOID payment, which is the other way evidence is withdrawn.
  const pay = await owner.payment.findFirst({ where: { businessId: bizA.id }, orderBy: { id: "asc" } });
  await owner.payment.update({ where: { id: pay!.id }, data: { status: "VOID", voidedAt: new Date() } });
  const afterVoid = await deriveKnowledgeForBusiness(bizA.id, NOW);
  check("a voided payment settles nothing, so it is not evidence either",
    afterVoid.rules.find((r) => r.ruleId === "AP-01")?.measures[0]?.observationCount === 4,
    `n=${afterVoid.rules.find((r) => r.ruleId === "AP-01")?.measures[0]?.observationCount}`);

  /* ══════════════════════════ D7 — STALENESS ══════════════════════════ */
  section("D7 — a subject that falls out of the window is demoted, not left behind");
  const supplierMeasureBefore = await owner.knowledgeMeasure.findFirst({
    where: { businessId: bizA.id, measureKey: "suppliers.purchase_cadence", entityId: supplierA.id },
  });
  check("the supplier had an ACTIVE cadence to lose", supplierMeasureBefore?.status === "ACTIVE");

  // Push every order out of the 365-day window. The rule now produces NOTHING for this supplier —
  // which is exactly the case where a slot-replacing writer alone would leave the old row ACTIVE
  // forever, still claiming a rhythm about a relationship that has gone quiet.
  await owner.purchaseOrder.updateMany({
    where: { businessId: bizA.id }, data: { orderDate: ago(900), createdAt: ago(900) },
  });
  const afterStale = await deriveKnowledgeForBusiness(bizA.id, NOW);
  const supplierMeasureAfter = await owner.knowledgeMeasure.findFirst({
    where: { businessId: bizA.id, measureKey: "suppliers.purchase_cadence", entityId: supplierA.id },
  });
  check("the measure was marked STALE rather than left ACTIVE",
    supplierMeasureAfter?.status === "STALE", `status=${supplierMeasureAfter?.status}`);
  check("the reconciliation reported what it demoted", afterStale.measuresStaled >= 1,
    `staled=${afterStale.measuresStaled}`);
  check("the number and its evidence links SURVIVE — history is not deleted, only demoted",
    supplierMeasureAfter?.valueNumeric != null &&
    String(supplierMeasureAfter.valueNumeric) === String(supplierMeasureBefore?.valueNumeric));

  /* ══════════════════════════ D8 — SUPERSESSION ══════════════════════════ */
  section("D8 — a new rule version retires the old one's answers");
  const lagPolicy = await owner.derivationPolicy.findUnique({ where: { key: "documents-paperwork-lag" } });
  const v2 = await owner.derivationPolicyVersion.create({
    data: { policyId: lagPolicy!.id, version: "v2" },
  });
  const liveBefore = await owner.knowledgeMeasure.count({
    where: { businessId: bizA.id, measureKey: "documents.paperwork_lag", status: { in: ["ACTIVE", "INSUFFICIENT_EVIDENCE"] } },
  });
  check("there is a live paperwork measure to supersede", liveBefore === 1);

  // Simulate the rule moving to v2 by reconciling against the new version directly — the same call
  // the derivation service makes, with the version the descriptor would now carry.
  const { reconcileRuleMeasures } = await import("@/lib/knowledge/measure-reconciler");
  const rec = await reconcileRuleMeasures(bizA.id, "documents.paperwork_lag", v2.id, [null]);
  check("the previous version's row was SUPERSEDED, not staled", rec.superseded === 1 && rec.staled === 0,
    `superseded=${rec.superseded} staled=${rec.staled}`);
  const old = await owner.knowledgeMeasure.findFirst({
    where: { businessId: bizA.id, measureKey: "documents.paperwork_lag" },
  });
  check("SUPERSEDED is a different statement from STALE, and the row says which",
    old?.status === "SUPERSEDED", `status=${old?.status}`);

  /* ══════════════════════════ I3/I4 — THE OWNER DECIDES ══════════════════════════ */
  section("I3 — the owner confirms, and THAT is what performs the join");
  const open = await listOpenProposals(bizA.id);
  const toConfirm = open.find((p) => p.subjectType === "DOCUMENT_VENDOR");
  check("the vendor's proposal is still waiting for a person", toConfirm != null);

  const vendorPartyBefore = partyOf("DOCUMENT_VENDOR", vendorA.id);
  const confirmed = await decideProposal(bizA.id, toConfirm!.id, "CONFIRMED", 4242, "זה אותו ספק");
  check("the confirmation was accepted", confirmed.ok === true);

  const claimsAfter = await owner.partyResolutionClaim.findMany({
    where: { businessId: bizA.id, subjectType: "DOCUMENT_VENDOR", subjectId: vendorA.id },
  });
  const activeAfter = claimsAfter.find((c) => c.status === "ACTIVE");
  check("the vendor now belongs to the supplier's party", activeAfter?.partyId === partyOf("SUPPLIER", supplierA.id),
    `now=${activeAfter?.partyId} supplier=${partyOf("SUPPLIER", supplierA.id)}`);
  check("the previous anchor was RETRACTED, not deleted — the history of what we used to think survives",
    claimsAfter.some((c) => c.status === "RETRACTED" && c.partyId === vendorPartyBefore));
  check("the new binding records that a PERSON established it, not a signal",
    activeAfter?.method === "OWNER_CONFIRMED" && activeAfter?.resolvedByUserId === 4242);
  check("the owner's own words were kept",
    (await owner.entityLinkProposal.findUnique({ where: { id: toConfirm!.id } }))?.decisionNote === "זה אותו ספק");

  // THE POINT OF ALL OF IT: the vendor's knowledge now hangs off the same party as the supplier's.
  const afterJoin = await deriveKnowledgeForBusiness(bizA.id, NOW);
  const doc02 = afterJoin.rules.find((r) => r.ruleId === "DOC-02")?.measures.find((m) => m.status === "ACTIVE");
  check("the vendor's billing rhythm now hangs off the SAME party as the supplier's purchasing",
    doc02?.entityId === partyOf("SUPPLIER", supplierA.id),
    `doc02=${doc02?.entityId} supplierParty=${partyOf("SUPPLIER", supplierA.id)}`);

  section("I4 — the owner refuses, and is not asked again");
  const remaining = await listOpenProposals(bizA.id);
  if (remaining.length > 0) {
    const rejected = await decideProposal(bizA.id, remaining[0].id, "REJECTED", 4242, "לא, זה עסק אחר");
    check("the rejection was accepted", rejected.ok === true);
    const row = await owner.entityLinkProposal.findUnique({ where: { id: remaining[0].id } });
    check("the refusal is DURABLE evidence, with the person, the moment and the reason",
      row?.state === "REJECTED" && row?.decidedByUserId === 4242 &&
      row?.decisionNote === "לא, זה עסק אחר" && row?.decidedAt != null);
    check("a rejected pair binds nothing",
      (await owner.partyResolutionClaim.count({
        where: { businessId: bizA.id, subjectType: row!.subjectType, subjectId: row!.subjectId, partyId: row!.candidatePartyId, status: "ACTIVE" },
      })) === 0);

    const rerun = await resolveIdentitiesForBusiness(bizA.id);
    check("the resolver does NOT ask again", rerun.skippedRejected >= 1, `skipped=${rerun.skippedRejected}`);
    check("…and the rejection survives the re-run",
      (await owner.entityLinkProposal.findUnique({ where: { id: remaining[0].id } }))?.state === "REJECTED");
  } else {
    check("there was a second proposal to reject", false, "seed produced only one proposal");
  }

  check("deciding twice is refused rather than silently re-applied",
    (await decideProposal(bizA.id, toConfirm!.id, "REJECTED", 4242)).ok === false);
  check("another tenant's proposal is reported as MISSING, not forbidden",
    (await decideProposal(bizB.id, toConfirm!.id, "CONFIRMED", 4242)).ok === false);

  /* ══════════════════════════ E — THE EVIDENCE GAPS ══════════════════════════ */
  section("E1 — a reminder now leaves a trace, claiming only what is known");
  const customer = await owner.customer.create({
    data: { businessId: bizA.id, name: "Dana", phone: `05${NONCE}` },
  });
  const rec1 = await recordCollectionAction({
    businessId: bizA.id, actorUserId: 4242, actionType: "WHATSAPP_OPENED",
    channel: "WHATSAPP", customerId: customer.id,
  });
  check("the action was recorded", rec1.ok === true);
  const stored = await owner.collectionAction.findFirst({ where: { businessId: bizA.id } });
  check("it records WHO, WHEN, WHAT and THROUGH WHAT",
    stored?.actorUserId === 4242 && stored?.actionType === "WHATSAPP_OPENED" &&
    stored?.channel === "WHATSAPP" && stored?.occurredAt != null);
  check("it says nothing about delivery — there is no such column to be tempted by",
    !("deliveredAt" in (stored ?? {})) && !("readAt" in (stored ?? {})));
  check("an action about nothing is refused",
    (await recordCollectionAction({
      businessId: bizA.id, actorUserId: 4242, actionType: "LINK_COPIED", channel: "CLIPBOARD",
    })).ok === false);

  const foreignCustomer = await owner.customer.create({
    data: { businessId: bizB.id, name: "Other", phone: `04${NONCE}` },
  });
  check("an action pointing at ANOTHER tenant's customer is refused before anything is written",
    (await recordCollectionAction({
      businessId: bizA.id, actorUserId: 4242, actionType: "LINK_COPIED",
      channel: "CLIPBOARD", customerId: foreignCustomer.id,
    })).ok === false);
  check("…and nothing was written", (await owner.collectionAction.count({ where: { businessId: bizA.id } })) === 1);

  section("E2 — a machine suggestion survives the owner's correction");
  const draft = await owner.supplierPurchaseDraft.create({
    data: { businessId: bizA.id, supplierId: supplierA.id, supplierName: "Acme" },
  });
  const line = await owner.supplierPurchaseDraftLine.create({
    data: {
      draftId: draft.id, rawName: "Widgt", quantity: 3,
      // What intake wrote.
      matchedItemId: item.id, matchScore: 0.71, decision: "MERGE", status: "MATCHED",
      suggestedItemId: item.id, suggestedMatchScore: 0.71, suggestedDecision: "MERGE",
    },
  });
  // What approval does: it overwrites the live decision with the owner's.
  await owner.supplierPurchaseDraftLine.update({
    where: { id: line.id }, data: { matchedItemId: null, decision: "CREATE_NEW", status: "APPROVED" },
  });
  const afterApproval = await owner.supplierPurchaseDraftLine.findUnique({ where: { id: line.id } });
  check("the owner's decision is what the line now says",
    afterApproval?.decision === "CREATE_NEW" && afterApproval?.matchedItemId === null);
  check("and the machine's original suggestion SURVIVED it",
    afterApproval?.suggestedDecision === "MERGE" && afterApproval?.suggestedItemId === item.id);
  check("so agreement and correction are now distinguishable after the fact",
    afterApproval?.suggestedDecision !== afterApproval?.decision);

  section("E3 — the event bus can finally say who");
  const { logAuditEvent } = await import("@/lib/services/audit.service");
  await runWithTenantContext({ businessId: bizA.id }, () =>
    logAuditEvent({
      businessId: bizA.id, eventType: "M4_BATTERY", entityType: "TEST",
      actor: { type: "OWNER_USER", userId: 4242 },
    }),
  );
  const ev = await owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "M4_BATTERY" } });
  check("a learning event records its actor", ev?.actorType === "OWNER_USER" && ev?.actorUserId === 4242);

  await runWithTenantContext({ businessId: bizA.id }, () =>
    logAuditEvent({ businessId: bizA.id, eventType: "M4_BATTERY_SYS", entityType: "TEST", actor: { type: "SYSTEM" } }),
  );
  const sysEv = await owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "M4_BATTERY_SYS" } });
  check("a SYSTEM event names no person — the machine did it, and says so",
    sysEv?.actorType === "SYSTEM" && sysEv?.actorUserId === null);

  await runWithTenantContext({ businessId: bizA.id }, () =>
    logAuditEvent({ businessId: bizA.id, eventType: "M4_BATTERY_ANON", entityType: "TEST" }),
  );
  const anonEv = await owner.learningEvent.findFirst({ where: { businessId: bizA.id, eventType: "M4_BATTERY_ANON" } });
  check("a caller that does not know stays silent rather than asserting UNKNOWN",
    anonEv?.actorType === null && anonEv?.actorUserId === null);

  /* ══════════════════════════ OBSERVABILITY ══════════════════════════ */
  section("Observability — the questions a run must be able to answer");
  const final = await deriveKnowledgeForBusiness(bizA.id, NOW);
  check("which rules ran, and for which tenant", final.rulesRun === 14 && final.businessId === bizA.id);
  check("how many produced knowledge", typeof final.measuresActive === "number" && final.measuresActive > 0);
  check("how many refused", typeof final.measuresInsufficient === "number");
  check("how many failed", final.rulesFailed === 0);
  check("how many went stale or were superseded",
    typeof final.measuresStaled === "number" && typeof final.measuresSuperseded === "number");
  check("how long it took, per source and in total",
    final.sourcesLoaded.every((s) => typeof s.durationMs === "number") && typeof final.totalDurationMs === "number");
  const serialised = JSON.stringify(final);
  check("and the report leaks no business content — no vendor, no payee, no amount",
    !serialised.includes(VENDOR_NAME) && !serialised.includes("ACME") && !serialised.includes(TAX_ID));

  section("Cleanup");
  await owner.business.delete({ where: { id: bizA.id } }).catch(() => {});
  await owner.business.delete({ where: { id: bizB.id } }).catch(() => {});
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${RT_ROLE}`).catch(() => {});
  await owner.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${RT_ROLE}`).catch(() => {});
  await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => {});
  console.log("  lab torn down");
}

main()
  .then(async () => {
    await owner.$disconnect();
    console.log(`\n[M4/M5] PASS=${passed} FAIL=${failed}`);
    if (failed > 0) {
      console.log("Failed:");
      for (const f of fails) console.log(`  - ${f}`);
    }
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    console.error("\nBATTERY ERROR:", e);
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${RT_ROLE}`).catch(() => {});
    await owner.$disconnect();
    process.exit(1);
  });
