import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { isExportableDomainId } from "@/lib/data-transfer/export/export-registry";
import { buildImportPreview } from "@/lib/data-transfer/import/preview/preview-orchestrator";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import type { ResolvedMapping } from "@/lib/data-transfer/import/mapping/mapping-proposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Step 2 of the Import dry run: the full check, and the signed attestation.
 *
 * The file is sent AGAIN rather than remembered between the two calls. That is
 * the deliberate consequence of holding no server-side preview state: nothing
 * to store, nothing to expire, nothing to leak — and the attestation binds the
 * exact bytes, so I-6 can prove it is the same file.
 *
 * # What the client may decide, and what it may not
 *
 * May: the domain, the sheet, the mapping. All three are re-validated here.
 * May NOT: the tenant, the row values, the row count, the content hash, the
 * validation outcome, the duplicate verdicts, or anything inside the token.
 * Every one of those is recomputed from the bytes by the orchestrator.
 *
 * ZERO WRITES: the only DB access downstream is the read-only, tenant-scoped
 * duplicate lookup.
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
  if (typeof file.size === "number" && file.size > IMPORT_MAX_FILE_BYTES) {
    const mb = Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024);
    return NextResponse.json(
      { error: `הקובץ גדול מדי (עד ${mb}MB)`, code: "FILE_TOO_LARGE" },
      { status: 413, headers: NO_STORE }
    );
  }

  // The mapping is a source-column-index -> field-label object. It is parsed
  // defensively and then FULLY re-validated against the domain downstream; a
  // shape check here only keeps garbage out of the orchestrator.
  let mapping: ResolvedMapping;
  try {
    const raw = form.get("mapping");
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("mapping must be an object");
    }
    mapping = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new Error("mapping value");
      mapping[Number(key)] = value;
    }
  } catch {
    return NextResponse.json(
      { error: "התאמת העמודות אינה תקינה", code: "MAPPING_INVALID" },
      { status: 400, headers: NO_STORE }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
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
    const result = await buildImportPreview({
      // Server-derived. There is no businessId field in this request.
      businessId: user.businessId,
      userId: user.id,
      domainId: domain,
      filename: typeof file.name === "string" ? file.name : "",
      bytes,
      sheetName,
      mapping,
    });

    if (!result.ok) {
      const status = result.code === "TOO_MANY_ROWS" ? 413 : 400;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error("[data-transfer/import/preview] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "בדיקת הקובץ נכשלה. נסו שוב מאוחר יותר.", code: "PREVIEW_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
