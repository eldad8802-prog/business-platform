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
 *   B1/B2  a receipt that never got a PDF is rendered once with today's template and RECORDS that template
 *          (RECEIPT_CURRENT_HTML_TEMPLATE_VERSION) — it is never labelled as a pre-#1108 original
 *   R1  controlled restore (owner-run): lost file → dry run verifies by re-render and writes nothing; --apply puts back the
 *       exact original bytes under the recorded key, row unchanged, one BILLING_PDF_RESTORED audit event
 *   R2  a receipt produced with the PRE-#1108 template (recorded "billing-v1-html"): restore reproduces it with the frozen
 *       receipt-v1 template — the restored PDF still says RECEIPT / not קבלה (the original, not today's template)
 *   R3  a recorded hash no source can reproduce → NOT_VERIFIED: nothing written, no audit event, still refused (503)
 *   R4  the exact bytes in a sealed accountant package → VERIFIED_FROM_PACKAGE
 *   R5  a receipt with no produced PDF → NOT_A_PRODUCED_RECEIPT_PDF, nothing written
 *   R6  stored bytes altered → restore replaces them only with the verified original
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
import { renderBillingPdfHtmlFromSnapshot } from "../lib/services/billing/pdf/billing-pdf-html-renderer";
import { RECEIPT_CURRENT_HTML_TEMPLATE_VERSION, RECEIPT_V1_HTML_TEMPLATE_VERSION } from "../lib/services/billing/pdf/receipt-template-version";
import { restoreIssuedReceiptPdf } from "../lib/services/billing/receipt-pdf-restore.service";
import { getStorageService } from "../lib/storage";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";

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

  // ===================================================================== B: never-rendered receipt
  const newReceipt = async (amount: string) => {
    const d = await createBillingDraft({ businessId: b, actorUserId: u, documentType: BillingDocumentType.RECEIPT, customerId: c });
    await replaceReceiptPaymentLines({ businessId: b, billingDocumentId: d.id, paymentLines: [{ lineIndex: 1, method: "CASH", amount, currency: "ILS", paymentDate: "2026-11-09" }] });
    await issueBillingDocument({ businessId: b, billingDocumentId: d.id, actorUserId: u }, stub as never);
    return d.id;
  };
  const m2 = await newReceipt("75.00");
  const b1 = await call(m2);
  const m2row = await row(m2);
  ok("B1 a never-rendered receipt gets its first PDF with today's template, recording that template",
    b1.renderedNow === true && m2row.pdfTemplateVersion === RECEIPT_CURRENT_HTML_TEMPLATE_VERSION, String(m2row.pdfTemplateVersion));
  ok("B2 it is never recorded as a pre-#1108 original", m2row.pdfTemplateVersion !== RECEIPT_V1_HTML_TEMPLATE_VERSION);

  // ===================================================================== C: controlled restore
  const restore = (id: number, apply = false) => restoreIssuedReceiptPdf({ businessId: b, billingDocumentId: id, actorUserId: u, apply });
  // a read that never throws: a refused (503) read is reported as a failed check, not a crash
  const served = async (id: number) => { try { return await call(id); } catch { return null; } };
  const restoredEvents = (id: number) => prisma.billingAuditEvent.count({ where: { billingDocumentId: id, eventType: "BILLING_PDF_RESTORED" } });
  const pdfText = async (buf: Buffer) => {
    const p = new PDFParse({ data: new Uint8Array(buf) });
    try { return (await p.getText()).text.replace(/\s+/g, ""); } finally { await p.destroy(); }
  };

  // R1 lost file, today's template
  await unlinkByKeyQuiet(m2row.pdfStorageKey!);
  const objsR1 = storedObjects();
  const dry = await restore(m2);
  ok("R1 dry run: verified by re-render, nothing written",
    dry.verdict === "VERIFIED_BY_RERENDER" && dry.applied === false && storedObjects() === objsR1 && (await restoredEvents(m2)) === 0, JSON.stringify(dry));
  ok("R1 before restore the receipt is refused (503), not regenerated", (await refused(m2))?.status === 503);
  const app1 = await restore(m2, true);
  const r1after = await served(m2);
  ok("R1 --apply puts back the exact original bytes (sha256 = pdfHash) under the recorded key",
    app1.applied === true && !!r1after && r1after.renderedNow === false && r1after.buffer.equals(b1.buffer) && sha(r1after.buffer) === m2row.pdfHash, JSON.stringify(app1));
  ok("R1 the document row is unchanged and one BILLING_PDF_RESTORED event is recorded",
    JSON.stringify(await row(m2)) === JSON.stringify(m2row) && (await restoredEvents(m2)) === 1);

  // R2 produced with the pre-#1108 template
  const m3 = await newReceipt("40.00");
  const snap3 = (await prisma.billingDocument.findUniqueOrThrow({ where: { id: m3 }, select: { issuedSnapshot: true } })).issuedSnapshot;
  const v1bytes = await renderBillingPdfHtmlFromSnapshot(snap3 as never, [], "receipt-v1");
  const v1At = new Date();
  const v1Hash = sha(v1bytes);
  const v1Key = buildStorageKey(b, m3, v1Hash);
  await writeAtomic(v1Key, v1bytes);
  await prisma.billingDocument.update({ where: { id: m3 }, data: { pdfRenderStatus: "RENDERED", pdfStorageKey: v1Key, pdfHash: v1Hash, pdfTemplateVersion: RECEIPT_V1_HTML_TEMPLATE_VERSION, pdfRenderedAt: v1At } });
  const served3 = await call(m3);
  ok("R2 (state A) a pre-#1108 receipt PDF is served as stored", served3.renderedNow === false && served3.buffer.equals(v1bytes));
  await new Promise((r) => setTimeout(r, 2000));
  await unlinkByKeyQuiet(v1Key);
  const app2 = await restore(m3, true);
  const r2after = await served(m3);
  const text2 = r2after ? await pdfText(r2after.buffer) : "";
  ok("R2 restore reproduces the pre-#1108 original with the frozen template (exact bytes)",
    app2.verdict === "VERIFIED_BY_RERENDER" && !!r2after && r2after.buffer.equals(v1bytes), JSON.stringify(app2));
  ok("R2 the restored PDF is the OLD template (RECEIPT, no קבלה) — today's template is never presented as the original",
    text2.includes("RECEIPT") && !text2.includes("קבלה"));

  // R3 a hash nothing can reproduce (the synthetic old-template bytes of N5)
  await unlinkByKeyQuiet(legacyKey);
  const objsR3 = storedObjects();
  const res3 = await restore(m.id, true);
  ok("R3 NOT_VERIFIED: nothing written, no audit event, the receipt stays refused",
    res3.verdict === "NOT_VERIFIED" && res3.applied === false && storedObjects() === objsR3
      && (await restoredEvents(m.id)) === 0 && (await refused(m.id))?.code === "RECEIPT_STORED_PDF_UNAVAILABLE", JSON.stringify(res3));

  // R4 a sealed accountant package holds the exact bytes
  const m4 = await newReceipt("90.00");
  const p4 = await call(m4);
  const m4row = await row(m4);
  await prisma.billingDocument.update({ where: { id: m4 }, data: { pdfRenderedAt: new Date("2026-01-01T00:00:00Z") } }); // re-render window cannot match
  const zip = new JSZip();
  zip.file("issued/receipt-000004.pdf", p4.buffer);
  zip.file("summary.txt", "synthetic");
  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  const pkgKey = `biz/${b}/exports/accountant/2026-11/v1-${sha(zipBuf).slice(0, 16)}.zip`;
  await getStorageService().putObject({ key: pkgKey, body: zipBuf, contentType: "application/zip", metadata: { businessId: b, domain: "exports", visibility: "private" } });
  const period = await prisma.accountantPeriod.create({ data: { businessId: b, periodKey: "2026-11", status: "OPEN", createdAt: new Date(), updatedAt: new Date() } });
  await prisma.accountantPackage.create({ data: { businessId: b, periodId: period.id, version: 1, contentFingerprint: "synthetic", status: "READY", storageKey: pkgKey, sha256: sha(zipBuf), createdAt: new Date(), readyAt: new Date() } });
  await unlinkByKeyQuiet(m4row.pdfStorageKey!);
  const app4 = await restore(m4, true);
  const r4after = await served(m4);
  ok("R4 the exact bytes from a sealed accountant package → VERIFIED_FROM_PACKAGE, restored",
    app4.verdict === "VERIFIED_FROM_PACKAGE" && !!r4after && r4after.buffer.equals(p4.buffer), JSON.stringify(app4));

  // R5 no produced PDF
  const m5 = await newReceipt("10.00");
  const objsR5 = storedObjects();
  const res5 = await restore(m5, true);
  ok("R5 a receipt with no produced PDF → NOT_A_PRODUCED_RECEIPT_PDF, nothing written",
    res5.verdict === "NOT_A_PRODUCED_RECEIPT_PDF" && res5.applied === false && storedObjects() === objsR5 && (await row(m5)).pdfRenderStatus !== "RENDERED");

  // R6 altered bytes
  await writeAtomic(m2row.pdfStorageKey!, Buffer.from("%PDF-1.4\n% altered\n%%EOF\n"));
  ok("R6 altered stored bytes are refused", (await refused(m2))?.status === 503);
  const app6 = await restore(m2, true);
  const r6after = await served(m2);
  ok("R6 restore replaces altered bytes only with the verified original",
    app6.verdict === "VERIFIED_BY_RERENDER" && !!r6after && r6after.buffer.equals(b1.buffer), JSON.stringify(app6));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
