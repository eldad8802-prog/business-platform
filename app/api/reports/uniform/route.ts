/**
 * Live "מבנה אחיד" (uniform-file) export for an explicit date range.
 *
 * Auth-gated (getCurrentUser) and tenant-isolated: the export is scoped to the
 * caller's businessId only — `from`/`to` are the ONLY client inputs. Returns a
 * ZIP with INI.TXT, BKMVDATA.TXT, BKMVDATA.zip, report-2.6.pdf, report-5.4.pdf,
 * and summary.pdf.
 *
 * Business identity (name / VAT / address) is loaded from the DB (via the loader
 * + projection). The software config (DUBIZ_SOFTWARE_CONFIG) supplies only the
 * SOFTWARE identity: official ITA registration number (1006 = 270901), vendor
 * entity number (1009 = 312260110) and vendor name (1010).
 */

import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { loadUniformExportInput } from "@/lib/services/billing/uniform/uniform-export-loader";
import { assembleUniformExportProjection } from "@/lib/services/billing/uniform/uniform-export-assembler";
import { DUBIZ_SOFTWARE_CONFIG } from "@/lib/services/billing/uniform/uniform-config";
import {
  buildUniformExportZip,
  makePrimaryId,
  parseUniformExportRange,
} from "@/lib/services/billing/uniform/uniform-export-package.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  const { searchParams } = new URL(req.url);
  const parsed = parseUniformExportRange(searchParams.get("from"), searchParams.get("to"));
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  try {
    const input = await loadUniformExportInput({
      businessId: user.businessId,
      periodStart: parsed.range.periodStart,
      periodEnd: parsed.range.periodEnd,
    });
    const projection = assembleUniformExportProjection(input);

    const result = await buildUniformExportZip(projection, DUBIZ_SOFTWARE_CONFIG, {
      primaryId: makePrimaryId(Date.now()),
      generatedAt: new Date().toISOString(),
    });

    return new Response(result.zip as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=uniform-export.zip",
      },
    });
  } catch (error) {
    console.error("uniform-export failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ error: "EXPORT_FAILED" }, 500);
  }
}
