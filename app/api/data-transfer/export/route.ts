import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { parseExportRequest } from "@/lib/data-transfer/export/export-request";
import {
  ExportTooLargeError,
  readSelectedDomains,
} from "@/lib/data-transfer/export/export-runner";
import { buildExportArtifact } from "@/lib/data-transfer/export/export-package";

// ExcelJS and archiver are Node-only (Buffer, streams). Pinning the runtime is
// mandatory, not incidental.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Must stay a LITERAL. Next validates route-segment config by static analysis
 * and rejects an imported constant here ("Invalid segment configuration export
 * detected"), so this one number cannot live in `export-config.ts` with the
 * others. It is kept in step by the export verifier, which reads this file and
 * asserts the literal equals `EXPORT_MAX_DURATION_SECONDS`.
 */
export const maxDuration = 60;

/**
 * הגדרות → ייבוא וייצוא → ייצוא.
 *
 * POST because the selection is a body, not a bookmarkable address — and
 * because a GET URL carrying the selection would end up in browser history,
 * proxy logs and referrers for a response that is the tenant's whole customer
 * list.
 *
 * # Tenant
 *
 * `businessId` comes from the SESSION and nowhere else. The request body may
 * name domains and a format; it may not name a business, a table, a column or a
 * row limit. `getCurrentUser` already fails closed for a deleted business, and
 * every read runs inside `runWithTenantContext` -> tenant transaction -> RLS.
 *
 * # Caching
 *
 * `private, no-store`. This response is the tenant's customer, supplier, lead
 * and inventory data; it must not sit in a shared cache, a CDN, or the browser's
 * disk cache after logout.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return authRequiredResponse(req);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const parsed = parseExportRequest(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.message, code: parsed.code },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  try {
    // Server-derived tenant. Never `body.businessId` — there is no such field.
    const tables = await readSelectedDomains(
      user.businessId,
      parsed.request.domains
    );

    const artifact = await buildExportArtifact(
      tables,
      parsed.request.format,
      new Date()
    );

    return new Response(new Uint8Array(artifact.body), {
      headers: {
        "Content-Type": artifact.contentType,
        // Filenames are ASCII by construction (fixed slug + date), so no
        // RFC 5987 escaping is needed and no owner-controlled text reaches
        // this header.
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Content-Length": String(artifact.body.byteLength),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ExportTooLargeError) {
      return NextResponse.json(
        {
          error:
            "כמות הנתונים גדולה מדי לייצוא אחד. בחר פחות תחומים ונסה שוב.",
          code: error.code,
        },
        { status: 413, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    console.error("[data-transfer/export] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "הייצוא נכשל. נסה שוב מאוחר יותר." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
