/**
 * GET /api/billing/kind-transition/interim-documents — 4a T4 (read only). Contract for the legal identity screens (f3):
 * .billing-4a/T4-INTERIM-DOCUMENTS-CONTRACT.md.
 *
 *   ?from=YYYY-MM-DD   the official status date the owner picked (required until a transition exists; ignored after)
 *   &list=1            also return one page of the documents (50 at most)
 *   &cursor=…          the previous page's nextCursor
 *
 * Flag OFF (BUSINESS_KIND_TRANSITION_ENABLED ≠ "true") → 404 before anything else, as for every transition route.
 * Bearer session only; the business is the session's; the read runs in the business's tenant transaction (FORCE RLS).
 */
import { NextResponse } from "next/server";

import { authRequiredResponse, getAuthContext } from "@/lib/auth";
import { isBusinessKindTransitionEnabled } from "@/lib/legal-identity/kind-transition-flag";
import { billingTenantTx } from "@/lib/services/billing/billing-tenant-tx";
import { readInterimDocumentsTx, validateInterimFromDate, parseCursor } from "@/lib/services/billing/kind-transition/interim-documents";

const noStore = { "cache-control": "no-store" };

export type InterimDocumentsDeps = {
  enabled: () => boolean;
  context: (req: Request) => Promise<{ user: { id: number; businessId: number } } | null>;
  read: (businessId: number, args: Omit<Parameters<typeof readInterimDocumentsTx>[1], "businessId">) => ReturnType<typeof readInterimDocumentsTx>;
  now: () => Date;
};

export const defaultInterimDocumentsDeps: InterimDocumentsDeps = {
  enabled: isBusinessKindTransitionEnabled,
  context: getAuthContext as InterimDocumentsDeps["context"],
  read: (businessId, args) => billingTenantTx(businessId, (tx) => readInterimDocumentsTx(tx, { businessId, ...args })),
  now: () => new Date(),
};

export async function handleInterimDocumentsGet(req: Request, deps: InterimDocumentsDeps = defaultInterimDocumentsDeps): Promise<NextResponse> {
  if (!deps.enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ctx = await deps.context(req);
  if (!ctx) return authRequiredResponse(req) as NextResponse;

  const url = new URL(req.url);
  const rawFrom = url.searchParams.get("from");
  const now = deps.now();
  let requestedFromDate: string | null = null;
  if (rawFrom !== null && rawFrom !== "") {
    const v = validateInterimFromDate(rawFrom, now);
    if (!v.ok) return NextResponse.json({ error: "INVALID_FROM_DATE", code: v.code }, { status: 400, headers: noStore });
    requestedFromDate = v.fromDate;
  }
  const list = url.searchParams.get("list") === "1";
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor && !parseCursor(rawCursor)) return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400, headers: noStore });

  try {
    const r = await deps.read(ctx.user.businessId, { requestedFromDate, now, list, cursor: rawCursor });
    if (!r.ok) return NextResponse.json({ error: r.code }, { status: 400, headers: noStore });
    return NextResponse.json(r.result, { status: 200, headers: noStore });
  } catch (e) {
    console.error("interim-documents failed", { businessId: ctx.user.businessId, error: e instanceof Error ? e.name : "UnknownError" });
    return NextResponse.json({ error: "INTERIM_DOCUMENTS_FAILED" }, { status: 500, headers: noStore });
  }
}
