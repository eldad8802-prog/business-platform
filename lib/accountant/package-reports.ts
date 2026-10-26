/**
 * Reports taken FROM a sealed accountant package — never rebuilt from live data.
 *
 * The package ZIP already carries the report workbook (`דוח_<YYYY-MM>.xlsx`, built once, with the package,
 * from the same facts). The Excel download is that exact file: the stored ZIP is read, its sha256 must
 * equal the one sealed on the package row, and the workbook entry is taken out byte for byte. Nothing is
 * recomputed, re-rounded or re-read from the ledgers, so the file the owner downloads is the file inside
 * the package the accountant receives.
 *
 * The extracted file is cached as a PRIVATE sibling of the package object, keyed by the package's full
 * sha256 (a new package version is a new sha, so a new key — a cached file can never belong to another
 * version). Its metadata records the source sha256 and its own; a cached object whose recorded source does
 * not match is ignored and extracted again. SERVER-ONLY. Callers authorize first (accountantRoute + RLS).
 */
import { createHash } from "node:crypto";

import JSZip from "jszip";

import { getStorageService } from "@/lib/storage";

import { AccountantError } from "./http";
import {
  PACKAGE_PDF_TEMPLATE,
  PdfRenderError,
  buildPackageReportModel,
  renderHtmlToPdf,
  renderPackageReportHtml,
  sanitizeRenderError,
} from "./package-report-pdf";
import { isPeriodKey } from "./period";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The workbook entry inside a package ZIP (lib/reports/accountant-export-zip.ts names it so). */
export function packageReportEntryName(periodKey: string): string {
  return `דוח_${periodKey}.xlsx`;
}

/**
 * The cache key of the Excel report of one sealed package: next to the package object, bound to the
 * package's full sha256. `biz/9/exports/accountant/2026-09/v1-<sha16>.zip` → `…/2026-09/v1-<sha64>.report.xlsx`.
 */
export function packageExcelCacheKey(packageStorageKey: string, version: number, packageSha256: string): string {
  const slash = packageStorageKey.lastIndexOf("/");
  if (slash <= 0 || !/^[0-9a-f]{64}$/.test(packageSha256) || !Number.isInteger(version) || version <= 0) {
    throw new AccountantError(500, "PACKAGE_REPORT_KEY");
  }
  return `${packageStorageKey.slice(0, slash)}/v${version}-${packageSha256}.report.xlsx`;
}

/** ASCII file name for the Excel download. */
export function packageExcelDownloadName(periodKey: string, version: number): string {
  return `accountant-report-${periodKey}-v${version}.xlsx`;
}

export type SealedPackage = {
  businessId: number;
  periodKey: string;
  version: number;
  storageKey: string;
  sha256: string;
};

const sha256Of = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The stored package ZIP, opened only if it is the business's object and hashes to the sealed sha256. */
async function openVerifiedPackage(pkg: SealedPackage): Promise<JSZip> {
  const zip = await getStorageService().getObject(pkg.storageKey);
  if (zip.metadata.businessId !== pkg.businessId || sha256Of(zip.body) !== pkg.sha256) {
    throw new AccountantError(409, "PACKAGE_INTEGRITY");
  }
  return JSZip.loadAsync(zip.body);
}

async function readReportWorkbook(archive: JSZip, periodKey: string): Promise<Buffer> {
  const entry = archive.file(packageReportEntryName(periodKey));
  if (!entry) throw new AccountantError(404, "REPORT_NOT_IN_PACKAGE");
  return entry.async("nodebuffer");
}

/**
 * Returns the storage key of the package's Excel report, extracting it from the sealed ZIP the first
 * time. Refuses (409 PACKAGE_INTEGRITY) when the stored ZIP does not hash to the sealed sha256, and
 * (404 REPORT_NOT_IN_PACKAGE) when the ZIP has no workbook entry. Never writes anything else.
 */
export async function ensurePackageExcel(pkg: SealedPackage): Promise<{ key: string; cached: boolean }> {
  if (!isPeriodKey(pkg.periodKey)) throw new AccountantError(500, "PACKAGE_REPORT_KEY");
  const storage = getStorageService();
  const key = packageExcelCacheKey(pkg.storageKey, pkg.version, pkg.sha256);

  const head = await storage.headObject(key);
  if (head.exists && head.metadata?.businessId === pkg.businessId && head.metadata.custom?.sourceSha256 === pkg.sha256) {
    return { key, cached: true };
  }

  const archive = await openVerifiedPackage(pkg);
  const xlsx = await readReportWorkbook(archive, pkg.periodKey);

  await storage.putObject({
    key,
    body: xlsx,
    contentType: XLSX_CONTENT_TYPE,
    metadata: {
      businessId: pkg.businessId,
      domain: "exports",
      visibility: "private",
      custom: { sourceSha256: pkg.sha256, sha256: sha256Of(xlsx), kind: "accountant-report-xlsx" },
    },
  });
  return { key, cached: false };
}

