import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { isExportableDomainId } from "@/lib/data-transfer/export/export-registry";
import { analyzeImportSource } from "@/lib/data-transfer/import/preview/preview-orchestrator";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Step 1 of the Import dry run: what is in this file, and how would we map it?
 *
 * Reads NO tenant data. It answers a question about the upload, not about the
 * business — the collision check happens at preview, where it is scoped.
 *
 * The route is thin on purpose: authenticate, enforce the hard limits, hand the
 * bytes to the orchestrator. The flow itself lives in one place.
 *
 * ZERO WRITES: nothing here or downstream creates or updates business data.
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

  // The tenant is the session's. `domain` and `sheet` are the only client
  // choices, and both are re-validated.
  const domain = form.get("domain");
  if (!isExportableDomainId(domain)) {
    return NextResponse.json(
      { error: "תחום לא נתמך לייבוא", code: "UNKNOWN_DOMAIN" },
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
  if (typeof file.size === "number" && file.size > IMPORT_MAX_FILE_BYTES) {
    const mb = Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
    return NextResponse.json(
      { error: `הקובץ גדול מדי (עד ${mb}MB)`, code: "FILE_TOO_LARGE" },
      { status: 413, headers: NO_STORE }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  // Re-checked against the ACTUAL bytes: `file.size` is client-reported.
  if (bytes.length > IMPORT_MAX_FILE_BYTES) {
    const mb = Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
    return NextResponse.json(
      { error: `הקובץ גדול מדי (עד ${mb}MB)`, code: "FILE_TOO_LARGE" },
      { status: 413, headers: NO_STORE }
    );
  }

  const sheetRaw = form.get("sheet");
  const sheetName = typeof sheetRaw === "string" && sheetRaw ? sheetRaw : null;

  try {
    const result = await analyzeImportSource({
      domainId: domain,
      filename: typeof file.name === "string" ? file.name : "",
      bytes,
      sheetName,
    });

    if (!result.ok) {
      const status = result.code === "TOO_MANY_ROWS" ? 413 : 400;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error("[data-transfer/import/analyze] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "ניתוח הקובץ נכשל. נסו שוב מאוחר יותר.", code: "ANALYZE_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
