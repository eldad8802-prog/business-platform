import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  listHistoricalRecords,
  HISTORICAL_RECORDS_MAX_PAGE,
} from "@/lib/data-transfer/historical/historical-records";
import { HISTORICAL_DOCUMENT_TYPES } from "@/lib/data-transfer/historical/historical-vocabulary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** Longest a filter value may be. A document number is a label, not an essay. */
const MAX_FILTER_LENGTH = 64;

/**
 * The business's historical fiscal records — READ ONLY.
 *
 * # What is not here
 *
 * No POST, PATCH, PUT or DELETE, and no service beneath this route that could
 * perform one. Historical records are evidence that another system issued a
 * document; there is nothing about them for Dubiz to change, and the table has
 * no UPDATE policy and no UPDATE grant in production to change them with.
 *
 * There is likewise no billing action reachable from here. A historical record
 * is not a Dubiz document: it cannot be sent, reissued, cancelled, credited
 * through Dubiz, allocated a payment, submitted to the tax authority, renumbered
 * or re-rendered as a Dubiz PDF. This route exposes reading, and reading only.
 *
 * # Tenancy
 *
 * The business comes from the SESSION. Every filter below is a fiscal
 * predicate — type, source system, number, date range — and none of them names
 * a business; there is no field, header or query parameter by which a caller
 * could ask for another tenant's history. The read runs inside the tenant
 * context, so the row-level security policy evaluates a GUC the client never
 * touched.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  const params = new URL(req.url).searchParams;

  /** A short, trimmed filter value, or null. Never echoed back on failure. */
  const text = (key: string): string | null => {
    const raw = params.get(key);
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.length > MAX_FILTER_LENGTH) return null;
    return trimmed;
  };

  // An unrecognised type becomes "no filter" rather than an error: the closed
  // vocabulary is the server's, and a stale bookmark should show the whole
  // history rather than a failure the owner cannot act on.
  const typeRaw = text("type");
  const documentTypeCode =
    typeRaw && (HISTORICAL_DOCUMENT_TYPES as readonly string[]).includes(typeRaw)
      ? typeRaw
      : null;

  const pageRaw = Number(params.get("page"));
  const page =
    Number.isInteger(pageRaw) && pageRaw >= 1
      ? Math.min(pageRaw, HISTORICAL_RECORDS_MAX_PAGE)
      : 1;

  try {
    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      listHistoricalRecords(user.businessId, {
        page,
        filters: {
          documentTypeCode,
          sourceSystemCode: text("source"),
          originalDocumentNumber: text("number"),
          issuedFrom: text("from"),
          issuedTo: text("to"),
        },
      })
    );

    return NextResponse.json({ ok: true, ...result }, { status: 200, headers: NO_STORE });
  } catch (error) {
    // The error NAME only. A message could carry a filter value, and a filter
    // value can be a customer's invoice number.
    console.error("[data-transfer/historical/records] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "טעינת ההיסטוריה נכשלה. נסו שוב מאוחר יותר.", code: "RECORDS_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
