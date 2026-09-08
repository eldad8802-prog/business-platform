import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { analyzeHistoricalSourceWithDuplicates } from "@/lib/data-transfer/historical/historical-analyze-duplicates";
import { runWithTenantContext } from "@/lib/tenant/context";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import type { DateFormatContract } from "@/lib/data-transfer/historical/historical-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Historical fiscal Analyze: what is in this file, and how would we read it?
 *
 * # Why this is its own route and not the generic one
 *
 * The generic import routes — analyze, preview and execute — all gate on the
 * SAME predicate, `isExportableDomainId`. Adding the historical domain to that
 * list to obtain Analyze would have handed Preview and Execute the domain in
 * the same move, and neither exists yet. A separate route grants exactly one
 * capability, and the shape of the code is what enforces it: there is no
 * historical preview route and no historical execute route to call.
 *
 * # What it does not do
 *
 * ZERO WRITES. No record, no import run, no marker, no document, no customer,
 * no billing. It reads historical records to answer "does this business already
 * hold this document" and nothing else — no create, update, upsert or delete
 * anywhere on the path.
 *
 * # Tenancy
 *
 * I-8B.3 gave this route its first database read, so the tenant boundary now
 * carries weight. The business comes from the SESSION and is established as
 * tenant context before the read; the read itself runs inside
 * `withTenantTransaction`, which sets the `app.current_business_id` GUC that
 * row-level security evaluates. Application `where` clauses are defence in
 * depth, not the boundary.
 *
 * There is no field, header or query parameter by which a caller could name a
 * business.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "בקשה לא תקינה", code: "INVALID_BODY" },
      { status: 400, headers: NO_STORE }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "לא נבחר קובץ", code: "FILE_MISSING" },
      { status: 400, headers: NO_STORE }
    );
  }

  // Declared size first — cheap, and refuses an oversized upload before it is
  // materialized into memory.
  const tooLarge = () => {
    const mb = Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
    return NextResponse.json(
      { error: `הקובץ גדול מדי (עד ${mb}MB)`, code: "FILE_TOO_LARGE" },
      { status: 413, headers: NO_STORE }
    );
  };
  if (typeof file.size === "number" && file.size > IMPORT_MAX_FILE_BYTES) {
    return tooLarge();
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Re-checked against the ACTUAL bytes: `file.size` is client-reported.
  if (bytes.length > IMPORT_MAX_FILE_BYTES) return tooLarge();

  const sheetRaw = form.get("sheet");
  const sheetName = typeof sheetRaw === "string" && sheetRaw ? sheetRaw : null;

  // The owner's date-format choice, and the ONLY values accepted for it. An
  // unrecognised value becomes "not stated", which makes ambiguous dates fail
  // loudly rather than being read under something the owner never chose.
  const dateRaw = form.get("dateFormat");
  const dateFormat: DateFormatContract =
    dateRaw === "DMY" || dateRaw === "MDY" ? dateRaw : null;

  try {
    // The tenant is established from the session and never from the request.
    // Everything the read touches happens inside this scope.
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      analyzeHistoricalSourceWithDuplicates(user.businessId, {
        filename: typeof file.name === "string" ? file.name : "",
        bytes,
        sheetName,
        dateFormat,
      })
    );

    if (!result.ok) {
      const status = result.code === "TOO_MANY_ROWS" ? 413 : 400;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    // The error NAME only. A message could carry a cell value from the file,
    // and an analysis log is not a place for a customer's invoice.
    console.error("[data-transfer/import/historical/analyze] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "ניתוח הקובץ נכשל. נסו שוב מאוחר יותר.", code: "ANALYZE_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
