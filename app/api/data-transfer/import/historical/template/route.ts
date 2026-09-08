import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { buildHistoricalImportTemplate } from "@/lib/data-transfer/historical/historical-template";

// ExcelJS is Node-only (Buffer, streams).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * הגדרות → ייבוא וייצוא → היסטוריה ממערכת קודמת → התבנית.
 *
 * # Why this is not the shared template route
 *
 * `/api/data-transfer/template` takes a domain from the client and gates it on
 * `isTemplateDomainId`, which is `isExportableDomainId` — the same predicate the
 * generic analyze, preview and execute routes gate on. Teaching that route the
 * historical domain would mean widening that predicate, and widening it hands
 * the domain to three routes that must never serve it.
 *
 * So this route takes NO domain. It serves exactly one artifact, the shape of
 * the code is the capability, and the generic routes keep refusing the domain
 * exactly as the foundation verifier asserts they must.
 *
 * # Authentication vs. tenancy
 *
 * A session is required because this is part of the authenticated app, but
 * GENERATION IS TENANT-INDEPENDENT: no query runs, no tenant table is touched,
 * and neither businessId nor userId reaches the file. Two businesses asking on
 * the same day get byte-identical output — the property the contract verifier
 * already asserts for `buildHistoricalImportTemplate`.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return authRequiredResponse(req);
  }

  try {
    const template = await buildHistoricalImportTemplate(new Date());

    return new Response(new Uint8Array(template.body), {
      headers: {
        "Content-Type": template.contentType,
        // ASCII by construction (fixed slug + date) — no owner text reaches
        // this header.
        "Content-Disposition": `attachment; filename="${template.filename}"`,
        "Content-Length": String(template.body.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[data-transfer/import/historical/template] failed", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "יצירת התבנית נכשלה. נסו שוב מאוחר יותר." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
