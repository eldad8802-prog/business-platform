import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";
import {
  buildDocumentsExport,
  DocumentsExportTooLargeError,
  NoDocumentsToExportError,
} from "@/lib/data-transfer/documents/documents-export";

// archiver and ExcelJS are Node-only (Buffer, streams). Pinning the runtime is
// mandatory, not incidental.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Must stay a LITERAL — Next validates route-segment config by static analysis.
 *
 * Reading up to 300 originals out of object storage and assembling one archive
 * is the same class of work as the accountant pack and the tabular export, and
 * carries the same budget.
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** `YYYY-MM-DD` from the client, or nothing. Anything else is a bad request. */
function parseDay(value: unknown, endOfDay: boolean): Date | null | "INVALID" {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "INVALID";
  }
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? "INVALID" : date;
}

/**
 * הגדרות → ייבוא וייצוא → ייבוא מסמכים → ייצוא.
 *
 * Hands back a ZIP of the original files plus a Hebrew index describing them.
 *
 * POST rather than GET because the selection is a body, and because a GET URL
 * carrying it would sit in browser history and proxy logs for a response that
 * is the tenant's entire document archive.
 *
 * # Tenant
 *
 * `businessId` comes from the SESSION and nowhere else. The body may carry a
 * date range and nothing more — there is no business, table, column or limit
 * field to supply. Every read runs tenant-scoped, and each storage path is
 * rebuilt from the authenticated business rather than from anything stored.
 *
 * # Read-only
 *
 * Nothing in this handler or anything it calls writes a row or an object.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  // Assembling an archive of originals is expensive to serve. Gate it before
  // the body is read, and fail closed.
  const decision = await checkRateLimit({
    bucket: "DATA_TRANSFER_DOCUMENTS_IMPORT",
    user: user.id,
    business: user.businessId,
    ip: getClientIp(req),
  });
  if (!decision.allowed) return buildRateLimitResponse(decision);

  let body: Record<string, unknown> = {};
  try {
    const parsed = await req.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const from = parseDay(body.from, false);
  const to = parseDay(body.to, true);
  if (from === "INVALID" || to === "INVALID") {
    return NextResponse.json(
      { error: "טווח התאריכים אינו תקין", code: "INVALID_RANGE" },
      { status: 400, headers: NO_STORE }
    );
  }
  if (from && to && from > to) {
    return NextResponse.json(
      { error: "תאריך ההתחלה מאוחר מתאריך הסיום", code: "INVALID_RANGE" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const artifact = await buildDocumentsExport({
      // Server-derived. There is no businessId field in this request.
      businessId: user.businessId,
      filter: { from, to },
    });

    return new NextResponse(new Uint8Array(artifact.body), {
      status: 200,
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${artifact.filename}"`,
        "Content-Length": String(artifact.body.length),
        "X-Documents-Total": String(artifact.summary.total),
        "X-Documents-Included": String(artifact.summary.included),
        "X-Documents-Missing": String(artifact.summary.missing),
        ...NO_STORE,
      },
    });
  } catch (error) {
    if (error instanceof NoDocumentsToExportError) {
      return NextResponse.json(
        { error: "אין מסמכים לייצוא בטווח שנבחר.", code: "NO_DOCUMENTS" },
        { status: 400, headers: NO_STORE }
      );
    }
    if (error instanceof DocumentsExportTooLargeError) {
      return NextResponse.json(
        { error: error.message, code: error.reason },
        { status: 413, headers: NO_STORE }
      );
    }
    // Never echo the thrown message: it can carry a filename or a storage key.
    console.error("[data-transfer/documents/export] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "ייצוא המסמכים נכשל. נסו שוב מאוחר יותר.", code: "EXPORT_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
