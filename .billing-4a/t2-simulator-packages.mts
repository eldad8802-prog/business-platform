/**
 * 4a T2 — the three simulator packages at the volume the ITA simulator requires (≥ 2,000 records per uploaded
 * BKMVDATA.TXT; docs/compliance/tax-authority/uniform-export-certification.md), built by the EXISTING export code
 * (loader → assembler → builder, unchanged) from documents issued through the application on the lab database
 * (Production role topology). Synthetic only. Nothing is uploaded from here.
 *
 *   PRE       before the transition: receipts of an exempt dealer (C100 400 + D120)
 *   POST      after the transition: tax invoices (305), tax invoice/receipts (320), credit notes (330), receipts (400)
 *   STRADDLE  one range across the transition (owner D1): every document of PRE + POST, each with its own VAT
 * Software identity = SIMULATOR_SOFTWARE_CONFIG (registration 00000001), as in the S1 runs.
 *
 *   OWNER_URL=… DATABASE_URL=… T2_OUT=<dir> npx tsx .billing-4a/t2-simulator-packages.mts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BillingDocumentType, CustomerTaxIdType, PrismaClient } from "@prisma/client";

process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT = "PRODUCTION";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_BUSINESS_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_USER_IDS = "9";
process.env.BILLING_AUTHORITY_PRODUCTION_PILOT_OPERATIONS = "oauth";
globalThis.fetch = (async () => { throw new Error("network disabled in this lab"); }) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
type Rows = Record<string, unknown>[];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
async function pool<T>(items: T[], width: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

async function main() {
  const out = process.env.T2_OUT!;
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
  const { createBillingDraft } = await import("@/lib/services/billing/billing-draft.service");
  const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
  const { createBillingCreditNoteDraft } = await import("@/lib/services/billing/billing-credit-reversal.service");
  const { loadUniformExportInput } = await import("@/lib/services/billing/uniform/uniform-export-loader");
  const { assembleUniformExportProjection } = await import("@/lib/services/billing/uniform/uniform-export-assembler");
  const { buildUniformExportFiles } = await import("@/lib/services/billing/uniform/uniform-file-builder");
  const { writeUniformExport } = await import("@/lib/services/billing/uniform/uniform-packaging");
  const { SIMULATOR_SOFTWARE_CONFIG } = await import("@/lib/services/billing/uniform/uniform-config");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { withTenantTransaction } = await import("@/lib/tenant/transaction");
  const { replayRepositoryRls } = await import("../.tax-classification-lab/lab-kit.mts");
  await replayRepositoryRls(process.env.OWNER_URL!);

  const TAX = withCheckDigit("30000000");
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t2-sim-${Date.now()}`)) as Rows;
  const businessId = Number(b[0].id);
  const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`, `t2-sim-${Date.now()}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
  const userId = Number(u[0].id);
  await owner.$queryRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
     VALUES ($1,'EXEMPT_DEALER','דנה כהן',$2,NULL,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`, businessId, TAX);
  const customers: number[] = [];
  for (let i = 0; i < 40; i++) customers.push((await owner.customer.create({ data: { businessId, name: `לקוח ${i + 1}`, ...(i % 4 === 0 ? { taxId: withCheckDigit(String(51000000 + i)), taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER } : {}) } })).id);
  const deps = { executeApproval: async (x: { billingDocumentId: number }) => ({ outcome: "completed_approved", billingDocumentId: x.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) } as never;
  const issue = (id: number) => issueBillingDocument({ businessId, billingDocumentId: id, actorUserId: userId }, deps);
  const cust = (i: number) => customers[i % customers.length];

  // ---------------- PRE: 720 receipts, two payment lines each (C100 + 2 × D120 = 3 records)
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const pre = Array.from({ length: 720 }, (_, i) => i);
  await pool(pre, 4, async (i) => {
    const d = await createReceiptDraft({ businessId, actorUserId: userId, documentType: BillingDocumentType.RECEIPT, customerId: cust(i), currency: "ILS",
      paymentLines: [{ method: "CASH", amount: `${50 + (i % 37)}.00`, paymentDate: new Date().toISOString() }, { method: "BANK_TRANSFER", amount: `${20 + (i % 11)}.50`, paymentDate: new Date().toISOString(), bankName: "בנק לאומי", bankBranch: "800", bankAccountNumber: "123456" }] } as never);
    await issue(d.id);
  });
  await sleep(1100);
  const tPreEnd = new Date().toISOString();
  await sleep(1100);

  // ---------------- the transition
  const date = israelToday();
  const st = kindTransitionStatementSha256({ businessId, actorUserId: userId, legalName: "דנה כהן", taxId: TAX, vatNumber: TAX, statusEffectiveDate: date });
  const tr = await performKindTransition(businessId, userId, { vatNumber: TAX, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: st });
  if (tr !== "TRANSITIONED") throw new Error(`transition: ${tr}`);
  const confirmedAt = new Date(((await owner.$queryRawUnsafe(`SELECT "confirmedAt" c FROM "BusinessKindTransition" WHERE "businessId"=$1`, businessId)) as Rows)[0].c as Date).toISOString();
  await sleep(1100);

  // ---------------- POST: 420 tax invoices (3 lines: 18, 18, 0) → 4 records; 60 tax invoice/receipts; 40 credit notes; 120 receipts
  const LINES = (i: number) => [
    { description: `שירות ${i}`, quantity: "1", unitPrice: `${200 + (i % 50)}`, vatRatePercent: "18" },
    { description: "חומרים", quantity: `${1 + (i % 3)}`, unitPrice: "35.5", vatRatePercent: "18" },
    { description: "שירות ללקוח בחו״ל", quantity: "1", unitPrice: "120", vatRatePercent: "0" },
  ];
  const invoices: number[] = [];
  await pool(Array.from({ length: 420 }, (_, i) => i), 4, async (i) => {
    const d = await createBillingDraft({ businessId, actorUserId: userId, documentType: BillingDocumentType.TAX_INVOICE, customerId: cust(i), initialLines: LINES(i) });
    await issue(d.id); invoices.push(d.id);
  });
  await pool(Array.from({ length: 60 }, (_, i) => i), 4, async (i) => {
    const d = await createBillingDraft({ businessId, actorUserId: userId, documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, customerId: cust(i), initialLines: LINES(i).slice(0, 2) });
    try { await issue(d.id); } catch (e) { console.log("TIR not issued (shape):", String((e as Error).message).slice(0, 120)); }
  });
  for (const src of invoices.slice(0, 40)) {
    const c = await createBillingCreditNoteDraft({ businessId, actorUserId: userId, sourceBillingDocumentId: src } as never);
    await issue(c.id);
  }
  await pool(Array.from({ length: 120 }, (_, i) => i), 4, async (i) => {
    const d = await createReceiptDraft({ businessId, actorUserId: userId, documentType: BillingDocumentType.RECEIPT, customerId: cust(i), currency: "ILS",
      paymentLines: [{ method: "CASH", amount: `${70 + (i % 13)}.00`, paymentDate: new Date().toISOString() }] } as never);
    await issue(d.id);
  });
  await sleep(1100);
  const tEnd = new Date().toISOString();

  const GENERATED_AT = new Date().toISOString();
  const sums: string[] = [];
  const summary: Record<string, unknown> = {};
  for (const [name, [s, e]] of Object.entries({ PRE: [t0, tPreEnd], POST: [confirmedAt, tEnd], STRADDLE: [t0, tEnd] } as Record<string, [string, string]>)) {
    const input = await runWithTenantContext({ businessId }, () => withTenantTransaction((tx) => loadUniformExportInput({ businessId, periodStart: s, periodEnd: e, client: tx as never })));
    const proj = assembleUniformExportProjection(input);
    const built = buildUniformExportFiles(proj, SIMULATOR_SOFTWARE_CONFIG, { primaryId: "202611240000002", generatedAt: GENERATED_AT });
    const w = await writeUniformExport(join(out, name), built);
    for (const f of [w.iniPath, w.bkmvdataTxtPath]) sums.push(`${sha(readFileSync(f))}  ${relative(out, f).replace(/\\/g, "/")}`);
    const types = [...new Set(built.bkmvdataText.split("\r\n").filter((r) => r.startsWith("C100")).map((r) => [...r].slice(22, 25).join("")))].sort();
    summary[name] = { range: [s, e], records: built.meta.totalBkmvRecords, counts: built.meta.counts, c100Types: types, dir: relative(out, w.outputDir).replace(/\\/g, "/") };
  }
  writeFileSync(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
  writeFileSync(join(out, "SUMMARY.json"), JSON.stringify({ taxId: TAX, confirmedAt, generatedAt: GENERATED_AT, packages: summary }, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  await owner.$disconnect();
}
main().catch(async (e) => { console.error(e); process.exitCode = 1; await owner.$disconnect(); });
