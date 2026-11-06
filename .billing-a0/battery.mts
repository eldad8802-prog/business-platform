/**
 * A0 — the EXISTING billing documents, issued end to end against a real,
 * isolated PostgreSQL (ephemeral postgres:17 in CI; any throwaway local cluster).
 *
 * Synthetic data only. No Production, no Neon, no secrets, no network: the tax
 * authority approval call is replaced by a local stub through the injection
 * point the issue service already exposes (IssueAuthorityDeps).
 *
 * What it pins (compared to baseline/db.json, recorded from unmodified code):
 *   - numbering: one sequence per document type, starting at 1, 6-digit
 *     formatting, interleaving types does not move another type's sequence,
 *     parallel issuance yields unique contiguous numbers;
 *   - the frozen snapshot of each type as written by real issuance, with the
 *     values that differ per run (row ids, issuedAt) replaced by placeholders,
 *     and legalSnapshotHash == hash(issuedSnapshot);
 *   - immutability: an issued document refuses edits and re-issue; a quote is
 *     never issued;
 *   - allocation: which documents get a READY submission, and that the
 *     approval executor is invoked exactly for those, never for others;
 *   - the מבנה אחיד loader over real rows: which documents it exports.
 *
 *   npx tsx .billing-a0/battery.mts            compare (CI)
 *   npx tsx .billing-a0/battery.mts --record   write baseline/db.json (deliberate,
 *                                              refused when code outside .billing-a0/ changed)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BillingAuthoritySubmissionStatus,
  BillingDocumentStatus,
  BillingDocumentType,
  CustomerTaxIdType,
  PrismaClient,
} from "@prisma/client";
import {
  hashIssuedSnapshot,
  issueBillingDocument,
  type IssueAuthorityDeps,
} from "../lib/services/billing/billing-issue.service";
import { createBillingDraft, replaceBillingDraftLines } from "../lib/services/billing/billing-draft.service";
import { createReceiptDraft } from "../lib/services/billing/receipt/billing-receipt-draft.service";
import { setReceiptAllocations } from "../lib/services/billing/receipt/billing-payment-allocation.service";
import { createBillingCreditNoteDraft } from "../lib/services/billing/billing-credit-reversal.service";
import { allocateQuoteDocumentNumberIfMissing } from "../lib/services/billing/quote-document-number";
import { convertQuoteToInvoice } from "../lib/services/billing/convert-quote-to-invoice.service";
import { billingTenantTx } from "../lib/services/billing/billing-tenant-tx";
import { loadUniformExportInput, type UniformExportReadClient } from "../lib/services/billing/uniform/uniform-export-loader";
import { assembleUniformExportProjection } from "../lib/services/billing/uniform/uniform-export-assembler";
import { buildUniformExportFiles } from "../lib/services/billing/uniform/uniform-file-builder";
import { DUBIZ_SOFTWARE_CONFIG } from "../lib/services/billing/uniform/uniform-config";
import { canonicalJson } from "./fixtures";

const RECORD = process.argv.includes("--record");
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const BASELINE = path.join(here, "baseline", "db.json");

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
async function refuses(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "it succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    ok(name, true, message);
  }
}

/** Observations compared to (or recorded into) baseline/db.json. */
const observed: Record<string, string> = {};
function observe(key: string, value: unknown) {
  observed[key] = typeof value === "string" ? value : canonicalJson(value);
}

// ---- the authority approval executor, replaced locally (no network) ----
const approvalCalls: { billingDocumentId: number }[] = [];
const stubAuthority: IssueAuthorityDeps = {
  executeApproval: async (input) => {
    approvalCalls.push({ billingDocumentId: input.billingDocumentId });
    return {
      outcome: "completed_approved",
      billingDocumentId: input.billingDocumentId,
      submissionId: -1,
      allocationNumber: "123456789",
      safeToRetry: false,
    };
  },
};

const LINES = [
  { description: "שירות ייעוץ חודשי", quantity: "2", unitPrice: "1500", vatRatePercent: "18" },
  { description: "חומרים ואביזרים", quantity: "3.5", unitPrice: "120.40", vatRatePercent: "18" },
];
const LARGE = [{ description: "פרויקט התקנה", quantity: "1", unitPrice: "12500", vatRatePercent: "18" }];

