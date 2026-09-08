import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { buildHistoricalPreview } from "@/lib/data-transfer/historical/historical-preview";
import { runWithTenantContext } from "@/lib/tenant/context";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import type { DateFormatContract } from "@/lib/data-transfer/historical/historical-date";
import type { HistoricalDecisions } from "@/lib/data-transfer/historical/historical-decisions";
import type { ResolvedMapping } from "@/lib/data-transfer/import/mapping/mapping-proposer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Historical fiscal Preview: what confirming this file would actually do.
 *
 * # The two-call shape
 *
 * Called once with no decisions, it returns the server's defaults and says
 * which rows need the owner. Called again WITH those decisions, it re-derives
 * everything from the same bytes, validates each decision against freshly
 * computed truth, and signs a token only when the preview is genuinely ready.
 *
 * A signature proves a decision was not altered in transit. It does not prove
 * the decision was ever legitimate, which is why nothing here is trusted
 * because it arrived signed.
 *
 * # What the client may and may not supply
 *
 * It supplies what only the owner knows: the file, the sheet, the mapping, how
 * to read a textual date, and what they chose. It does NOT supply analysis
 * results — a body claiming `duplicate = NONE` is a claim about a fact the
 * server can check, so the server checks it by re-running the analysis.
 *
 * # Capability
 *
 * Its own route, like Analyze. The generic import routes gate on a list the
 * historical domain is deliberately absent from, so granting Preview here
 * grants nothing else — and there is no historical execute route to call.
 *
 * ZERO WRITES. Reads historical records to answer the duplicate question, and
 * nothing else; the preview itself is never stored, which is why the token is
 * stateless and the whole thing can be recomputed rather than looked up.
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

  const sheetRaw = form.get("sheet");
  const sheetName = typeof sheetRaw === "string" && sheetRaw ? sheetRaw : null;

  const dateRaw = form.get("dateFormat");
  const dateFormat: DateFormatContract =
    dateRaw === "DMY" || dateRaw === "MDY" ? dateRaw : null;

  const evidenceRaw = form.get("expectedEvidence");
  const expectedEvidenceFingerprint =
    typeof evidenceRaw === "string" && evidenceRaw ? evidenceRaw : null;

  // Mapping and decisions arrive as JSON. Anything unparseable is refused
  // rather than defaulted, because a silently-dropped mapping would produce a
  // preview of a file the owner did not describe.
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
  if (!mapping.ok || !decisions.ok) {
    return NextResponse.json(
      { error: "בקשה לא תקינה", code: "INVALID_BODY" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    // The tenant is the session's and is established before anything reads.
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      buildHistoricalPreview({
        businessId: user.businessId,
        userId: user.id,
        filename: typeof file.name === "string" ? file.name : "",
        bytes,
        sheetName,
        dateFormat,
        mapping: mapping.value,
        decisions: decisions.value,
        expectedEvidenceFingerprint,
      })
    );

    if (!result.ok) {
      const status =
        result.code === "TOO_MANY_ROWS"
          ? 413
          : result.code === "ANALYSIS_STALE"
            ? 409
            : 400;
      return NextResponse.json(result, { status, headers: NO_STORE });
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    // The error NAME only. A message could carry a cell value from the file.
    console.error("[data-transfer/import/historical/preview] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "בניית התצוגה המקדימה נכשלה. נסו שוב מאוחר יותר.", code: "PREVIEW_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
