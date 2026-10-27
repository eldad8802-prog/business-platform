/**
 * The accountant's portal index (R3), pure, on a REAL package ZIP from the builder:
 *   npx tsx lib/accountant/portal.verify.test.ts
 *
 *  - every source / issued file of the ZIP is listed, with the sha256 and size of its bytes in the ZIP;
 *  - each is joined to its row of the package's own workbook (date, party, amount — as shown there);
 *  - verified: true for a hash-checked original, false for one shipped without a recorded hash, true issued;
 *  - rows whose file is not in the package (missing, not matching, issued not yet rendered) are listed with
 *    the workbook's reason — and no listed file path is absent from the ZIP;
 *  - nothing else in the ZIP (_meta, the reports, the summary) is listed, and only listed paths are found;
 *  - only PDF / raster images are viewable; download names are ASCII;
 *  - cache keys stay under the package's own prefix and are bound to the package sha256 (and the file's).
 */
// Production runs in UTC; the workbook's date cells follow the process time zone (a known, separate issue).
process.env.TZ = "UTC";

import { createHash } from "node:crypto";

import JSZip from "jszip";

import type { IssuedDocumentFact, PeriodFacts, ScannedRecordFact } from "@/lib/accountant/package-scope";
import { buildAccountantPackage } from "@/lib/reports/accountant-export-zip";
import { StorageObjectNotFoundError } from "@/lib/storage/storage.errors";