/** Replace the values that legitimately differ between runs with named placeholders. */
function normalizeSnapshot(snapshot: unknown, names: Map<number, string>, actorId: number, businessId: number, customerIds: Map<number, string>) {
  type Id = number | string | null;
  const s = JSON.parse(JSON.stringify(snapshot)) as {
    issuedAt: string;
    document: { id: Id; referenceDocumentId: Id };
    issuer?: { id: Id };
    customer?: { id: Id };
    metadata?: { actorUserId: Id };
  };
  s.issuedAt = "<ISSUED_AT>";
  s.document.id = names.get(Number(s.document.id)) ?? "<DOC:?>";
  if (s.document.referenceDocumentId != null) s.document.referenceDocumentId = names.get(Number(s.document.referenceDocumentId)) ?? "<DOC:?>";
  if (s.issuer && s.issuer.id === businessId) s.issuer.id = "<BUSINESS>";
  if (s.customer && s.customer.id != null) s.customer.id = customerIds.get(Number(s.customer.id)) ?? "<CUSTOMER:?>";
  if (s.metadata && s.metadata.actorUserId === actorId) s.metadata.actorUserId = "<ACTOR>";
  return s;
}

async function main() {
  const stamp = Date.now();
  const business = await prisma.business.create({ data: { name: "a0-" + stamp } });
  const actor = await prisma.user.create({
    data: { email: `a0-${stamp}@example.test`, password: "synthetic", businessId: business.id, role: "USER" },
  });
  await prisma.businessProfile.create({
    data: {
      businessId: business.id,
      billingLegalName: "עסק סינתטי לבדיקות בע\"מ",
      billingBusinessKind: "LTD_COMPANY",
      billingTaxId: "999999998",
      billingVatNumber: "999999998",
      billingAddress: "רחוב הבדיקה 1, תל אביב",
      billingPhone: "03-0000000",
      billingEmail: "a0@example.test",
      billingPaymentNote: "העברה בנקאית: בנק 99, סניף 999, חשבון 123456",
      billingFooterNote: "תודה רבה! מסמך לבדיקה בלבד.",
      billingPdfTemplateStyle: "CLASSIC",
    },
  });
  const dealer = await prisma.customer.create({
    data: { businessId: business.id, name: "לקוח מורשה בע\"מ", taxId: "000000018", taxIdType: CustomerTaxIdType.AUTHORIZED_DEALER, city: "חיפה" },
  });
  const privateCustomer = await prisma.customer.create({
    data: { businessId: business.id, name: "לקוח פרטי", city: "באר שבע" },
  });
  const b = business.id;
  const u = actor.id;
  const names = new Map<number, string>();
  const customerIds = new Map<number, string>([
    [dealer.id, "<CUSTOMER:dealer>"],
    [privateCustomer.id, "<CUSTOMER:private>"],
  ]);
  const issue = (id: number) => issueBillingDocument({ businessId: b, billingDocumentId: id, actorUserId: u }, stubAuthority);
  const read = (id: number) => prisma.billingDocument.findUniqueOrThrow({ where: { id } });

  console.log("--- issuance of each existing type ---");

  // TAX_INVOICE (small, private customer): NOT_REQUIRED for allocation.
  const inv1 = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: privateCustomer.id, initialLines: LINES });
  names.set(inv1.id, "<DOC:invoice-1>");
  const inv1Result = await issue(inv1.id);
  // TAX_INVOICE (large, licensed dealer): READY → the approval executor is called once.
  const inv2 = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: dealer.id, initialLines: LARGE });
  names.set(inv2.id, "<DOC:invoice-2-large>");
  const inv2Result = await issue(inv2.id);

  const tir = await createReceiptDraft({
    businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE_RECEIPT, customerId: privateCustomer.id, currency: "ILS",
    goodsLines: LINES,
    paymentLines: [{ method: "CREDIT_CARD", amount: "4037.25", paymentDate: "2026-07-15T09:00:00.000Z", cardBrand: "VISA", cardLast4: "4242" }],
  });
  names.set(tir.id, "<DOC:tax-invoice-receipt>");
  const tirResult = await issue(tir.id);

  const rcpt = await createReceiptDraft({
    businessId: b, actorUserId: u, documentType: BillingDocumentType.RECEIPT, customerId: privateCustomer.id, currency: "ILS",
    paymentLines: [{ method: "BANK_TRANSFER", amount: "1000.00", paymentDate: "2026-07-16T09:00:00.000Z", bankName: "99", bankBranch: "999", bankAccountNumber: "123456" }],
  });
  names.set(rcpt.id, "<DOC:receipt>");
  await setReceiptAllocations({ businessId: b, receiptDocumentId: rcpt.id, allocations: [{ invoiceDocumentId: inv1.id, allocatedAmount: "1000.00" }] });
  const rcptResult = await issue(rcpt.id);

  const cn = await createBillingCreditNoteDraft({ businessId: b, actorUserId: u, sourceBillingDocumentId: inv1.id });
  names.set(cn.id, "<DOC:credit-note>");
  // Partial credit: one line.
  await replaceBillingDraftLines({ businessId: b, actorUserId: u, billingDocumentId: cn.id, lines: [LINES[0]] });
  const cnResult = await issue(cn.id);

  const quote = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.QUOTE, customerId: dealer.id, initialLines: LINES });
  names.set(quote.id, "<DOC:quote>");
  const qn1 = await billingTenantTx(b, (tx) => allocateQuoteDocumentNumberIfMissing(tx, { businessId: b, billingDocumentId: quote.id }));
  const qn2 = await billingTenantTx(b, (tx) => allocateQuoteDocumentNumberIfMissing(tx, { businessId: b, billingDocumentId: quote.id }));
  await refuses("a QUOTE is never issued", () => issue(quote.id));
  const converted = await convertQuoteToInvoice({ businessId: b, actorUserId: u, quoteBillingDocumentId: quote.id });
  names.set(converted.id, "<DOC:invoice-from-quote>");
  const convResult = await issue(converted.id);

  for (const [label, r] of [
    ["TAX_INVOICE", inv1Result], ["TAX_INVOICE large", inv2Result], ["TAX_INVOICE_RECEIPT", tirResult],
    ["RECEIPT", rcptResult], ["CREDIT_NOTE", cnResult], ["TAX_INVOICE from quote", convResult],
  ] as const) {
    ok(`${label} reaches ISSUED`, r.document.status === BillingDocumentStatus.ISSUED, r.document.status);
  }

  console.log("--- numbering ---");
  const numbers = {
    TAX_INVOICE: [inv1Result, inv2Result, convResult].map((r) => [r.document.documentNumber, r.document.documentNumberFormatted]),
    TAX_INVOICE_RECEIPT: [[tirResult.document.documentNumber, tirResult.document.documentNumberFormatted]],
    RECEIPT: [[rcptResult.document.documentNumber, rcptResult.document.documentNumberFormatted]],
    CREDIT_NOTE: [[cnResult.document.documentNumber, cnResult.document.documentNumberFormatted]],
    QUOTE: [[qn1.documentNumber, qn1.documentNumberFormatted]],
  };
  observe("numbering.sequential", numbers);
  ok("quote number allocation is idempotent", qn1.documentNumber === qn2.documentNumber && qn1.documentNumberFormatted === qn2.documentNumberFormatted);

  // Parallel issuance of six invoices: unique, contiguous, no gaps.
  const drafts = await Promise.all(
    Array.from({ length: 6 }, () => createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: privateCustomer.id, initialLines: LINES }))
  );
  const settled = await Promise.allSettled(drafts.map((d) => issue(d.id)));
  const parallelNumbers = settled
    .filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof issue>>> => s.status === "fulfilled")
    .map((s) => s.value.document.documentNumber as number)
    .sort((x, y) => x - y);
  observe("numbering.parallel", { fulfilled: parallelNumbers.length, numbers: parallelNumbers });
  ok("parallel issuance: all six issued", parallelNumbers.length === 6, String(parallelNumbers.length));
  ok("parallel issuance: unique numbers", new Set(parallelNumbers).size === parallelNumbers.length);

  const sequences = await prisma.billingDocumentNumberSequence.findMany({ where: { businessId: b }, orderBy: { documentType: "asc" } });
  observe("numbering.sequenceRows", sequences.map((s) => [s.documentType, s.nextNumber]));

  console.log("--- frozen snapshots and hashes ---");
  for (const [key, id] of [
    ["TAX_INVOICE", inv1.id], ["TAX_INVOICE.large", inv2.id], ["TAX_INVOICE_RECEIPT", tir.id],
    ["RECEIPT", rcpt.id], ["CREDIT_NOTE", cn.id], ["TAX_INVOICE.fromQuote", converted.id],
  ] as const) {
    const row = await read(id);
    ok(`${key}: legalSnapshotHash == hash(issuedSnapshot)`, row.legalSnapshotHash === hashIssuedSnapshot(row.issuedSnapshot as Parameters<typeof hashIssuedSnapshot>[0]));
    ok(`${key}: lockedAt and issuedAt set`, row.lockedAt !== null && row.issuedAt !== null);
    observe(`snapshot.${key}`, normalizeSnapshot(row.issuedSnapshot, names, u, b, customerIds));
  }

  console.log("--- immutability ---");
  await refuses("an issued invoice refuses line edits", () =>
    replaceBillingDraftLines({ businessId: b, actorUserId: u, billingDocumentId: inv1.id, lines: LINES })
  );
  await refuses("an issued invoice refuses a second issue", () => issue(inv1.id));
  const inv1After = await read(inv1.id);
  ok("the refused attempts left the issued invoice untouched", inv1After.legalSnapshotHash === (await read(inv1.id)).legalSnapshotHash && inv1After.documentNumber === inv1Result.document.documentNumber);

  console.log("--- allocation (local stub, no network) ---");
  const submissions = await prisma.billingAuthoritySubmission.findMany({
    where: { billingDocumentId: { in: [...names.keys()] } },
    select: { billingDocumentId: true, status: true },
  });
  const byDoc = new Map(submissions.map((s) => [s.billingDocumentId, s.status]));
  observe(
    "authority.submissionStatusByDocument",
    [...names.entries()].map(([id, name]) => [name, byDoc.get(id) ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))
  );
  ok("large dealer invoice got a READY submission", byDoc.get(inv2.id) === BillingAuthoritySubmissionStatus.READY, String(byDoc.get(inv2.id)));
  observe("authority.approvalCalls", approvalCalls.map((c) => names.get(c.billingDocumentId) ?? "<parallel-invoice>"));
  ok("approval executor called exactly once, for the large dealer invoice only", approvalCalls.length === 1 && approvalCalls[0].billingDocumentId === inv2.id, JSON.stringify(approvalCalls));
  observe("authority.outcomes", [
    ["invoice-1", inv1Result.authority.status],
    ["invoice-2-large", inv2Result.authority.status],
    ["tax-invoice-receipt", tirResult.authority.status],
    ["receipt", rcptResult.authority.status],
    ["credit-note", cnResult.authority.status],
  ]);

  console.log("--- מבנה אחיד over the real rows ---");
  const input = await loadUniformExportInput({ businessId: b, periodStart: "2000-01-01T00:00:00.000Z", periodEnd: "2100-01-01T00:00:00.000Z", client: prisma as unknown as UniformExportReadClient });
  const proj = assembleUniformExportProjection(input);
  const exported = input.documents.map((d) => names.get(d.id) ?? `<parallel-invoice>`).sort();
  observe("uniform.loadedDocuments", exported);
  observe("uniform.excluded", proj.excluded.map((e) => [names.get(e.documentId) ?? "<?>", e.reason]));
  ok("the quote is not exported", !input.documents.some((d) => d.id === quote.id));
  const built = buildUniformExportFiles(proj, DUBIZ_SOFTWARE_CONFIG, { primaryId: "123456789012345", generatedAt: "2026-08-01T07:15:00.000Z" });
  observe("uniform.counts", built.meta.counts);

  // ---- compare or record ----
  if (RECORD) {
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((l) => !l.slice(3).startsWith(".billing-a0/"));
    if (dirty.length > 0) {
      console.log("refusing to record: changes outside .billing-a0/:\n" + dirty.join("\n"));
      process.exit(2);
    }
    const meta = {
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      recordedAt: new Date().toISOString(),
      recordedWith: `node ${process.version} ${process.platform}; postgres ${(await prisma.$queryRawUnsafe<{ server_version: string }[]>("show server_version"))[0]?.server_version}`,
      note: "Recorded by .billing-a0/battery.mts --record from unmodified code. Never edited by hand, never rewritten by a test.",
    };
    writeFileSync(BASELINE, JSON.stringify({ meta, observations: observed }, null, 2) + "\n");
    console.log(`recorded ${Object.keys(observed).length} observations to baseline/db.json`);
  } else {
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { meta: Record<string, unknown>; observations: Record<string, string> };
    console.log(`--- compare to baseline recorded from ${String(baseline.meta.sourceCommit)} ---`);
    for (const key of Object.keys(baseline.observations).sort()) {
      const want = baseline.observations[key];
      const got = observed[key];
      ok(`baseline: ${key}`, got === want, got === undefined ? "no longer produced" : `\n      expected: ${want}\n      actual:   ${got}`);
    }
    for (const key of Object.keys(observed)) {
      if (!(key in baseline.observations)) ok(`baseline: ${key}`, false, "produced but not in the baseline");
    }
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
