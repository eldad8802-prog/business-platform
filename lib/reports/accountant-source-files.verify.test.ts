/**
 * Source documents in the accountant package (S1–S3), on a REAL package ZIP from the builder:
 *
 *   S1  a record whose original is not in the ZIP never shows a path: the report row (Excel, CSV, and so
 *       the PDF summary, which prints the workbook) says the file is missing / does not match;
 *   S2  an original is checked against Document.contentHashSha256: a mismatch is NOT shipped and blocks the
 *       package; a document without a recorded hash is shipped and flagged "not verified";
 *   S3  _meta/manifest.json lists every shipped file with its sha256 and size, verified or not, and the
 *       report record(s) / billing document it belongs to — and the database manifest stays as it was.
 *
 * The invariant the accountant relies on: every path the report shows is a file in the ZIP, every file in
 * the ZIP hashes to what the manifest says, and every missing or doubtful file is visible on its row.
 */
import { createHash } from "node:crypto";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import type { IssuedDocumentFact, PeriodFacts, ScannedRecordFact } from "@/lib/accountant/package-scope";
import { computeFingerprint } from "@/lib/accountant/package-scope";
import { buildPackageReportModel } from "@/lib/accountant/package-report-pdf";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";

import {
  SOURCE_FILE_MISMATCH_HE,
  SOURCE_FILE_MISSING_HE,
  buildAccountantPackage,
  type PackageManifest,
} from "./accountant-export-zip";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`OK: ${name}`);
  else { failed++; console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Stored objects (by basename) and what ingestion recorded.
const bytes: Record<string, Buffer> = {
  "doc-1700000000001-aaaaaaaa.pdf": Buffer.from("%PDF-verified-original"),
  "doc-1700000000002-bbbbbbbb.pdf": Buffer.from("%PDF-replaced-after-ingestion"),
  "doc-1700000000003-cccccccc.jpg": Buffer.from("JPEG-legacy-no-hash"),
  // doc 4 is not in storage at all
};
const issuedBytes = Buffer.from("%PDF-issued-invoice");

function scanned(over: Partial<ScannedRecordFact> & { id: number; documentId: number }): ScannedRecordFact {
  return {
    amount: 100,
    date: new Date("2026-09-10T00:00:00Z"),
    direction: "expense",
    category: "general",
    vendorName: "ספק",
    documentCreatedAt: new Date("2026-09-10T08:00:00Z"),
    documentStatus: "approved",
    fileUrl: null,
    fileSha256: null,
    ...over,
  };
}

async function main() {
  const records: ScannedRecordFact[] = [
    scanned({ id: 11, documentId: 1, fileUrl: "doc-1700000000001-aaaaaaaa.pdf", fileSha256: sha(bytes["doc-1700000000001-aaaaaaaa.pdf"]), vendorName: "ספק מאומת" }),
    scanned({ id: 12, documentId: 2, fileUrl: "doc-1700000000002-bbbbbbbb.pdf", fileSha256: sha(Buffer.from("%PDF-what-was-ingested")), vendorName: "ספק לא תואם" }),
    scanned({ id: 13, documentId: 3, fileUrl: "doc-1700000000003-cccccccc.jpg", fileSha256: null, vendorName: "ספק ישן" }),
    scanned({ id: 14, documentId: 4, fileUrl: "doc-1700000000004-dddddddd.pdf", fileSha256: sha(Buffer.from("gone")), vendorName: "ספק חסר" }),
    scanned({ id: 15, documentId: 5, fileUrl: null, vendorName: "ללא קובץ" }),
  ];
  const issuedOk: IssuedDocumentFact = {
    id: 90, documentType: "TAX_INVOICE", documentNumberFormatted: "INV-0090", issuedAt: new Date("2026-09-12T09:00:00Z"),
    subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00", currency: "ILS", customerName: "לקוח", referenceDocumentId: null,
    pdf: { available: true, storageKey: `biz/1/billing/90/${sha(issuedBytes)}.pdf`, sha256: sha(issuedBytes) },
  };
  const issuedPending: IssuedDocumentFact = { ...issuedOk, id: 91, documentNumberFormatted: "INV-0091", pdf: { available: false, reason: "NOT_RENDERED" } };
  const facts: PeriodFacts = { scanned: records, issued: [issuedOk, issuedPending], pending: [], identity: { legalName: null, taxId: null } };

  const built = await buildAccountantPackage({
    businessId: 1,
    periodLabel: "2026-09",
    facts,
    generatedAt: new Date("2026-10-01T06:00:00Z"),
    readers: {
      readOriginal: async (_b, basename) => {
        const b = bytes[basename];
        if (!b) throw new StorageObjectNotFoundError(basename);
        return b;
      },
      readIssuedPdf: async () => issuedBytes,
    },
  });
  const zip = await JSZip.loadAsync(built.buffer);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const manifest = JSON.parse(await zip.file("_meta/manifest.json")!.async("string")) as PackageManifest;

  // ── S2 ──
  ok("S2 the verified original is shipped", names.includes("approved/doc-1.pdf"));
  ok("S2 an original that does not hash to its recorded sha256 is NOT shipped", !names.includes("approved/doc-2.pdf"));
  ok("S2 …and blocks the package: ORIGINAL_FILE_MISMATCH, NEEDS_ATTENTION", built.readiness.status === "NEEDS_ATTENTION" && built.readiness.blockers.some((b) => b.kind === "ORIGINAL_FILE_MISMATCH" && b.documentIds.join() === "2"), JSON.stringify(built.readiness.blockers));
  ok("S2 an original without a recorded hash is shipped, not dropped", names.includes("approved/doc-3.jpg"));
  ok("S2 …and flagged: warning ORIGINAL_NOT_VERIFIED for document 3 only", built.readiness.warnings.some((w) => w.kind === "ORIGINAL_NOT_VERIFIED" && w.documentIds.join() === "3"), JSON.stringify(built.readiness.warnings));
  ok("S2 a file absent from storage stays ORIGINAL_FILES_MISSING (with the record that has no file at all)", built.readiness.blockers.some((b) => b.kind === "ORIGINAL_FILES_MISSING" && b.documentIds.join() === "4,5"), JSON.stringify(built.readiness.blockers));
  const missingTxt = await zip.file("_meta/missing-files.txt")!.async("string");
  ok("S2 the exceptions list names the mismatch, the absent file and the record without a file", /document 2: .*sha256/.test(missingTxt) && /document 4:/.test(missingTxt) && /document 5:/.test(missingTxt), missingTxt);

  // ── S1 ──
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await zip.file("דוח_2026-09.xlsx")!.async("nodebuffer")) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("דוח")!;
  const rowOf = (vendor: string) => { for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(2).value === vendor) return ws.getRow(r); return null; };
  const fileCell = (vendor: string) => String(rowOf(vendor)?.getCell(8).value ?? "");
  const noteCell = (vendor: string) => String(rowOf(vendor)?.getCell(9).value ?? "");
  ok("S1 the verified record shows its file", fileCell("ספק מאומת") === "approved/doc-1.pdf");
  ok("S1 the mismatched record says so on its row (no path)", fileCell("ספק לא תואם") === SOURCE_FILE_MISMATCH_HE, fileCell("ספק לא תואם"));
  ok("S1 the absent file and the record without a file say \"missing\" (no path)", fileCell("ספק חסר") === SOURCE_FILE_MISSING_HE && fileCell("ללא קובץ") === SOURCE_FILE_MISSING_HE);
  ok("S1 the unverified record shows its file and a note", fileCell("ספק ישן") === "approved/doc-3.jpg" && noteCell("ספק ישן").includes("ללא אימות"), noteCell("ספק ישן"));
  const issuedWs = wb.getWorksheet("מסמכים שהופקו")!;
  const issuedFiles = [2, 3].map((r) => String(issuedWs.getRow(r).getCell(10).value ?? ""));
  ok("S1 issued: the shipped invoice shows its file, the pending one says it is not available", issuedFiles.includes("issued/invoice-INV-0090.pdf") && issuedFiles.includes("הקובץ הסופי עדיין אינו זמין"), JSON.stringify(issuedFiles));
  const csv = await zip.file("_meta/דוח_2026-09.csv")!.async("string");
  ok("S1 the CSV says the same", csv.includes(SOURCE_FILE_MISMATCH_HE) && csv.includes(SOURCE_FILE_MISSING_HE) && csv.includes("approved/doc-1.pdf"));

  const model = await buildPackageReportModel(await zip.file("דוח_2026-09.xlsx")!.async("nodebuffer"), await zip.file("סיכום.txt")!.async("string"));
  const pdfTexts = model.tables.flatMap((t) => t.rows.flat().map((c) => c.text));
  ok("S1 the PDF summary shows the same row markers (it prints the workbook)", pdfTexts.includes(SOURCE_FILE_MISSING_HE) && pdfTexts.includes(SOURCE_FILE_MISMATCH_HE));
  ok("S1 the package summary names the mismatch and the unverified files", model.summaryLines.some((l) => l.includes("אינם תואמים")) && model.summaryLines.some((l) => l.includes("בלי אפשרות לאמת")), JSON.stringify(model.summaryLines));

  // THE invariant: every path the report shows is a file in the ZIP.
  const shownPaths: string[] = [];
  for (let r = 2; r <= ws.rowCount; r++) { const v = String(ws.getRow(r).getCell(8).value ?? ""); if (/^(approved|pending)\//.test(v)) shownPaths.push(v); }
  for (let r = 2; r <= issuedWs.rowCount; r++) { const v = String(issuedWs.getRow(r).getCell(10).value ?? ""); if (/^issued\//.test(v)) shownPaths.push(v); }
  ok("INVARIANT every path the report shows exists in the ZIP", shownPaths.length === 3 && shownPaths.every((p) => names.includes(p)), JSON.stringify(shownPaths));

  // ── S3 ──
  const files = manifest.files ?? [];
  ok("S3 manifest v2 lists exactly the shipped source files", manifest.manifestVersion === 2 && files.map((f) => f.path).sort().join() === ["approved/doc-1.pdf", "approved/doc-3.jpg", "issued/invoice-INV-0090.pdf"].sort().join(), JSON.stringify(files.map((f) => f.path)));
  let hashOk = true;
  for (const f of files) { const b = await zip.file(f.path)!.async("nodebuffer"); if (sha(b) !== f.sha256 || b.byteLength !== f.size) hashOk = false; }
  ok("S3 every listed file hashes to its manifest sha256 and size", hashOk);
  const f1 = files.find((f) => f.path === "approved/doc-1.pdf");
  const f3 = files.find((f) => f.path === "approved/doc-3.jpg");
  const fi = files.find((f) => f.path === "issued/invoice-INV-0090.pdf");
  ok("S3 each original maps to its document and report record; verified as it was", f1?.documentId === 1 && f1.recordIds?.join() === "11" && f1.verified === true && f3?.verified === false && f3.recordIds?.join() === "13");
  ok("S3 the issued file maps to its billing document and number", fi?.billingDocumentId === 90 && fi.documentNumber === "INV-0090" && fi.kind === "issued");
  ok("S3 the exceptions are listed by kind", manifest.mismatchedOriginalDocumentIds?.join() === "2" && manifest.unverifiedOriginalDocumentIds?.join() === "3" && manifest.missingOriginalDocumentIds.join() === "4,5");
  ok("S3 no file listed twice", new Set(files.map((f) => f.path)).size === files.length);
  ok("S3 the counts the database keeps are unchanged in meaning", manifest.approvedFiles === 2 && manifest.issuedFiles === 1 && manifest.recordCount === 5 && manifest.missingFiles === 3 + 0 && Array.isArray(manifest.entries));

  // ── Backward compatibility ──
  const withoutHashes = { ...facts, scanned: facts.scanned.map((r) => ({ ...r, fileSha256: undefined })) };
  ok("COMPAT the content fingerprint ignores the recorded file hash (existing packages are not re-marked)", computeFingerprint(withoutHashes) === computeFingerprint(facts));
  const old: PackageManifest = { period: "2026-08", generatedAt: "x", fingerprint: "f", recordCount: 1, issuedCount: 0, pendingCount: 0, approvedFiles: 1, issuedFiles: 0, missingFiles: 0, missingOriginalDocumentIds: [], missingIssuedDocumentIds: [], entries: [] };
  ok("COMPAT a manifest built before v2 (no files) is still a valid manifest", old.files === undefined && old.manifestVersion === undefined);

  if (failed) {
    console.log(`accountant-source-files: ${failed} failed`);
    process.exit(1);
  }
  console.log("accountant-source-files: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
