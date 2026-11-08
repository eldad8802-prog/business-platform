/**
 * POST /api/business-documents/requests {operation} → {idempotencyKey}
 * A server-issued key for ONE operation, usable for 24 hours (see business-docs-requests.ts). Session + flag.
 */
import { NextResponse, type NextRequest } from "next/server";

import { bdTx } from "@/lib/services/business-documents/bd-tx";
import { businessDocumentsRoute, readJsonBody } from "@/lib/services/business-documents/business-documents-http";
import { issueRequestKey, REQUEST_OPERATIONS, type RequestOperation } from "@/lib/services/business-documents/requests/business-docs-requests";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return businessDocumentsRoute(req, async ({ businessId, userId }) => {
    const body = await readJsonBody(req, 1_000);
    const operation = body.operation;
    if (typeof operation !== "string" || !(REQUEST_OPERATIONS as readonly string[]).includes(operation)) {
      return NextResponse.json({ error: "VALIDATION", problems: [{ field: "operation", message: "פעולה לא מוכרת" }] }, { status: 400 });
    }
    const idempotencyKey = await bdTx(businessId, (tx) => issueRequestKey(tx, businessId, userId, operation as RequestOperation));
    return NextResponse.json({ idempotencyKey }, { status: 201, headers: { "Cache-Control": "no-store" } });
  });
}
