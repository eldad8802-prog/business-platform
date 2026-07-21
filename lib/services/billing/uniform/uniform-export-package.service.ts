/**
 * Live uniform-export packaging (§2.2 files + §2.6/§5.4/summary reports) for a
 * date range. Thin, testable core over the existing pure pipeline:
 *   buildUniformExportFiles → renderUniformReports → zip.
 *
 * Business identity (name / VAT / address) is NOT taken from the software config
 * — it comes from the DB via the projection (loadUniformExportInput). The config
 * supplies only the SOFTWARE identity; its softwareRegistrationNumber (1006) and
 * vendorVatNumber (1009) are TEMPORARY pre-registration placeholders until a real
 * ITA registration number is issued.
 */

import archiver from "archiver";
import { PassThrough } from "node:stream";
import type { UniformExportProjection } from "@/lib/services/billing/uniform/uniform-export.types";
import type { UniformSoftwareConfig } from "@/lib/services/billing/uniform/uniform-config";
import {
  buildUniformExportFiles,
  type BuildOptions,
} from "@/lib/services/billing/uniform/uniform-file-builder";
import { renderUniformReports } from "@/lib/services/billing/uniform/uniform-report-render";
import { zipBkmvdata } from "@/lib/services/billing/uniform/uniform-packaging";

/** The exact set of entries the produced ZIP contains, in order. */
export const UNIFORM_ZIP_ENTRIES = [
  "INI.TXT",
  "BKMVDATA.TXT",
  "BKMVDATA.zip",
  "report-2.6.pdf",
  "report-5.4.pdf",
  "summary.pdf",
] as const;

export type UniformExportRange = { periodStart: string; periodEnd: string };
export type ParseRangeResult =
  | { ok: true; range: UniformExportRange }
  | { ok: false; error: "INVALID_DATE_FORMAT" | "INVALID_DATE" | "RANGE_INVERTED" };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates an explicit from/to (YYYY-MM-DD) range and normalizes it to an
 * inclusive ISO window [start 00:00:00, end 23:59:59.999]. Pure; no I/O.
 */
export function parseUniformExportRange(from: unknown, to: unknown): ParseRangeResult {
  const f = typeof from === "string" ? from.trim() : "";
  const t = typeof to === "string" ? to.trim() : "";
  if (!ISO_DATE.test(f) || !ISO_DATE.test(t)) return { ok: false, error: "INVALID_DATE_FORMAT" };
  const fd = new Date(`${f}T00:00:00.000Z`);
  const td = new Date(`${t}T23:59:59.999Z`);
  if (Number.isNaN(fd.getTime()) || Number.isNaN(td.getTime())) return { ok: false, error: "INVALID_DATE" };
  if (fd.getTime() > td.getTime()) return { ok: false, error: "RANGE_INVERTED" };
  return { ok: true, range: { periodStart: fd.toISOString(), periodEnd: td.toISOString() } };
}

/** Generates a 15-digit primary running id (field 1004) from a timestamp. */
export function makePrimaryId(nowMs: number): string {
  return String(Math.trunc(nowMs)).padStart(15, "0").slice(-15);
}

function collectArchive(archive: archiver.Archiver): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => chunks.push(c));
    sink.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    archive.pipe(sink);
  });
}

export type UniformExportZipResult = {
  zip: Buffer;
  totalBkmvRecords: number;
  entries: readonly string[];
};

/**
 * Builds the full uniform-export ZIP (INI.TXT + BKMVDATA.TXT + BKMVDATA.zip +
 * report-2.6.pdf + report-5.4.pdf + summary.pdf) from an already-assembled
 * projection. Pure over its inputs (no DB/env); the caller loads the projection.
 */
export async function buildUniformExportZip(
  proj: UniformExportProjection,
  config: UniformSoftwareConfig,
  opts: Required<Pick<BuildOptions, "primaryId" | "generatedAt">>
): Promise<UniformExportZipResult> {
  const built = buildUniformExportFiles(proj, config, opts);
  const pdfs = await renderUniformReports(proj, built, config);
  const bkmvZip = await zipBkmvdata(built.bkmvdataBuffer);

  const archive = archiver("zip", { zlib: { level: 9 } });
  const done = collectArchive(archive);
  archive.append(built.iniBuffer, { name: "INI.TXT" });
  archive.append(built.bkmvdataBuffer, { name: "BKMVDATA.TXT" });
  archive.append(bkmvZip, { name: "BKMVDATA.zip" });
  archive.append(pdfs.report26Pdf, { name: "report-2.6.pdf" });
  archive.append(pdfs.report54Pdf, { name: "report-5.4.pdf" });
  archive.append(pdfs.summaryPdf, { name: "summary.pdf" });
  await archive.finalize();

  return { zip: await done, totalBkmvRecords: built.meta.totalBkmvRecords, entries: UNIFORM_ZIP_ENTRIES };
}
