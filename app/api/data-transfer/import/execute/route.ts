import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { isExportableDomainId } from "@/lib/data-transfer/export/export-registry";
import { executeImport } from "@/lib/data-transfer/import/execute/import-executor";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/data-transfer/import/import-config";
import {
  ROW_ACTIONS,
  type RowDecisions,
} from "@/lib/data-transfer/import/execute/row-decisions";
import type { ResolvedMapping } from "@/lib/data-transfer/import/mapping/mapping-proposer";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { buildRateLimitResponse } from "@/lib/security/rate-limiter/http";
import { getClientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Must stay a LITERAL — Next validates route-segment config statically. */
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * The one endpoint that writes imported records.
 *
 * The file is sent again, with the mapping, the decisions and the attestation
 * from the preview. Nothing about the run is remembered between the two calls —
 * the attestation is what proves they belong together, and the executor
 * re-derives every row from the bytes rather than trusting anything here.
 *
 * # Replay is safe by construction
 *
 * A retried or duplicated request resolves to the ImportRun that already exists
 * (unique on business + file + mapping + decisions) and re-executes only the
 * rows that have no marker. So a lost response, a double-click and a network
 * retry all produce the same records as a single call.
 *
 * # Authorization
 *
 * Any authenticated user of the business may import, per the owner's decision
 * for this wave. The tenant is server-derived from the session and appears
 * nowhere in the request body; a token minted for another business is rejected
 * by the executor before any row is read.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  // Before the body is read: a rejected request should cost nothing to serve.
  const decision = await checkRateLimit({
    bucket: "DATA_TRANSFER_IMPORT_EXECUTE",
    user: user.id,
    business: user.businessId,
    ip: getClientIp(req),
  });
  if (!decision.allowed) return buildRateLimitResponse(decision);

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

  const previewToken = form.get("previewToken");
  if (typeof previewToken !== "string" || previewToken.length === 0) {
    return NextResponse.json(
      { error: "חסר אישור בדיקה. יש להריץ בדיקה מחדש.", code: "TOKEN_MISSING" },
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

  // Shape only. Whether each decision is LEGITIMATE for its row is re-decided
  // by the executor against freshly derived rows — a client cannot grant itself
  // a CREATE the server would not offer.
  let decisions: RowDecisions;
  try {
    const raw = form.get("decisions");
    const parsed = typeof raw === "string" ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("decisions must be an object");
    }
    decisions = {};
    for (const [key, value] of Object.entries(parsed)) {
      const rowNumber = Number(key);
      if (!Number.isInteger(rowNumber) || rowNumber < 1) {
        throw new Error("row number");
      }
      if (
        typeof value !== "string" ||
        !(ROW_ACTIONS as readonly string[]).includes(value)
      ) {
        throw new Error("action");
      }
      decisions[rowNumber] = value as RowDecisions[number];
    }
  } catch {
    return NextResponse.json(
      { error: "הבחירות אינן תקינות", code: "DECISIONS_MALFORMED" },
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
    const result = await executeImport({
      // Server-derived. There is no businessId field in this request.
      businessId: user.businessId,
      userId: user.id,
      domainId: domain,
      filename: typeof file.name === "string" ? file.name : "",
      bytes,
      sheetName,
      mapping,
      decisions,
      previewToken,
    });

    if (!result.ok) {
      // Every one of these means "re-run the check", not "the server broke".
      return NextResponse.json(result, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    // Never echo the thrown message: it can carry a row value.
    console.error("[data-transfer/import/execute] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        error:
          "הייבוא נכשל. אם חלק מהשורות כבר נוצרו, הרצה חוזרת של אותו קובץ תשלים רק את מה שחסר.",
        code: "EXECUTE_FAILED",
      },
      { status: 500, headers: NO_STORE }
    );
  }
}
