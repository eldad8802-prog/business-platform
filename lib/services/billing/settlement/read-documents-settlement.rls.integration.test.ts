/**
 * readDocumentsSettlement — read-only settlement facts, AS a NOSUPERUSER NOBYPASSRLS runtime with every repository
 * RLS statement replayed (same lab shape as billing-issue-allocation-gate.rls.integration.test.ts).
 *
 *   S1  shared rule: invoice outstanding = total − ISSUED receipt allocations − ISSUED credits (floored at 0)
 *   S2  one receipt covering invoices of two different service cases: each case gets only its own invoices' part
 *   S3  no double count: a receipt reached through its invoice AND directly is one set of allocation pairs
 *   S4  partial payment: the remainder stays outstanding
 *   S5  a standalone receipt (exempt dealer, no invoice): STANDALONE, attributed to no invoice
 *   S6  a verified overpayment: allocations + stated unapplied = total
 *   S7  a DRAFT receipt's allocation does not count
 *   S8  TAX_INVOICE_RECEIPT: self-settled
 *   S9  flags: draft / foreign currency / quote / unknown id — every requested id comes back
 *   S10 business separation: another business's documents are NOT_FOUND, and its allocations never leak in
 *   S11 read-only: no row changes
 *
 * Synthetic data only. No secrets, no network.
 * Run: npx tsx lib/services/billing/settlement/read-documents-settlement.rls.integration.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
globalThis.fetch = (async () => { throw new Error("network disabled in this test"); }) as typeof fetch;

async function replayRepositoryRls(): Promise<number> {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) { console.log("  [FAIL] RLS_ADMIN_URL is not set"); process.exit(1); }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let applied = 0;
  try {
    for (const r of ["app_admin", "app_auth", "app_ctlplane", "app_runtime"]) {
      await admin.$executeRawUnsafe(`DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
        CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; END IF; END $do$`);
    }
    for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
      let sql: string;
      try { sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8"); } catch { continue; }
      for (const st of sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean)) {
        if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
        try { await admin.$executeRawUnsafe(st); applied++; } catch { /* already present */ }
      }
    }
  } finally { await admin.$disconnect(); }
  return applied;
}