import { PORTAL_INDEX_VERSION, buildPortalIndex, findPortalFile, portalFileCacheKey, portalFileName, portalIndexCacheKey } from "./portal";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`OK: ${name}`);
  else { failed++; console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`); }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const bytes: Record<string, Buffer> = {
  "doc-1700000000001-aaaaaaaa.pdf": Buffer.from("%PDF-verified"),
  "doc-1700000000002-bbbbbbbb.pdf": Buffer.from("%PDF-replaced"),
  "doc-1700000000003-cccccccc.jpg": Buffer.from("JPEG-legacy"),
  "doc-1700000000006-ffffffff.heic": Buffer.from("HEIC-bytes"),
};
const issuedBytes = Buffer.from("%PDF-issued-invoice");

function scanned(over: Partial<ScannedRecordFact> & { id: number; documentId: number }): ScannedRecordFact {
  return {
    amount: 100, date: new Date("2026-09-10T00:00:00Z"), direction: "expense", category: "general", vendorName: "ספק",
    documentCreatedAt: new Date("2026-09-10T08:00:00Z"), documentStatus: "approved", fileUrl: null, fileSha256: null, ...over,
  };
}

async function main() {
  const facts: PeriodFacts = {
    scanned: [
      scanned({ id: 11, documentId: 1, fileUrl: "doc-1700000000001-aaaaaaaa.pdf", fileSha256: sha(bytes["doc-1700000000001-aaaaaaaa.pdf"]), vendorName: "ספק מאומת", amount: 1234.5, date: new Date("2026-09-04T00:00:00Z") }),
      scanned({ id: 12, documentId: 2, fileUrl: "doc-1700000000002-bbbbbbbb.pdf", fileSha256: sha(Buffer.from("ingested")), vendorName: "ספק לא תואם" }),
      scanned({ id: 13, documentId: 3, fileUrl: "doc-1700000000003-cccccccc.jpg", fileSha256: null, vendorName: "ספק ישן" }),
      scanned({ id: 14, documentId: 4, fileUrl: "doc-1700000000004-dddddddd.pdf", fileSha256: sha(Buffer.from("gone")), vendorName: "ספק חסר" }),
      scanned({ id: 16, documentId: 6, fileUrl: "doc-1700000000006-ffffffff.heic", fileSha256: null, vendorName: "קובץ HEIC" }),
    ],
    issued: [
      { id: 90, documentType: "TAX_INVOICE", documentNumberFormatted: "INV-0090", issuedAt: new Date("2026-09-12T09:00:00Z"), subtotalAmount: "100.00", vatAmount: "18.00", totalAmount: "118.00",
        currency: "ILS", customerName: "מאפיית הלב", referenceDocumentId: null, pdf: { available: true, storageKey: `biz/1/billing/90/${sha(issuedBytes)}.pdf`, sha256: sha(issuedBytes) } } as IssuedDocumentFact,
      { id: 91, documentType: "RECEIPT", documentNumberFormatted: "R-0091", issuedAt: new Date("2026-09-13T09:00:00Z"), subtotalAmount: "50.00", vatAmount: "0.00", totalAmount: "50.00",
        currency: "USD", customerName: "Acme", referenceDocumentId: null, pdf: { available: false, reason: "NOT_RENDERED" } } as IssuedDocumentFact,
    ],
    pending: [],
    identity: { legalName: null, taxId: null },
  };
  const built = await buildAccountantPackage({
    businessId: 9, periodLabel: "2026-09", facts, generatedAt: new Date("2026-10-01T06:00:00Z"),
    readers: {
      readOriginal: async (_b, basename) => { const b = bytes[basename]; if (!b) throw new StorageObjectNotFoundError(basename); return b; },
      readIssuedPdf: async () => issuedBytes,
    },
  });
  const zip = await JSZip.loadAsync(built.buffer);
  const pkg = { businessId: 9, periodKey: "2026-09", version: 3, storageKey: `biz/9/exports/accountant/2026-09/v3-${built.sha256.slice(0, 16)}.zip`, sha256: built.sha256 };
  const ix = await buildPortalIndex(zip, pkg);
  const by = (p: string) => ix.files.find((f) => f.path === p);

  ok("the index is versioned and bound to the package", ix.indexVersion === PORTAL_INDEX_VERSION && ix.packageSha256 === built.sha256 && ix.packageVersion === 3 && ix.generatedAt === "2026-10-01T06:00:00.000Z");
  ok("files: the shipped originals and the shipped invoice — and nothing else",
    JSON.stringify(ix.files.map((f) => f.path)) === JSON.stringify(["approved/doc-1.pdf", "approved/doc-3.jpg", "approved/doc-6.heic", "issued/invoice-INV-0090.pdf"]), ix.files.map((f) => f.path).join(","));
  for (const f of ix.files) {
    const inZip = await zip.file(f.path)!.async("nodebuffer");
    ok(`${f.path}: sha256 and size are the ZIP entry's`, f.sha256 === sha(inZip) && f.size === inZip.byteLength);
  }
  ok("the original's details come from its workbook row", by("approved/doc-1.pdf")?.party === "ספק מאומת" && by("approved/doc-1.pdf")?.date === "04/09/2026" && by("approved/doc-1.pdf")?.amount === "1,234.50", JSON.stringify(by("approved/doc-1.pdf")));
  ok("the invoice's details come from its workbook row", by("issued/invoice-INV-0090.pdf")?.title === "חשבונית מס INV-0090" && by("issued/invoice-INV-0090.pdf")?.party === "מאפיית הלב" && by("issued/invoice-INV-0090.pdf")?.amount === "118.00" && by("issued/invoice-INV-0090.pdf")?.currency === "ILS", JSON.stringify(by("issued/invoice-INV-0090.pdf")));
  ok("verified: hash-checked original true, no-hash original false, issued true", by("approved/doc-1.pdf")?.verified === true && by("approved/doc-3.jpg")?.verified === false && by("issued/invoice-INV-0090.pdf")?.verified === true);
  ok("document ids: originals carry theirs, issued none", by("approved/doc-1.pdf")?.documentId === 1 && by("issued/invoice-INV-0090.pdf")?.documentId === null);
  ok("missing: the mismatch, the absent original and the unrendered receipt, with the workbook's reasons",
    ix.missing.length === 3 && ix.missing.some((m) => m.party === "ספק לא תואם" && m.reason.includes("אינו תואם")) && ix.missing.some((m) => m.party === "ספק חסר" && m.reason.includes("חסר")) &&
      ix.missing.some((m) => m.kind === "issued" && m.party === "Acme" && m.reason.includes("אינו זמין")), JSON.stringify(ix.missing));
  ok("counts", ix.counts.source === 3 && ix.counts.issued === 1 && ix.counts.missing === 3 && ix.counts.pending === 0, JSON.stringify(ix.counts));
  ok("viewable: PDF and JPEG yes; HEIC download-only", by("approved/doc-1.pdf")?.viewable === true && by("approved/doc-3.jpg")?.viewable === true && by("approved/doc-6.heic")?.viewable === false && by("approved/doc-6.heic")?.contentType === "image/heic");
  ok("download names are ASCII, prefixed by the month", by("approved/doc-1.pdf")?.fileName === "2026-09-doc-1.pdf" && portalFileName("2026-09", "issued/receipt-ק-1.pdf") === "2026-09-receipt-_-1.pdf");

  for (const bad of ["_meta/manifest.json", "_meta/missing-files.txt", "דוח_2026-09.xlsx", "סיכום.txt", "approved/doc-2.pdf", "approved/../_meta/manifest.json", pkg.storageKey, "", 7, null, "x".repeat(300)]) {
    ok(`not reachable: ${String(bad).slice(0, 40) || "(empty)"}`, findPortalFile(ix, bad) === null);
  }
  ok("a listed path is found", findPortalFile(ix, "approved/doc-1.pdf")?.sha256 === by("approved/doc-1.pdf")?.sha256);

  const ik = portalIndexCacheKey(pkg);
  ok("index cache key: next to the package, bound to the full sha256 and layout", ik === `biz/9/exports/accountant/2026-09/v3-${built.sha256}.portal-${PORTAL_INDEX_VERSION}.json`, ik);
  const fk = portalFileCacheKey(pkg, by("approved/doc-3.jpg")!);
  ok("file cache key: bound to the package sha256 AND the file sha256", fk === `biz/9/exports/accountant/2026-09/v3-${built.sha256}.files/${by("approved/doc-3.jpg")!.sha256}.jpg`, fk);
  let threw = false;
  try { portalFileCacheKey(pkg, { path: "approved/doc-1.pdf", sha256: "not-a-sha" }); } catch { threw = true; }
  ok("a malformed file sha256 never makes a key", threw);

  if (failed > 0) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }
  console.log("\nportal: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
