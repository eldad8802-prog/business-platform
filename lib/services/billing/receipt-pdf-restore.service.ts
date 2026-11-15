/**
 * Controlled restore of an issued receipt's PDF — owner decision 2026-11-12: an issued document stays exactly as issued.
 *
 * NEVER automatic. Run explicitly by the owner (scripts/ops/restore-receipt-pdf.mts), dry-run by default. A lost or
 * altered stored PDF is put back ONLY when the candidate bytes hash to the pdfHash recorded when the PDF was produced —
 * that match is the proof that the bytes are the original. Nothing else is ever written: no new copy, no re-render
 * presented as the original, no change to the document row (key, hash, version, timestamps stay as recorded).
 *
 * Candidate sources, in order:
 *   1. the stored object itself (already intact → nothing to do);
 *   2. a sealed accountant package (AccountantPackage READY) whose ZIP contains a file with exactly that hash;
 *   3. a re-render from the frozen issuedSnapshot with the template the recorded pdfTemplateVersion names
 *      ("billing-v1-html" → the template frozen before #1108; RECEIPT_CURRENT_HTML_TEMPLATE_VERSION → today's), where
 *      the only non-deterministic bytes of the HTML renderer — CreationDate / ModDate (whole seconds) — are tried for
 *      every second of the window before pdfRenderedAt. pdfmake output also embeds a millisecond-derived file ID, so a
 *      pdfmake-produced receipt is reported NOT_VERIFIED (no attempt to fake it).
 * A successful restore writes the verified bytes back under the recorded storage key and records a BILLING_PDF_RESTORED
 * audit event (source, hash, key). Everything else returns a verdict and writes nothing.
 */
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { BillingPdfRenderStatus } from "@prisma/client";

import { getStorageService } from "@/lib/storage";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { createBillingAuditEventTx } from "@/lib/services/billing/billing-audit.service";
import {
  renderBillingPdfHtmlFromSnapshot,
  type BillingPdfHtmlTemplate,
} from "@/lib/services/billing/pdf/billing-pdf-html-renderer";
import type { PdfReceiptPayment } from "@/lib/services/billing/pdf/billing-pdf-html-template";
import { assertSnapshotV1, type BillingIssuedSnapshotV1 } from "@/lib/services/billing/pdf/billing-pdf-template";
import { receiptHtmlTemplateForVersion } from "@/lib/services/billing/pdf/receipt-template-version";
import { existsByKey, readByKey, writeAtomic } from "@/lib/services/billing/pdf/billing-pdf-storage";

/** How far before pdfRenderedAt the PDF's CreationDate may lie (render + write); a few seconds after for clock skew. */
export const RESTORE_WINDOW_BEFORE_SECONDS = 300;
export const RESTORE_WINDOW_AFTER_SECONDS = 5;

export type ReceiptPdfRestoreVerdict =
  | "NOT_A_PRODUCED_RECEIPT_PDF" // not a RECEIPT, or no PDF was ever produced (PENDING/FAILED) — nothing to restore
  | "ORIGINAL_PRESENT" // the stored object exists and hashes to pdfHash — nothing to do
  | "VERIFIED_FROM_PACKAGE" // exact bytes found in a sealed accountant package
  | "VERIFIED_BY_RERENDER" // re-render with the recorded template reproduced the exact bytes
  | "NOT_VERIFIED"; // no source reproduces the recorded hash — nothing written

export type ReceiptPdfRestoreResult = {
  verdict: ReceiptPdfRestoreVerdict;
  applied: boolean;
  billingDocumentId: number;
  pdfHash: string | null;
  detail: string;
};

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

/**
 * Try every whole second in [renderedAt − before, renderedAt + after] as the PDF's CreationDate/ModDate (the HTML
 * renderer writes both, same value, fixed length) and return the bytes that hash to `want`, or null.
 */
export function matchRenderedAtWindow(candidate: Buffer, renderedAt: Date, want: string,
  before = RESTORE_WINDOW_BEFORE_SECONDS, after = RESTORE_WINDOW_AFTER_SECONDS): Buffer | null {
  const text = candidate.toString("latin1");
  const re = /\/(CreationDate|ModDate) \((D:\d{14}\+00'00')\)/g;
  const found = [...text.matchAll(re)];
  if (found.length === 0) return sha256(candidate) === want ? candidate : null;
  const base = Math.floor(renderedAt.getTime() / 1000);
  for (let s = base + after; s >= base - before; s--) {
    const stamp = pdfDate(new Date(s * 1000));
    const replaced = text.replace(re, (_m, k) => `/${k} (${stamp})`);
    const buf = Buffer.from(replaced, "latin1");
    if (sha256(buf) === want) return buf;
  }
  return null;
}

export type ReceiptPdfRestoreDeps = {
  render: (snapshot: BillingIssuedSnapshotV1, payments: PdfReceiptPayment[], template: BillingPdfHtmlTemplate) => Promise<Buffer>;
  readPackage: (storageKey: string) => Promise<Buffer>;
};
const defaultDeps: ReceiptPdfRestoreDeps = {
  render: renderBillingPdfHtmlFromSnapshot,
  readPackage: async (key) => (await getStorageService().getObject(key)).body,
};

