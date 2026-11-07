/**
 * Issuance: an EXEMPT_DEALER cannot issue a tax invoice or a tax invoice/receipt —
 * under the Production RLS posture, with no partial write and no number taken.
 *
 * WHY THIS EXISTS
 *
 * Issuance only checked that the identity profile was complete; the
 * authority-readiness rule never looks at the issuer's kind. So a business
 * classified עוסק פטור could issue a VAT tax invoice, and once submissions open
 * such an invoice (≥ threshold, to a licensed-dealer customer) would be sent to
 * the Tax Authority with the exempt dealer's number as the seller. The refusal
 * now sits in issueBillingDocumentTx — the one function every issuance path
 * (the owner's route, payment settlement) goes through — before the number
 * sequence and before any write.
 *
 * Posture (same rules as every RLS proof in this repository):
 *   1. POLICIES: every RLS / policy statement the migrations ship is replayed.
 *   2. IDENTITY: asserted NOSUPERUSER / NOBYPASSRLS.
 *   3. AMBIENT CONTEXT: issuance is called with NO tenant context.
 * The post-commit Approval is a local stub (no authority call, no network).
 * Synthetic data only.
 *
 * Run: npx tsx lib/services/billing/billing-issue-exempt-dealer.rls.integration.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import {
  BillingDocumentStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  PrismaClient,
} from "@prisma/client";

const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${name}`);
  } else {
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
}
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
globalThis.fetch = (async () => {
  throw new Error("network disabled in this test");
}) as typeof fetch;

/** Replays every RLS / policy / role statement the repository's migrations ship. */
async function replayRepositoryRls(): Promise<number> {
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set — cannot install the policies under test");
    process.exit(1);
  }
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  let applied = 0;
  try {
    for (const r of ["app_admin", "app_auth", "app_ctlplane", "app_runtime"]) {
      await admin.$executeRawUnsafe(
        `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN
           CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
         END IF; END $do$`
      );
    }
    for (const d of readdirSync("prisma/migrations").filter((x) => /^\d/.test(x)).sort()) {
      let sql: string;
      try {
        sql = readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8");
      } catch {
        continue;
      }
      for (const st of sql
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)) {
        if (!/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|CREATE ROLE|DO \$\$/i.test(st)) continue;
        try {
          await admin.$executeRawUnsafe(st);
          applied++;
        } catch {
          /* already present */
        }
      }
    }
  } finally {
    await admin.$disconnect();
  }
  return applied;
}

