import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import {
  buildImportTemplate,
  isTemplateDomainId,
} from "@/lib/data-transfer/templates/template-builder";

// ExcelJS is Node-only (Buffer, streams).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * הגדרות → ייבוא וייצוא → תבניות.
 *
 * GET, unlike the export endpoint: a template is a deterministic artifact of a
 * domain id and today's date. It contains no business data, so there is nothing
 * that must be kept out of a URL, and a plain link is the simplest thing that
 * works.
 *
 * # Authentication vs. tenancy
 *
 * The route requires a session because it is part of the authenticated app —
 * but GENERATION IS TENANT-INDEPENDENT. No query runs, no tenant table is
 * touched, no businessId or userId reaches the file. Two different businesses
 * asking for the same template on the same day get byte-identical output, which
 * is asserted in the verifier: if that ever stopped being true, it would mean
 * the generator had started reading tenant data.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return authRequiredResponse(req);
  }

  const domain = new URL(req.url).searchParams.get("domain");

  if (!isTemplateDomainId(domain)) {
    // Do not echo the requested value back into the response.
    return NextResponse.json(
      { error: "אין תבנית לתחום המבוקש", code: "UNKNOWN_DOMAIN" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    const template = await buildImportTemplate(domain, new Date());

    return new Response(new Uint8Array(template.body), {
      headers: {
        "Content-Type": template.contentType,
        // ASCII by construction (fixed slug + date) — no owner text reaches
        // this header.
        "Content-Disposition": `attachment; filename="${template.filename}"`,
        "Content-Length": String(template.body.byteLength),
        // The template holds no business data, but it is served from an
        // authenticated route; keeping it out of shared caches costs nothing
        // and keeps one rule for every download in this Center.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("[data-transfer/template] failed", {
      domain,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "יצירת התבנית נכשלה. נסו שוב מאוחר יותר." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
