/**
 * 4a T3 — the VAT review of a draft created before "מעבר לעוסק מורשה".
 *   GET  → the review state (required / reviewed / fingerprint / the lines with their VAT rates)
 *   POST { fingerprint } → the owner's explicit confirmation of exactly that content (409 if it changed meanwhile)
 * A business without a transition always gets { required: false }. Nothing here changes a rate, price or amount.
 */
import { NextRequest, NextResponse } from "next/server";

import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { ValidationError } from "@/lib/errors";
import { handleError } from "@/lib/handle-error";
import { confirmDraftVatReview, readDraftVatReview } from "@/lib/services/billing/kind-transition/draft-vat-review.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(value: string): number {
  const n = Number(value);
  if (!n || !Number.isInteger(n) || n <= 0) throw new ValidationError("Invalid billing document id");
  return n;
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const state = await readDraftVatReview({ businessId: user.businessId, billingDocumentId: parseId(id) });
    return NextResponse.json(state, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);
    const { id } = await context.params;
    const body = (await req.json().catch(() => null)) as { fingerprint?: unknown } | null;
    const state = await confirmDraftVatReview({ businessId: user.businessId, actorUserId: user.id, billingDocumentId: parseId(id), fingerprint: body?.fingerprint });
    return NextResponse.json(state, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