async function main() {
  const { getTenantContext } = await import("@/lib/tenant/context");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
  const { setReceiptAllocations } = await import("@/lib/services/billing/receipt/billing-payment-allocation.service");
  const { EXEMPT_DEALER_TAX_INVOICE_MESSAGE } = await import("@/lib/billing/business-identity");

  // ------------------------------------------------------------ identity ---
  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  const applied = await replayRepositoryRls();
  ok(`replayed ${applied} RLS/role statements from the repository`, applied > 50);
  ok("no ambient tenant context, as in a real request", getTenantContext() === undefined);

  // -------------------------------------------------------------- fixtures ---
  // Business / User rows are fixtures, created by the owner: under the replayed
  // B4 policies only app_auth may insert a Business (signup), not the runtime.
  const owner = new PrismaClient({ datasourceUrl: process.env.RLS_ADMIN_URL });
  async function tenant(label: string, kind: "EXEMPT_DEALER" | "LTD_COMPANY") {
    const business = await owner.business.create({ data: { name: `exempt-${label}-${uniq()}` } });
    const user = await owner.user.create({
      data: { email: `exempt-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" },
    });
    const customerId = await tenantTx(business.id, async (tx) => {
      await tx.businessProfile.create({
        data: {
          businessId: business.id,
          billingLegalName: `Synthetic ${label}`,
          billingBusinessKind: kind,
          billingTaxId: kind === "EXEMPT_DEALER" ? "000000018" : "515000123",
          billingAddress: "1 Synthetic St",
          billingPhone: "0500000000",
          billingEmail: `${label}@example.test`,
        },
      });
      const c = await tx.customer.create({
        data: {
          businessId: business.id,
          name: "Synthetic dealer customer",
          taxId: "515000131",
          taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER,
        },
        select: { id: true },
      });
      return c.id;
    });
    return { businessId: business.id, userId: user.id, customerId };
  }

  /** A draft that would be READY for a licensed issuer: VAT > 0, ≥ 5,000 ILS, dealer customer. */
  async function draft(t: { businessId: number; customerId: number }, documentType: BillingDocumentType) {
    return tenantTx(t.businessId, (tx) =>
      tx.billingDocument.create({
        data: {
          businessId: t.businessId,
          documentType,
          status: BillingDocumentStatus.DRAFT,
          customerId: t.customerId,
          customerNameSnapshot: "Synthetic dealer customer",
          currency: "ILS",
          subtotalAmount: "6000.00",
          vatAmount: "1080.00",
          totalAmount: "7080.00",
          lines: {
            create: [{
              lineIndex: 0, description: "Synthetic service", quantity: "1", unitPrice: "6000",
              vatRatePercent: "18", lineSubtotal: "6000.00", vatAmount: "1080.00", lineTotal: "7080.00",
            }],
          },
        },
        select: { id: true },
      })
    );
  }

  const e = await tenant("e", "EXEMPT_DEALER");
  const l = await tenant("l", "LTD_COMPANY");
  const eTi = await draft(e, BillingDocumentType.TAX_INVOICE);
  const eTir = await draft(e, BillingDocumentType.TAX_INVOICE_RECEIPT);
  const lTi = await draft(l, BillingDocumentType.TAX_INVOICE);

  // The post-commit Approval is a local stub: counts calls, never sends anything.
  const approvals: Array<{ businessId: number; billingDocumentId: number }> = [];
  const authorityDeps = {
    executeApproval: async (input: { businessId: number; billingDocumentId: number; actorUserId: number }) => {
      approvals.push({ businessId: input.businessId, billingDocumentId: input.billingDocumentId });
      return { outcome: "preflight_failed", billingDocumentId: input.billingDocumentId, errorCode: "STUB", safeToRetry: false } as never;
    },
  };

  // ------------------------------------------------------------ the posture ---
  const unscoped = await prisma.billingDocument.findMany({ where: { businessId: e.businessId } });
  ok("G1 an unscoped BillingDocument read returns nothing (RLS is in force)", unscoped.length === 0, `got ${unscoped.length}`);

  async function stateOf(businessId: number, id: number, type: BillingDocumentType) {
    return tenantTx(businessId, async (tx) => ({
      doc: await tx.billingDocument.findUnique({
        where: { id },
        select: { status: true, documentNumber: true, documentNumberFormatted: true, issuedSnapshot: true, lockedAt: true, legalSnapshotHash: true, issuedAt: true },
      }),
      sequence: await tx.billingDocumentNumberSequence.findUnique({
        where: { businessId_documentType: { businessId, documentType: type } },
        select: { nextNumber: true },
      }),
      submissions: await tx.billingAuthoritySubmission.count({ where: { billingDocumentId: id } }),
      financialEvents: await tx.financialEvent.count({ where: { businessId } }),
    }));
  }
  const untouched = (s: Awaited<ReturnType<typeof stateOf>>) =>
    s.doc?.status === BillingDocumentStatus.DRAFT && s.doc.documentNumber === null && s.doc.documentNumberFormatted === null &&
    s.doc.issuedSnapshot === null && s.doc.lockedAt === null && s.doc.legalSnapshotHash === null && s.doc.issuedAt === null &&
    s.sequence === null && s.submissions === 0 && s.financialEvents === 0;

  async function refused(t: { businessId: number; userId: number }, id: number): Promise<string> {
    try {
      await issueBillingDocument({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, authorityDeps as never);
      return "ISSUED";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  // ------------------------------------------- exempt dealer: refused (X) ---
  const x1 = await refused(e, eTi.id);
  ok("X1 exempt dealer: TAX_INVOICE refused with the exempt-dealer message", x1 === EXEMPT_DEALER_TAX_INVOICE_MESSAGE, x1);
  const s1 = await stateOf(e.businessId, eTi.id, BillingDocumentType.TAX_INVOICE);
  ok("X2 no partial write: still DRAFT, no number, no snapshot/lock/hash, no sequence row, no submission, no financial event",
    untouched(s1), JSON.stringify({ ...s1, doc: s1.doc && { ...s1.doc, issuedSnapshot: s1.doc.issuedSnapshot ? "<set>" : null } }));
  const x3 = await refused(e, eTir.id);
  ok("X3 exempt dealer: TAX_INVOICE_RECEIPT refused", x3 === EXEMPT_DEALER_TAX_INVOICE_MESSAGE, x3);
  ok("X4 TAX_INVOICE_RECEIPT: no partial write", untouched(await stateOf(e.businessId, eTir.id, BillingDocumentType.TAX_INVOICE_RECEIPT)));
  const x5 = await refused(e, eTi.id);
  ok("X5 a retry is refused the same way and still takes no number",
    x5 === EXEMPT_DEALER_TAX_INVOICE_MESSAGE && untouched(await stateOf(e.businessId, eTi.id, BillingDocumentType.TAX_INVOICE)));
  ok("X6 no Approval was attempted for a refused document", approvals.length === 0, `approvals=${approvals.length}`);

  // ----------------------------- exempt dealer: what fits it still issues (R) ---
  // A receipt must allocate to an issued invoice; a legacy ISSUED invoice (written
  // directly) stands in for one issued before this rule existed.
  const legacy = await tenantTx(e.businessId, (tx) =>
    tx.billingDocument.create({
      data: {
        businessId: e.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED,
        customerId: e.customerId, customerNameSnapshot: "Synthetic dealer customer", currency: "ILS",
        subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00",
        documentNumber: 1, documentNumberFormatted: "000001", issuedAt: new Date(), lockedAt: new Date(),
      },
      select: { id: true },
    })
  );
  const receipt = await createReceiptDraft({
    businessId: e.businessId,
    documentType: BillingDocumentType.RECEIPT,
    actorUserId: e.userId,
    customerId: e.customerId,
    currency: "ILS",
    paymentLines: [{ method: "CREDIT_CARD", amount: "118.00", paymentDate: new Date().toISOString(), cardBrand: "VISA", cardLast4: "4242" }],
  } as never);
  await setReceiptAllocations({
    businessId: e.businessId,
    receiptDocumentId: receipt.id,
    allocations: [{ invoiceDocumentId: legacy.id, allocatedAmount: "118.00" }],
  });
  const r1 = await refused(e, receipt.id);
  const rs = await stateOf(e.businessId, receipt.id, BillingDocumentType.RECEIPT);
  ok("R1 exempt dealer: a RECEIPT still issues (ISSUED, receipt number 1)",
    r1 === "ISSUED" && rs.doc?.status === BillingDocumentStatus.ISSUED && rs.doc.documentNumber === 1, `${r1} ${JSON.stringify(rs.doc?.status)}`);

  // ------------------------------------------ licensed issuer: unchanged (L) ---
  const l1 = await refused(l, lTi.id);
  const ls = await stateOf(l.businessId, lTi.id, BillingDocumentType.TAX_INVOICE);
  ok("L1 LTD_COMPANY: the same TAX_INVOICE issues (ISSUED, number 1, sequence → 2)",
    l1 === "ISSUED" && ls.doc?.documentNumber === 1 && ls.sequence?.nextNumber === 2, `${l1} ${JSON.stringify({ n: ls.doc?.documentNumber, seq: ls.sequence })}`);
  ok("L2 its READY submission exists and the (stubbed) Approval ran once, for that document only",
    ls.submissions === 1 && approvals.length === 1 && approvals[0].billingDocumentId === lTi.id && approvals[0].businessId === l.businessId,
    JSON.stringify(approvals));
  const l3 = await refused(l, lTi.id);
  ok("L3 re-issuing an issued document is refused; no second Approval", l3 !== "ISSUED" && approvals.length === 1, l3);

  // ------------------------------------------------------- isolation (T) ---
  const t1 = await refused(e, lTi.id);
  ok("T1 the exempt tenant cannot issue the other tenant's document", t1 !== "ISSUED", t1);
  const eSeq = await tenantTx(e.businessId, (tx) =>
    tx.billingDocumentNumberSequence.findUnique({ where: { businessId_documentType: { businessId: e.businessId, documentType: BillingDocumentType.TAX_INVOICE } } })
  );
  ok("T2 the licensed tenant's issuance did not create a TAX_INVOICE sequence for the exempt tenant", eSeq === null);
  ok("T3 no tenant context leaks out", getTenantContext() === undefined);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    console.log("EXEMPT DEALER ISSUANCE UNDER RLS: FAIL");
    process.exit(1);
  }
  console.log("EXEMPT DEALER ISSUANCE UNDER RLS: PASS");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
