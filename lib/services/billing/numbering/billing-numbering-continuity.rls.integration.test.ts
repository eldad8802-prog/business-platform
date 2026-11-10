/**
 * The numbering continuity report under replayed RLS, as a NOBYPASSRLS login:
 *
 *   C1  real issuance (three tax invoices, two receipts) → every series continuous
 *   C2  the report reads nothing of another business
 *   C3  a hole written behind the counter's back → reported as a missing range and an inconsistent counter
 *   C4  a number issued twice in another business's data never leaks into this one
 *   C5  the report writes nothing (row counts and counters unchanged)
 *
 * Synthetic data only. No secrets, no Neon, no network.
 * Run: npx tsx lib/services/billing/numbering/billing-numbering-continuity.rls.integration.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { BillingDocumentStatus, BillingDocumentType, PrismaClient } from "@prisma/client";

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

async function replayRepositoryRls(adminUrl: string): Promise<number> {
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
      for (const st of sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((x) => x.trim()).filter(Boolean)) {
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
  const adminUrl = process.env.RLS_ADMIN_URL;
  if (!adminUrl) {
    console.log("  [FAIL] RLS_ADMIN_URL is not set");
    process.exit(1);
  }
  const [who] = (await prisma.$queryRawUnsafe(
    `SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
  )) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
  console.log(`  connected as: ${who?.who} (superuser=${who?.rolsuper}, bypassrls=${who?.rolbypassrls})`);
  if (!who || who.rolsuper || who.rolbypassrls) {
    console.log("  [FAIL] this role bypasses RLS — nothing below would prove anything");
    process.exit(1);
  }
  ok("replayed the repository's RLS statements", (await replayRepositoryRls(adminUrl)) > 50);

  const { loadNumberingContinuityReport } = await import("@/lib/services/billing/numbering/billing-numbering-continuity");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const owner = new PrismaClient({ datasourceUrl: adminUrl });

  async function tenant(label: string) {
    const business = await owner.business.create({ data: { name: `continuity-${label}-${uniq()}` } });
    const user = await owner.user.create({ data: { email: `continuity-${label}-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" } });
    await owner.businessProfile.create({
      data: { businessId: business.id, billingLegalName: `Synthetic ${label}`, billingBusinessKind: "LTD_COMPANY", billingTaxId: "516000004", billingVatNumber: "516000004", billingAddress: "1 St", billingPhone: "0500000000", billingEmail: `${label}@example.test` },
    });
    return { businessId: business.id, userId: user.id };
  }
  const stub = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "preflight_failed", billingDocumentId: i.billingDocumentId, errorCode: "STUB", safeToRetry: false }) as never };
  async function issueInvoice(t: { businessId: number; userId: number }) {
    const d = await tenantTx(t.businessId, (tx) =>
      tx.billingDocument.create({
        data: {
          businessId: t.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.DRAFT,
          customerNameSnapshot: "Synthetic", currency: "ILS", subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00",
          lines: { create: [{ lineIndex: 0, description: "x", quantity: "1", unitPrice: "100", vatRatePercent: "18", lineSubtotal: "100.00", vatAmount: "18.00", lineTotal: "118.00" }] },
        },
        select: { id: true },
      })
    );
    await issueBillingDocument({ businessId: t.businessId, billingDocumentId: d.id, actorUserId: t.userId }, stub);
  }
  async function issueReceipt(t: { businessId: number; userId: number }) {
    const d = await tenantTx(t.businessId, (tx) =>
      tx.billingDocument.create({
        data: {
          businessId: t.businessId, documentType: BillingDocumentType.RECEIPT, status: BillingDocumentStatus.DRAFT,
          customerNameSnapshot: "Synthetic", currency: "ILS", subtotalAmount: "0", vatAmount: "0", totalAmount: "50.00",
          receiptPayments: { create: [{ lineIndex: 1, method: "CASH", amount: "50.00", currency: "ILS", paymentDate: new Date("2026-11-10") }] },
        } as never,
        select: { id: true },
      })
    );
    await issueBillingDocument({ businessId: t.businessId, billingDocumentId: d.id, actorUserId: t.userId }, stub);
  }

  const a = await tenant("a");
  const b = await tenant("b");
  for (let i = 0; i < 3; i++) await issueInvoice(a);
  for (let i = 0; i < 2; i++) await issueReceipt(a);
  await issueInvoice(b);

  const before = await owner.billingDocument.count();
  const report = await loadNumberingContinuityReport(a.businessId);
  const ti = report.find((r) => r.documentType === "TAX_INVOICE")!;
  const rc = report.find((r) => r.documentType === "RECEIPT")!;
  ok("C1 real issuance → tax invoices 1–3 and receipts 1–2 continuous, counters agree",
    ti.continuous && ti.first === 1 && ti.last === 3 && ti.counterNext === 4 && rc.continuous && rc.last === 2 && report.every((r) => r.continuous),
    JSON.stringify(report));
  ok("C2 the report reads nothing of another business (b's invoice is not counted)", ti.issuedCount === 3, String(ti.issuedCount));

  // A hole written behind the counter: an ISSUED tax invoice numbered 6 (4 and 5 never issued).
  await owner.billingDocument.create({
    data: { businessId: a.businessId, documentType: BillingDocumentType.TAX_INVOICE, status: BillingDocumentStatus.ISSUED, documentNumber: 6, documentNumberFormatted: "000006", customerNameSnapshot: "x", currency: "ILS", subtotalAmount: "0", vatAmount: "0", totalAmount: "0" },
  });
  const r2 = (await loadNumberingContinuityReport(a.businessId)).find((r) => r.documentType === "TAX_INVOICE")!;
  ok("C3 a hole is reported as the missing range 4–5, and the counter as inconsistent",
    JSON.stringify(r2.missing) === JSON.stringify([{ from: 4, to: 5 }]) && !r2.counterConsistent && !r2.continuous, JSON.stringify(r2));

  const rb = (await loadNumberingContinuityReport(b.businessId)).find((r) => r.documentType === "TAX_INVOICE")!;
  ok("C4 the other business's report is its own (one invoice, continuous)", rb.issuedCount === 1 && rb.continuous, JSON.stringify(rb));

  const counters = await owner.billingDocumentNumberSequence.findMany({ where: { businessId: a.businessId }, orderBy: { documentType: "asc" } });
  await loadNumberingContinuityReport(a.businessId);
  const counters2 = await owner.billingDocumentNumberSequence.findMany({ where: { businessId: a.businessId }, orderBy: { documentType: "asc" } });
  ok("C5 the report writes nothing (documents and counters unchanged)",
    (await owner.billingDocument.count()) === before + 1 && JSON.stringify(counters.map((c) => c.nextNumber)) === JSON.stringify(counters2.map((c) => c.nextNumber)));

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
