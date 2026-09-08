import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { executeHistoricalImport } from "@/lib/data-transfer/historical/historical-execute";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import type { DateFormatContract } from "@/lib/data-transfer/historical/historical-date";
import type { HistoricalDecisions } from "@/lib/data-transfer/historical/historical-decisions";
import type { ResolvedMapping } from "@/lib/data-transfer/import/mapping/mapping-proposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Must stay a LITERAL — Next validates route-segment config statically. Longer
 * than analyze and preview because this one writes, a row at a time.
 */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Historical fiscal Execute: write what the owner approved.
 *
 * # Nothing here is trusted because it arrived
 *
 * The signed preview token attests that a specific owner approved a specific
 * set of decisions against a specific file and a specific database state. It
 * carries hashes and counts, never values — so the whole analysis is re-derived
 * from the bytes and compared against what was approved. A body claiming a row
 * is a duplicate, or naming a reversal target id, is not evidence and is not
 * read.
 *
 * # Its own route, like the other two
 *
 * The generic import routes gate on a list this domain is deliberately absent
 * from. Granting execution here grants nothing generic, and the six tabular
 * domains behave exactly as they did.
 *
 * # What it may write
 *
 * `HistoricalFiscalDocument` inserts, and the execution ledger. Nothing else:
 * no customer, no document, no billing, no financial event, no payment. The
 * historical table has no UPDATE path at all, by design, so a record is written
 * once and never revised.
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

  const previewToken = form.get("previewToken");
  if (typeof previewToken !== "string" || previewToken === "") {
    return NextResponse.json(
      { error: "חסר אישור התצוגה המקדימה", code: "TOKEN_MISSING" },
      { status: 400, headers: NO_STORE }
    );
  }

  const sheetRaw = form.get("sheet");
  const sheetName = typeof sheetRaw === "string" && sheetRaw ? sheetRaw : null;

  const dateRaw = form.get("dateFormat");
  const dateFormat: DateFormatContract =
    dateRaw === "DMY" || dateRaw === "MDY" ? dateRaw : null;

  const parseJson = <T,>(field: string): { ok: true; value: T | null } | { ok: false } => {
    const raw = form.get(field);
    if (typeof raw !== "string" || raw === "") return { ok: true, value: null };
    try {
      return { ok: true, value: JSON.parse(raw) as T };
    } catch {
      return { ok: false };
    }
  };

  const mapping = parseJson<ResolvedMapping>("mapping");
  const decisions = parseJson<HistoricalDecisions>("decisions");
  if (!mapping.ok || !decisions.ok || !decisions.value) {
    return NextResponse.json(
      { error: "בקשה לא תקינה", code: "INVALID_BODY" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    // The tenant and the user come from the SESSION. The token is checked
    // against them, so an approval belonging to somebody else cannot run here.
    const result = await executeHistoricalImport({
      businessId: user.businessId,
      userId: user.id,
      filename: typeof file.name === "string" ? file.name : "",
      bytes,
      sheetName,
      dateFormat,
      mapping: mapping.value,
      decisions: decisions.value,
      previewToken,
    });

    if (!result.ok) {
      const status =
        result.code === "PREVIEW_STALE" || result.code === "DECISION_CHANGED"
          ? 409
          : result.code === "TOKEN_EXPIRED" || result.code === "TOKEN_INVALID"
            ? 401
            : 400;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    // The error NAME only. A message could carry a cell value from the file.
    console.error("[data-transfer/import/historical/execute] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "הייבוא נכשל. נסו שוב מאוחר יותר.", code: "EXECUTE_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