async function main() {
  const { readDocumentsSettlement } = await import("@/lib/services/billing/settlement/read-documents-settlement");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

  const [who] = (await prisma.$queryRawUnsafe(`SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)) as
    Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) { console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything"); process.exit(1); }
  ok(`replayed RLS/role statements from the repository`, (await replayRepositoryRls()) > 50);

  const owner = new PrismaClient({ datasourceUrl: process.env.RLS_ADMIN_URL });
  await owner.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Business"','id'), GREATEST(1000, (SELECT COALESCE(MAX(id),0) FROM "Business")))`);
  const A = await owner.business.create({ data: { name: `settle-a-${uniq()}` } });
  const B = await owner.business.create({ data: { name: `settle-b-${uniq()}` } });
  const now = new Date();
  const doc = (businessId: number, documentType: BillingDocumentType, total: string, over: Record<string, unknown> = {}) =>
    owner.billingDocument.create({ data: {
      businessId, documentType, status: BillingDocumentStatus.ISSUED, customerNameSnapshot: "לקוח", currency: "ILS",
      subtotalAmount: total, vatAmount: "0", totalAmount: total, issuedAt: now, ...over,
    } as never });
  const alloc = (businessId: number, receiptDocumentId: number, invoiceDocumentId: number, amount: string) =>
    owner.billingPaymentAllocation.create({ data: { businessId, receiptDocumentId, invoiceDocumentId, allocatedAmount: amount, currency: "ILS" } });
  // The fiscal-immutability trigger refuses allocations on an ISSUED receipt — the real order: draft, allocate, issue.
  const receipt = async (businessId: number, total: string, allocations: [number, string][], over: Record<string, unknown> = {}, issue = true) => {
    const r = await doc(businessId, "RECEIPT", total, { status: BillingDocumentStatus.DRAFT, issuedAt: null, ...over });
    for (const [invoiceId, amount] of allocations) await alloc(businessId, r.id, invoiceId, amount);
    if (issue) await owner.billingDocument.update({ where: { id: r.id }, data: { status: BillingDocumentStatus.ISSUED, issuedAt: now } });
    return r;
  };

  // Business A
  const I1 = await doc(A.id, "TAX_INVOICE", "1000.00");       // case X
  const I2 = await doc(A.id, "TAX_INVOICE", "500.00");        // case Y
  const I3 = await doc(A.id, "TAX_INVOICE", "300.10");        // partial payment
  const R1 = await receipt(A.id, "1200.00", [[I1.id, "1000.00"], [I2.id, "200.00"]]); // covers I1 (case X) AND I2 (case Y)
  const C1 = await doc(A.id, "CREDIT_NOTE", "100.00", { referenceDocumentId: I2.id });
  const R2 = await receipt(A.id, "100.00", [[I3.id, "100.00"]]);                       // partial on I3
  const R4 = await receipt(A.id, "150.00", [[I3.id, "100.00"]], { unappliedAmount: "50.00" }); // verified overpayment
  const R3 = await receipt(A.id, "300.10", [[I3.id, "100.10"]], {}, false);            // draft: must not count
  const S1 = await receipt(A.id, "400.00", []);                                        // standalone (exempt-style)
  const T1 = await doc(A.id, "TAX_INVOICE_RECEIPT", "118.00");
  const D1 = await doc(A.id, "TAX_INVOICE", "50.00", { status: BillingDocumentStatus.DRAFT, issuedAt: null });
  const U1 = await doc(A.id, "TAX_INVOICE", "70.00", { currency: "USD" });
  const Q1 = await doc(A.id, "QUOTE", "90.00", { status: BillingDocumentStatus.DRAFT, issuedAt: null });
  // Business B
  const IB = await doc(B.id, "TAX_INVOICE", "800.00");
  const RB = await receipt(B.id, "800.00", [[IB.id, "800.00"]]);

  const counts = async () => JSON.stringify(await owner.$queryRawUnsafe(`SELECT
    (SELECT count(*)::int FROM "BillingDocument" WHERE "businessId" IN (${A.id}, ${B.id})) d,
    (SELECT count(*)::int FROM "BillingPaymentAllocation" WHERE "businessId" IN (${A.id}, ${B.id})) a,
    (SELECT max("updatedAt") FROM "BillingDocument" WHERE "businessId" IN (${A.id}, ${B.id})) u`));
  const before = await counts();

  const all = [I1, I2, I3, R1, C1, R2, R4, R3, S1, T1, D1, U1, Q1].map((d) => d.id);
  const read = await tenantTx(A.id, (tx) => readDocumentsSettlement(tx, A.id, [...all, IB.id, 999999999]));
  const inv = (id: number) => read.invoices.find((i) => i.id === id)!;
  const rcp = (id: number) => read.receipts.find((r) => r.id === id)!;
  const flag = (id: number) => read.documents.find((d) => d.id === id)?.flag;

  // S1 shared rule
  ok("S1 I1 1000 − R1 1000 = 0 outstanding", inv(I1.id).outstandingAgorot === 0 && inv(I1.id).allocatedAgorot === 100000, JSON.stringify(inv(I1.id)));
  ok("S1 I2 500 − R1 200 − credit 100 = 200 outstanding", inv(I2.id).outstandingAgorot === 20000 && inv(I2.id).creditedAgorot === 10000, JSON.stringify(inv(I2.id)));

  // S2 one receipt, two cases: each case takes only the allocations to ITS invoices
  const caseX = new Set([I1.id, R1.id]);  // the service side linked I1 and R1 to case X
  const caseY = new Set([I2.id]);
  const paidInto = (ids: Set<number>) => read.allocations.filter((a) => ids.has(a.invoiceDocumentId)).reduce((s, a) => s + a.amountAgorot, 0);
  ok("S2 R1 covers both cases: case X receives 1000 (I1), case Y receives 200 (I2) — not 1200 each",
    paidInto(caseX) === 100000 && paidInto(caseY) === 20000, JSON.stringify(read.allocations.filter((a) => a.receiptDocumentId === R1.id)));
  ok("S2 R1 reports both pairs once, total allocated 1200 = its total, nothing unattributed",
    rcp(R1.id).allocatedAgorot === 120000 && rcp(R1.id).notAttributedToAnyInvoiceAgorot === 0 && rcp(R1.id).kind === "ALLOCATED");

  // S3 no double count: R1 is requested AND reached through I1/I2 — still one allocation row per pair
  const r1pairs = read.allocations.filter((a) => a.receiptDocumentId === R1.id);
  ok("S3 R1 → I1 and R1 → I2 appear exactly once each", r1pairs.length === 2 && r1pairs.every((a) => a.bothRequested));
  ok("S3 case X balance from the read (outstanding of its invoices) = 0, never 'receipt total + allocation'",
    [...caseX].filter((id) => read.invoices.some((i) => i.id === id)).reduce((s, id) => s + inv(id).outstandingAgorot, 0) === 0);

  // S4 partial payment
  ok("S4 I3 300.10 − R2 100 − R4 100 = 100.10 outstanding (agorot exact)", inv(I3.id).outstandingAgorot === 10010, JSON.stringify(inv(I3.id)));

  // S5 standalone receipt
  ok("S5 S1 is STANDALONE: no allocation, unapplied 0, all 400 attributed to no invoice",
    rcp(S1.id).kind === "STANDALONE" && rcp(S1.id).allocatedAgorot === 0 && rcp(S1.id).unappliedAgorot === 0 && rcp(S1.id).notAttributedToAnyInvoiceAgorot === 40000,
    JSON.stringify(rcp(S1.id)));
  ok("S5 S1 has no allocation rows at all (nothing to credit to any invoice or case by billing data)",
    read.allocations.every((a) => a.receiptDocumentId !== S1.id));

  // S6 verified overpayment
  ok("S6 R4: 100 allocated + 50 stated unapplied = 150; 50 attributed to no invoice",
    rcp(R4.id).kind === "ALLOCATED_WITH_UNAPPLIED" && rcp(R4.id).unappliedAgorot === 5000 && rcp(R4.id).notAttributedToAnyInvoiceAgorot === 5000, JSON.stringify(rcp(R4.id)));

  // S7 draft receipt
  ok("S7 the DRAFT receipt R3 is flagged NOT_ISSUED and its allocation to I3 is not counted",
    flag(R3.id) === "NOT_ISSUED" && read.allocations.every((a) => a.receiptDocumentId !== R3.id) && !read.receipts.some((r) => r.id === R3.id));

  // S8 TAX_INVOICE_RECEIPT
  ok("S8 T1 is SELF_SETTLED (charge and payment in one document)", rcp(T1.id)?.kind === "SELF_SETTLED" && rcp(T1.id).totalAgorot === 11800);

  // S9 flags; every requested id comes back
  ok("S9 every requested id comes back once", read.documents.length === all.length + 2 && new Set(read.documents.map((d) => d.id)).size === all.length + 2);
  ok("S9 draft invoice → NOT_ISSUED, USD invoice → NOT_ILS, quote → NOT_A_SETTLEMENT_DOCUMENT, unknown id → NOT_FOUND",
    flag(D1.id) === "NOT_ISSUED" && flag(U1.id) === "NOT_ILS" && flag(Q1.id) === "NOT_A_SETTLEMENT_DOCUMENT" && flag(999999999) === "NOT_FOUND",
    JSON.stringify(read.documents.filter((d) => d.flag)));
  ok("S9 flagged documents are not netted (no invoice entry for the draft or the USD invoice)",
    !read.invoices.some((i) => i.id === D1.id || i.id === U1.id));

  // S10 business separation
  ok("S10 business B's invoice requested from business A → NOT_FOUND, nothing of it returned",
    flag(IB.id) === "NOT_FOUND" && !read.invoices.some((i) => i.id === IB.id) && read.allocations.every((a) => a.invoiceDocumentId !== IB.id && a.receiptDocumentId !== RB.id));
  const fromB = await tenantTx(B.id, (tx) => readDocumentsSettlement(tx, B.id, [I1.id, R1.id, IB.id]));
  ok("S10 from business B, A's documents are NOT_FOUND and B's invoice is fully paid",
    fromB.documents.filter((d) => d.id !== IB.id).every((d) => d.flag === "NOT_FOUND") && fromB.invoices.length === 1 && fromB.invoices[0].outstandingAgorot === 0);
  const crossed = await tenantTx(A.id, (tx) => readDocumentsSettlement(tx, B.id, [IB.id])).then((r) => r.documents[0]?.flag, (e) => `ERR ${(e as Error).message}`);
  ok("S10 asking for business B inside business A's tenant transaction returns nothing of B (RLS)", crossed === "NOT_FOUND", String(crossed));

  // S11 read-only
  ok("S11 read-only: document / allocation counts and timestamps unchanged", (await counts()) === before);

  console.log(`${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await prisma.$disconnect();
  if (failures.length) process.exit(1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
