/**
 * Owner decision 2026-11-12: an issued receipt is NOT re-rendered automatically — after the #1108 template change the
 * PDF that was already produced for a receipt is served byte-for-byte, and nothing replaces it with a fresh render.
 *
 * Through the REAL billing PDF service (getOrRenderBillingPdf — what GET /api/billing/documents/[id]/pdf calls), on an
 * isolated PostgreSQL with synthetic data and local storage. No provider, no network.
 *
 *   N1  first request of a never-rendered receipt renders it (PENDING → RENDERED) — the only allowed render
 *   N2  the next request serves the same bytes (no render)
 *   N3  the stored template version differs (an older template): stored bytes served, DB row unchanged, nothing written
 *   N4  the renderer switch flips (BILLING_PDF_RENDERER=pdfmake): stored bytes served, nothing written
 *   N5  a PDF produced by an OLD template (bytes the current template can no longer produce): served exactly, hash = stored
 *   N6  stored bytes no longer match the stored hash: refused (503 RECEIPT_STORED_PDF_UNAVAILABLE), no render, nothing written
 *   N7  stored file missing: refused the same way, DB row unchanged, nothing written
 *   C1  control: a TAX_INVOICE whose stored file is missing is still re-rendered (unchanged behaviour)
 *   C2  control: BILLING_PDF_SKIP_CACHE=1 (explicit operator/debug override) still renders
 *
 *   npx tsx .billing-receipt-pdf/no-rerender.battery.mts   (DATABASE_URL = a throwaway lab, schema pushed; Chromium;
 *                                                          STORAGE_PROVIDER=local, LOCAL_STORAGE_ROOT set)
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { BillingDocumentType, PrismaClient } from "@prisma/client";

import { createBillingDraft } from "../lib/services/billing/billing-draft.service";
import { issueBillingDocument } from "../lib/services/billing/billing-issue.service";
import { getOrRenderBillingPdf } from "../lib/services/billing/billing-pdf.service";
import { buildStorageKey, unlinkByKeyQuiet, writeAtomic } from "../lib/services/billing/pdf/billing-pdf-storage";
import { replaceReceiptPaymentLines } from "../lib/services/billing/receipt/billing-receipt-draft.service";

const prisma = new PrismaClient();
const stub = { executeApproval: async (i: { billingDocumentId: number }) => ({ outcome: "completed_approved" as const, billingDocumentId: i.billingDocumentId, submissionId: -1, allocationNumber: "123456789", safeToRetry: false }) };

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const root = process.env.LOCAL_STORAGE_ROOT ?? "";
function storedObjects(): number {
  if (!root || !existsSync(root)) return 0;
  const walk = (d: string): number => readdirSync(d).reduce((n, f) => { const p = path.join(d, f); return n + (statSync(p).isDirectory() ? walk(p) : 1); }, 0);
  return walk(root);
}
const PDF_FIELDS = { pdfRenderStatus: true, pdfStorageKey: true, pdfHash: true, pdfTemplateVersion: true, pdfRenderedAt: true } as const;

async function main() {
  if (!root) throw new Error("LOCAL_STORAGE_ROOT must be set (local storage lab)");
  delete process.env.BILLING_PDF_SKIP_CACHE;
  delete process.env.BILLING_PDF_RENDERER;
  const stamp = Date.now();
  const b = (await prisma.business.create({ data: { name: "receipt-norerender-" + stamp } })).id;
  const u = (await prisma.user.create({ data: { email: `receipt-norerender-${stamp}@example.test`, password: "x", businessId: b } })).id;
  await prisma.businessProfile.create({ data: { businessId: b, billingLegalName: "עסק סינתטי לבדיקות", billingBusinessKind: "EXEMPT_DEALER", billingTaxId: "999999998", billingAddress: "רחוב הבדיקה 1", billingPhone: "03-0000000", billingEmail: "norerender@example.test" } });
  const c = (await prisma.customer.create({ data: { businessId: b, name: "לקוח סינתטי" } })).id;
  const call = (id: number) => getOrRenderBillingPdf({ businessId: b, billingDocumentId: id, actorUserId: u });
  const row = (id: number) => prisma.billingDocument.findUniqueOrThrow({ where: { id }, select: PDF_FIELDS });
  async function refused(id: number): Promise<{ status?: number; code?: string } | null> {
    try { await call(id); return null; } catch (e) { return { status: (e as { statusCode?: number }).statusCode, code: (e as { code?: string }).code }; }
  }

  const m = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.RECEIPT, customerId: c });
  await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: m.id, paymentLines: [{ lineIndex: 1, method: "CASH", amount: "50.00", currency: "ILS", paymentDate: "2026-11-09" }] });
  await issueBillingDocument({ businessId: b, billingDocumentId: m.id, actorUserId: u }, stub as never);

  // N1 / N2
  const r1 = await call(m.id);
  const after1 = await row(m.id);
  ok("N1 a never-rendered issued receipt is rendered once (first PDF)", r1.renderedNow === true && after1.pdfRenderStatus === "RENDERED" && after1.pdfHash === sha(r1.buffer));
  const r2 = await call(m.id);
  ok("N2 the next request serves the same bytes without rendering", r2.renderedNow === false && r2.buffer.equals(r1.buffer));

  // N3 an older template version recorded on the row
  await prisma.billingDocument.update({ where: { id: m.id }, data: { pdfTemplateVersion: "billing-v0-html" } });
  const before3 = await row(m.id); const objs3 = storedObjects();
  const r3 = await call(m.id);
  ok("N3 stored template version differs → the stored bytes are served, not re-rendered",
    r3.renderedNow === false && r3.buffer.equals(r1.buffer) && JSON.stringify(await row(m.id)) === JSON.stringify(before3) && storedObjects() === objs3,
    `renderedNow=${r3.renderedNow} same=${r3.buffer.equals(r1.buffer)} objs ${objs3}→${storedObjects()}`);

  // N4 renderer switch
  process.env.BILLING_PDF_RENDERER = "pdfmake";
  const objs4 = storedObjects();
  const r4 = await call(m.id);
  delete process.env.BILLING_PDF_RENDERER;
  ok("N4 the renderer switch flips → the stored bytes are served, nothing written", r4.renderedNow === false && r4.buffer.equals(r1.buffer) && storedObjects() === objs4);

  // N5 a PDF produced by an OLD template: bytes the current template cannot produce
  const legacy = Buffer.from(`%PDF-1.4\n% receipt produced by the template before #1108 (RECEIPT / סה"כ לתשלום) ${stamp}\n%%EOF\n`, "utf8");
  const legacyHash = sha(legacy);
  const legacyKey = buildStorageKey(b, m.id, legacyHash);
  await writeAtomic(legacyKey, legacy);
  // recorded as produced by the previous template version — after a template change only the freeze can serve it
  await prisma.billingDocument.update({ where: { id: m.id }, data: { pdfStorageKey: legacyKey, pdfHash: legacyHash, pdfTemplateVersion: "billing-v0-html" } });
  const objs5 = storedObjects();
  const r5 = await call(m.id);
  ok("N5 an old-template receipt PDF is served byte-for-byte (sha256 = stored pdfHash) after the template change",
    r5.renderedNow === false && r5.buffer.equals(legacy) && sha(r5.buffer) === legacyHash && r5.pdfHash === legacyHash && storedObjects() === objs5,
    `renderedNow=${r5.renderedNow} sha=${sha(r5.buffer).slice(0, 12)} stored=${legacyHash.slice(0, 12)}`);

  // N6 stored bytes changed under the same key
  await writeAtomic(legacyKey, Buffer.from("%PDF-1.4\n% altered\n%%EOF\n"));
  const before6 = await row(m.id); const objs6 = storedObjects();
  const e6 = await refused(m.id);
  ok("N6 stored bytes ≠ stored hash → refused 503 RECEIPT_STORED_PDF_UNAVAILABLE; no render; row and storage unchanged",
    e6?.status === 503 && e6?.code === "RECEIPT_STORED_PDF_UNAVAILABLE" && JSON.stringify(await row(m.id)) === JSON.stringify(before6) && storedObjects() === objs6,
    JSON.stringify(e6));

  // N7 stored file missing
  await unlinkByKeyQuiet(legacyKey);
  const before7 = await row(m.id); const objs7 = storedObjects();
  const e7 = await refused(m.id);
  ok("N7 stored file missing → refused 503 RECEIPT_STORED_PDF_UNAVAILABLE; no render; row and storage unchanged",
    e7?.status === 503 && e7?.code === "RECEIPT_STORED_PDF_UNAVAILABLE" && JSON.stringify(await row(m.id)) === JSON.stringify(before7) && storedObjects() === objs7,
    JSON.stringify(e7));

  // C1 control: a tax invoice whose stored file is missing still re-renders (behaviour unchanged for other types)
  await prisma.businessProfile.update({ where: { businessId: b }, data: { billingBusinessKind: "AUTHORIZED_DEALER", billingVatNumber: "999999998" } });
  const t = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.TAX_INVOICE, customerId: c, initialLines: [{ description: "שירות", quantity: "1", unitPrice: "100", vatRatePercent: "18" }] });
  await issueBillingDocument({ businessId: b, billingDocumentId: t.id, actorUserId: u }, stub as never);
  const t1 = await call(t.id);
  await unlinkByKeyQuiet((await row(t.id)).pdfStorageKey!);
  const t2 = await call(t.id);
  ok("C1 control: a TAX_INVOICE with its stored file missing is re-rendered (unchanged)", t1.renderedNow === true && t2.renderedNow === true);

  // C2 control: the explicit operator/debug override still renders a receipt
  await writeAtomic(legacyKey, legacy);
  const before8 = await row(m.id); const objs8 = storedObjects();
  process.env.BILLING_PDF_SKIP_CACHE = "1";
  const r8 = await call(m.id);
  delete process.env.BILLING_PDF_SKIP_CACHE;
  ok("C2 control: BILLING_PDF_SKIP_CACHE=1 (explicit override) still renders", r8.renderedNow === true);
  ok("C2 the override never replaces the frozen receipt's recorded PDF (row, version, stored object unchanged)",
    JSON.stringify(await row(m.id)) === JSON.stringify(before8) && storedObjects() === objs8, `objs ${objs8}→${storedObjects()}`);
  const r9 = await call(m.id);
  ok("C2 after the override the old-template bytes are still what is served", r9.renderedNow === false && r9.buffer.equals(legacy));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
