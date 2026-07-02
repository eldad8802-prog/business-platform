/**
 * WP3 — orchestration: projection + WP2 build result → the 3 registration
 * report docDefinitions (pure), and their rendered PDF buffers.
 *
 * pdfmake is NOT imported here — rendering delegates to the canonical
 * `renderPdfFromDocDefinition` (the only sanctioned pdfmake importer + Hebrew
 * font). Everything else stays under lib/services/billing/uniform/.
 */

import { renderPdfFromDocDefinition } from "@/lib/services/billing/pdf/billing-pdf-renderer";
import type { UniformExportProjection } from "@/lib/services/billing/uniform/uniform-export.types";
import type { UniformBuildResult } from "@/lib/services/billing/uniform/uniform-file-builder";
import type { UniformSoftwareConfig } from "@/lib/services/billing/uniform/uniform-config";
import {
  buildReport26Data,
  buildReport54Data,
  buildSummaryData,
  type Report26Data,
  type Report54Data,
  type SummaryData,
} from "@/lib/services/billing/uniform/uniform-report-data";
import { buildReport26DocDefinition } from "@/lib/services/billing/uniform/uniform-report-2_6";
import { buildReport54DocDefinition } from "@/lib/services/billing/uniform/uniform-report-5_4";
import { buildSummaryDocDefinition } from "@/lib/services/billing/uniform/uniform-report-summary";

export type UniformReportDocDefinitions = {
  report26: Record<string, unknown>;
  report54: Record<string, unknown>;
  summary: Record<string, unknown>;
  data: { report26: Report26Data; report54: Report54Data; summary: SummaryData };
};

/** Pure: build the three report docDefinitions (deterministic over inputs). */
export function buildUniformReportDocDefinitions(
  proj: UniformExportProjection,
  buildResult: UniformBuildResult,
  config: UniformSoftwareConfig
): UniformReportDocDefinitions {
  const d26 = buildReport26Data(proj, buildResult.meta);
  const d54 = buildReport54Data(proj, buildResult.meta, config);
  const dsum = buildSummaryData(proj, buildResult.meta, config);
  return {
    report26: buildReport26DocDefinition(d26),
    report54: buildReport54DocDefinition(d54),
    summary: buildSummaryDocDefinition(dsum),
    data: { report26: d26, report54: d54, summary: dsum },
  };
}

export type UniformReportPdfs = {
  report26Pdf: Buffer;
  report54Pdf: Buffer;
  summaryPdf: Buffer;
};

/** Render all three reports to PDF buffers via the canonical renderer. */
export async function renderUniformReports(
  proj: UniformExportProjection,
  buildResult: UniformBuildResult,
  config: UniformSoftwareConfig
): Promise<UniformReportPdfs> {
  const defs = buildUniformReportDocDefinitions(proj, buildResult, config);
  const [report26Pdf, report54Pdf, summaryPdf] = await Promise.all([
    renderPdfFromDocDefinition(defs.report26),
    renderPdfFromDocDefinition(defs.report54),
    renderPdfFromDocDefinition(defs.summary),
  ]);
  return { report26Pdf, report54Pdf, summaryPdf };
}