// ── The PDF report (R1) ──────────────────────────────────────────────────────────────────────────

export const PDF_CONTENT_TYPE = "application/pdf";

/** The summary text entry inside a package ZIP (lib/reports/accountant-export-zip.ts names it so). */
export const PACKAGE_SUMMARY_ENTRY = "סיכום.txt";

/**
 * The cache key of the PDF report of one sealed package: next to the package object, bound to the
 * package's full sha256 AND the PDF layout version (a layout change never serves an older rendering).
 */
export function packagePdfCacheKey(packageStorageKey: string, version: number, packageSha256: string): string {
  return packageExcelCacheKey(packageStorageKey, version, packageSha256).replace(/\.report\.xlsx$/, `.report-${PACKAGE_PDF_TEMPLATE}.pdf`);
}

/** ASCII file name for the PDF download. */
export function packagePdfDownloadName(periodKey: string, version: number): string {
  return `accountant-report-${periodKey}-v${version}.pdf`;
}

export type PdfDeps = {
  renderPdf: (html: string) => Promise<Buffer>;
  fontDataUri: () => Promise<string>;
};

export const defaultPdfDeps: PdfDeps = {
  renderPdf: renderHtmlToPdf,
  // Loaded on demand: the billing renderer module pulls in Chromium, which an Excel download never needs.
  fontDataUri: async () => (await import("@/lib/services/billing/pdf/billing-pdf-html-renderer")).getNotoSansHebrewFontDataUri(),
};

/**
 * Returns the storage key of the package's PDF report, rendering it the first time from the package's
 * own workbook and summary (lib/accountant/package-report-pdf.ts). Same refusals as the Excel report:
 * 409 PACKAGE_INTEGRITY for a ZIP that does not hash to the sealed sha256, 404 REPORT_NOT_IN_PACKAGE when
 * the workbook is missing. Never writes anything but the cached PDF.
 */
export async function ensurePackagePdf(pkg: SealedPackage, deps: PdfDeps = defaultPdfDeps): Promise<{ key: string; cached: boolean }> {
  if (!isPeriodKey(pkg.periodKey)) throw new AccountantError(500, "PACKAGE_REPORT_KEY");
  const storage = getStorageService();
  const key = packagePdfCacheKey(pkg.storageKey, pkg.version, pkg.sha256);

  const head = await storage.headObject(key);
  if (
    head.exists &&
    head.metadata?.businessId === pkg.businessId &&
    head.metadata.custom?.sourceSha256 === pkg.sha256 &&
    head.metadata.custom?.template === PACKAGE_PDF_TEMPLATE
  ) {
    return { key, cached: true };
  }

  const archive = await openVerifiedPackage(pkg);
  const xlsx = await readReportWorkbook(archive, pkg.periodKey);
  const summary = (await archive.file(PACKAGE_SUMMARY_ENTRY)?.async("string")) ?? "";
  const model = await buildPackageReportModel(xlsx, summary);
  const html = renderPackageReportHtml(model, { periodKey: pkg.periodKey, version: pkg.version, sha256: pkg.sha256 }, await deps.fontDataUri());
  let pdf: Buffer;
  try {
    pdf = await deps.renderPdf(html);
  } catch (e) {
    // Stage, browser source and the first line of the reason (sanitized: paths and flags, never content).
    console.error("[accountant] package PDF render failed", {
      businessId: pkg.businessId,
      periodKey: pkg.periodKey,
      stage: e instanceof PdfRenderError ? e.stage : "unknown",
      mode: e instanceof PdfRenderError ? e.mode : "unknown",
      error: e instanceof PdfRenderError ? e.detail : sanitizeRenderError(e),
    });
    throw new AccountantError(500, "PDF_RENDER_FAILED");
  }
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new AccountantError(500, "PDF_RENDER_FAILED");
  }

  await storage.putObject({
    key,
    body: pdf,
    contentType: PDF_CONTENT_TYPE,
    metadata: {
      businessId: pkg.businessId,
      domain: "exports",
      visibility: "private",
      custom: { sourceSha256: pkg.sha256, sha256: sha256Of(pdf), template: PACKAGE_PDF_TEMPLATE, kind: "accountant-report-pdf" },
    },
  });
  return { key, cached: false };
}
