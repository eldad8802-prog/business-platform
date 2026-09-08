import { NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import { getHistoricalRecord } from "@/lib/data-transfer/historical/historical-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

type Ctx = { params: Promise<{ id: string }> };

/**
 * One historical fiscal record — READ ONLY.
 *
 * # Why a missing record and another tenant's record answer the same
 *
 * Both are 404 with the same body. Distinguishing them — 403 for "exists but is
 * not yours", 404 for "no such thing" — would turn this route into an oracle
 * that confirms the existence of another business's documents to anyone willing
 * to count. The service returns `null` for both cases and this route cannot
 * tell them apart either.
 *
 * # Tenancy
 *
 * The business comes from the SESSION; the only thing the client supplies is a
 * record id, which is scoped by the tenant clause and by the row-level security
 * policy inside the read. There is no billing, payment, authority or customer
 * path reachable from here — this returns fiscal facts and the reversal
 * relationships the record already participates in.
 */
export async function GET(req: Request, ctx: Ctx) {
  const user = await getCurrentUser(req);
  if (!user) return authRequiredResponse(req);

  const { id } = await ctx.params;
  const recordId = Number(id);

  const notFound = () =>
    NextResponse.json(
      { error: "המסמך לא נמצא", code: "NOT_FOUND" },
      { status: 404, headers: NO_STORE }
    );

  if (!Number.isInteger(recordId) || recordId <= 0) return notFound();

  try {
    const record = await runWithTenantContext({ businessId: user.businessId }, () =>
      getHistoricalRecord(user.businessId, recordId)
    );

    if (!record) return notFound();

    return NextResponse.json({ ok: true, record }, { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error("[data-transfer/historical/records/:id] failed", {
      businessId: user.businessId,
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "טעינת המסמך נכשלה. נסו שוב מאוחר יותר.", code: "RECORD_FAILED" },
      { status: 500, headers: NO_STORE }
    );
  }
}
