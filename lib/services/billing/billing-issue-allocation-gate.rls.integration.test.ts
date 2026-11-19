/**
 * Issuance: an invoice that needs an allocation number is refused BEFORE numbering
 * while the Approval is known to be refused (Production pilot gate) — no number,
 * no ISSUED state, no submission, no audit event, nothing sent.
 *
 * Same lab shape as billing-issue-exempt-dealer.rls.integration.test.ts:
 *   1. every RLS / policy statement the migrations ship is replayed;
 *   2. the test runs as a NOSUPERUSER NOBYPASSRLS login and refuses otherwise;
 *   3. the post-commit Approval is a local stub that counts calls; global fetch throws.
 *
 *   G1  READY tax invoice, Production settings, business not in the pilot → 409, draft unnumbered
 *   G2  READY tax invoice/receipt → refused the same way
 *   G3  through the real route: 409 + code + the Hebrew explanation
 *   G4  private customer (no allocation needed) → issues as before
 *   G5  below the threshold → issues as before
 *   G6  receipt / credit note → never gated
 *   G7  SANDBOX environment → READY invoice issues and the Approval runs (unchanged)
 *   G8  approval opened for this business ("oauth,refresh,approval") → issues, Approval runs once
 *   G9  environment not configured → issues as before (out of this change's scope)
 *   G10 nothing sent from this process
 *
 * Synthetic data only. No secrets, no Neon, no network.
 * Run: npx tsx lib/services/billing/billing-issue-allocation-gate.rls.integration.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { BillingDocumentStatus, BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

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

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network disabled in this test");
}) as typeof fetch;

function productionSettings() {
  process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
}

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
  const { NextRequest } = await import("next/server");
  const { signAuthToken } = await import("@/lib/auth-token");
  const { POST: issueRoute } = await import("@/app/api/billing/documents/[id]/issue/route");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE, AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE } = await import(
    "@/lib/services/billing/authority/billing-authority-issue-gate"
  );
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");

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

  const owner = new PrismaClient({ datasourceUrl: process.env.RLS_ADMIN_URL });
  // Lab businesses never collide with the pilot business id 9.
  await owner.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"Business"','id'), GREATEST(1000, (SELECT COALESCE(MAX(id),0) FROM "Business")))`);

  const t = await (async () => {
    const business = await owner.business.create({ data: { name: `alloc-gate-${uniq()}` } });
    const user = await owner.user.create({ data: { email: `alloc-gate-${uniq()}@example.test`, password: "x", businessId: business.id, role: "USER" } });
    await owner.businessProfile.create({
      data: {
        businessId: business.id, billingLegalName: "חברה סינתטית בע\"מ", billingBusinessKind: "LTD_COMPANY",
        billingTaxId: "516000004", billingVatNumber: "516000004", billingAddress: "1 Synthetic St", billingPhone: "0500000000",
        billingEmail: "alloc-gate@example.test",
      },
    });
    const dealer = await owner.customer.create({ data: { businessId: business.id, name: "Synthetic dealer", taxId: "515000131", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } });
    const priv = await owner.customer.create({ data: { businessId: business.id, name: "Synthetic private" } });
    return { businessId: business.id, userId: user.id, token: signAuthToken(user.id, user.tokenVersion), dealerId: dealer.id, privateId: priv.id };
  })();
  ok("the lab business is not the pilot business", t.businessId >= 1000, String(t.businessId));

  async function draft(documentType: BillingDocumentType, customerId: number, unit: string, vatPct = "18") {
    const sub = Number(unit);
    const vat = (sub * Number(vatPct)) / 100;
    return tenantTx(t.businessId, (tx) =>
      tx.billingDocument.create({
        data: {
          businessId: t.businessId, documentType, status: BillingDocumentStatus.DRAFT, customerId,
          customerNameSnapshot: "Synthetic customer", currency: "ILS",
          subtotalAmount: sub.toFixed(2), vatAmount: vat.toFixed(2), totalAmount: (sub + vat).toFixed(2),
          lines: { create: [{ lineIndex: 0, description: "Synthetic", quantity: "1", unitPrice: unit, vatRatePercent: vatPct, lineSubtotal: sub.toFixed(2), vatAmount: vat.toFixed(2), lineTotal: (sub + vat).toFixed(2) }] },
        },
        select: { id: true },
      })
    );
  }
  const approvals: number[] = [];
  const stub = {
    executeApproval: async (i: { billingDocumentId: number }) => {
      approvals.push(i.billingDocumentId);
      return { outcome: "completed_approved", billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false } as never;
    },
  };
  const seq = async (type: BillingDocumentType) =>
    (await owner.billingDocumentNumberSequence.findUnique({ where: { businessId_documentType: { businessId: t.businessId, documentType: type } } }))?.nextNumber ?? null;
  async function state(id: number) {
    const d = await owner.billingDocument.findUniqueOrThrow({ where: { id }, select: { status: true, documentNumber: true, issuedSnapshot: true } });
    const sub = await owner.billingAuthoritySubmission.findUnique({ where: { billingDocumentId: id } });
    const audits = await owner.billingAuditEvent.count({ where: { billingDocumentId: id, eventType: "BILLING_DOC_ISSUED" } });
    return { status: d.status, number: d.documentNumber, snapshot: d.issuedSnapshot !== null, submission: sub?.status ?? null, audits };
  }
  async function refusal(id: number): Promise<{ code: string | null; message: string }> {
    try {
      await issueBillingDocument({ businessId: t.businessId, billingDocumentId: id, actorUserId: t.userId }, stub);
      return { code: null, message: "" };
    } catch (e) {
      return { code: (e as { code?: string }).code ?? null, message: (e as Error).message };
    }
  }

  // ---------------------------------------------------------------- blocked
  productionSettings();
  const g1 = await draft(BillingDocumentType.TAX_INVOICE, t.dealerId, "6000");
  const seqBefore = await seq(BillingDocumentType.TAX_INVOICE);
  const r1 = await refusal(g1.id);
  const s1 = await state(g1.id);
  ok("G1 READY tax invoice, non-pilot business, Production settings → refused with the gate code",
    r1.code === AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE && r1.message === AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE, JSON.stringify(r1));
  ok("G1 … the draft stays a draft: no number, no snapshot, no submission, no ISSUED audit event; sequence untouched",
    s1.status === "DRAFT" && s1.number === null && !s1.snapshot && s1.submission === null && s1.audits === 0 && (await seq(BillingDocumentType.TAX_INVOICE)) === seqBefore,
    JSON.stringify({ ...s1, seqBefore, seqAfter: await seq(BillingDocumentType.TAX_INVOICE) }));
  ok("G1 … no Approval attempted", !approvals.includes(g1.id));

  const g2 = await draft(BillingDocumentType.TAX_INVOICE_RECEIPT, t.dealerId, "6000");
  await tenantTx(t.businessId, (tx) =>
    tx.billingReceiptPayment.create({ data: { billingDocumentId: g2.id, lineIndex: 1, method: "CASH", amount: "7080.00", currency: "ILS", paymentDate: new Date("2026-11-10") } as never })
  ).catch(() => undefined);
  const r2 = await refusal(g2.id);
  ok("G2 READY tax invoice/receipt → refused the same way, stays DRAFT", r2.code === AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE && (await state(g2.id)).status === "DRAFT", JSON.stringify(r2));

  const res = await issueRoute(
    new NextRequest(`http://localhost/api/billing/documents/${g1.id}/issue`, { method: "POST", headers: { Authorization: `Bearer ${t.token}` } }),
    { params: Promise.resolve({ id: String(g1.id) }) }
  );
  const body = (await res.json()) as { error?: string; code?: string };
  ok("G3 the real route answers 409 with the code and the Hebrew explanation; still a draft",
    res.status === 409 && body.code === AUTHORITY_ALLOCATION_SENDING_CLOSED_CODE && body.error === AUTHORITY_ALLOCATION_SENDING_CLOSED_MESSAGE && (await state(g1.id)).status === "DRAFT",
    JSON.stringify({ status: res.status, body }));

  // ---------------------------------------------------------------- unchanged
  const g4 = await draft(BillingDocumentType.TAX_INVOICE, t.privateId, "6000");
  const r4 = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: g4.id, actorUserId: t.userId }, stub);
  ok("G4 private customer (no allocation needed) → issued, allocation not required", r4.document.status === "ISSUED" && r4.authority.status === "not_required", JSON.stringify(r4.authority));

  const g5 = await draft(BillingDocumentType.TAX_INVOICE, t.dealerId, "1000");
  const r5 = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: g5.id, actorUserId: t.userId }, stub);
  ok("G5 below the threshold → issued, allocation not required", r5.document.status === "ISSUED" && r5.authority.status === "not_required", JSON.stringify(r5.authority));

  const credit = await tenantTx(t.businessId, (tx) =>
    tx.billingDocument.create({
      data: {
        businessId: t.businessId, documentType: BillingDocumentType.CREDIT_NOTE, status: BillingDocumentStatus.DRAFT, customerId: t.privateId,
        customerNameSnapshot: "Synthetic customer", currency: "ILS", referenceDocumentId: g4.id, subtotalAmount: "6000.00", vatAmount: "1080.00", totalAmount: "7080.00",
        lines: { create: [{ lineIndex: 0, description: "Synthetic", quantity: "1", unitPrice: "6000", vatRatePercent: "18", lineSubtotal: "6000.00", vatAmount: "1080.00", lineTotal: "7080.00" }] },
      },
      select: { id: true },
    })
  );
  const r6 = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: credit.id, actorUserId: t.userId }, stub);
  ok("G6 a credit note of 6,000 ILS is never gated", r6.document.status === "ISSUED", r6.document.status);

  process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "SANDBOX";
  const g7 = await draft(BillingDocumentType.TAX_INVOICE, t.dealerId, "6000");
  const r7 = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: g7.id, actorUserId: t.userId }, stub);
  ok("G7 SANDBOX environment → READY invoice issued and the Approval runs (unchanged)", r7.document.status === "ISSUED" && approvals.includes(g7.id), JSON.stringify(r7.authority));

  productionSettings();
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = `9,${t.businessId}`;
  process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth,refresh,approval";
  const g8 = await draft(BillingDocumentType.TAX_INVOICE, t.dealerId, "6000");
  const before8 = approvals.length;
  const r8 = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: g8.id, actorUserId: t.userId }, stub);
  ok("G8 Approval opened for this business → issued and the Approval runs exactly once", r8.document.status === "ISSUED" && approvals.length === before8 + 1, JSON.stringify(r8.authority));

  delete process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT;
  const g9 = await draft(BillingDocumentType.TAX_INVOICE, t.dealerId, "6000");
  const r9 = await issueBillingDocument({ businessId: t.businessId, billingDocumentId: g9.id, actorUserId: t.userId }, stub);
  ok("G9 environment not configured → issued as before (not this change's scope)", r9.document.status === "ISSUED", r9.document.status);

  ok("G10 nothing sent from this process", fetchCalls === 0, String(fetchCalls));

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