export async function restoreIssuedReceiptPdf(
  input: { businessId: number; billingDocumentId: number; actorUserId: number; apply?: boolean },
  deps: ReceiptPdfRestoreDeps = defaultDeps
): Promise<ReceiptPdfRestoreResult> {
  const { businessId, billingDocumentId } = input;
  const doc = await billingTenantTx(businessId, (tx) =>
    tx.billingDocument.findFirst({
      where: { id: billingDocumentId, businessId },
      select: {
        id: true, documentType: true, status: true, issuedSnapshot: true, pdfRenderStatus: true, pdfStorageKey: true,
        pdfHash: true, pdfTemplateVersion: true, pdfRenderedAt: true,
        receiptPayments: {
          orderBy: { lineIndex: "asc" },
          select: { method: true, amount: true, currency: true, paymentDate: true, bankName: true, bankBranch: true,
            bankAccountNumber: true, checkNumber: true, checkDueDate: true, cardBrand: true, cardLast4: true, reference: true },
        },
      },
    })
  );
  const base = { billingDocumentId, pdfHash: doc?.pdfHash ?? null, applied: false };
  if (!doc || doc.documentType !== "RECEIPT" || doc.status !== "ISSUED" || doc.pdfRenderStatus !== BillingPdfRenderStatus.RENDERED
    || !doc.pdfStorageKey || !doc.pdfHash) {
    return { ...base, verdict: "NOT_A_PRODUCED_RECEIPT_PDF", detail: "not an issued receipt with a produced PDF (no recorded key + hash)" };
  }
  const key = doc.pdfStorageKey;
  const want = doc.pdfHash;

  // 1. the stored object
  try {
    if (await existsByKey(key)) {
      const stored = await readByKey(key);
      if (sha256(stored) === want) return { ...base, verdict: "ORIGINAL_PRESENT", detail: "stored PDF is intact" };
    }
  } catch { /* treated as lost */ }

  let verified: Buffer | null = null;
  let verdict: ReceiptPdfRestoreVerdict = "NOT_VERIFIED";
  let source = "";

  // 2. a sealed accountant package
  const packages = await billingTenantTx(businessId, (tx) =>
    tx.accountantPackage.findMany({ where: { businessId, status: "READY", storageKey: { not: null } }, select: { id: true, storageKey: true }, orderBy: { id: "desc" } })
  );
  for (const p of packages) {
    try {
      const zip = await JSZip.loadAsync(await deps.readPackage(p.storageKey!));
      for (const f of Object.values(zip.files)) {
        if (f.dir || !f.name.toLowerCase().endsWith(".pdf")) continue;
        const bytes = await f.async("nodebuffer");
        if (sha256(bytes) === want) { verified = bytes; verdict = "VERIFIED_FROM_PACKAGE"; source = `accountant package ${p.id}: ${f.name}`; break; }
      }
    } catch { /* unreadable package: skip */ }
    if (verified) break;
  }

  // 3. a verified re-render with the recorded template
  if (!verified) {
    const template = receiptHtmlTemplateForVersion(doc.pdfTemplateVersion);
    if (template && doc.pdfRenderedAt) {
      assertSnapshotV1(doc.issuedSnapshot);
      const payments: PdfReceiptPayment[] = doc.receiptPayments.map((p) => ({
        method: p.method, amount: p.amount.toFixed(2), currency: p.currency, paymentDate: p.paymentDate.toISOString(),
        bankName: p.bankName, bankBranch: p.bankBranch, bankAccountNumber: p.bankAccountNumber, checkNumber: p.checkNumber,
        checkDueDate: p.checkDueDate ? p.checkDueDate.toISOString() : null, cardBrand: p.cardBrand, cardLast4: p.cardLast4, reference: p.reference,
      }));
      const candidate = await deps.render(doc.issuedSnapshot as unknown as BillingIssuedSnapshotV1, payments, template);
      const match = matchRenderedAtWindow(candidate, doc.pdfRenderedAt, want);
      if (match) { verified = match; verdict = "VERIFIED_BY_RERENDER"; source = `re-render with ${template} (${doc.pdfTemplateVersion})`; }
      else source = `re-render with ${template} did not reproduce the recorded hash (different renderer build, fonts or template)`;
    } else {
      source = `recorded template version ${JSON.stringify(doc.pdfTemplateVersion)} cannot be reproduced here`;
    }
  }

  if (!verified) return { ...base, verdict: "NOT_VERIFIED", detail: `no source reproduces pdfHash; ${source || "no sealed package holds it"}` };
  if (!input.apply) return { ...base, verdict, detail: `DRY RUN — would restore from ${source}` };

  await writeAtomic(key, verified);
  const check = await readByKey(key);
  if (sha256(check) !== want) throw new Error("restore: written object does not hash to pdfHash");
  await billingTenantTx(businessId, (tx) =>
    createBillingAuditEventTx(tx, {
      businessId, billingDocumentId, actorUserId: input.actorUserId, eventType: "BILLING_PDF_RESTORED",
      summary: "Issued receipt PDF restored from a verified original (hash match)",
      metadata: { documentId: billingDocumentId, pdfHash: want, pdfStorageKey: key, verdict, source },
    })
  );
  return { ...base, applied: true, verdict, detail: `restored from ${source}` };
}
