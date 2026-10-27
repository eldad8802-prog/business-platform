/**
 * The HTTP edge of document ↔ supplier linking. SERVER-ONLY.
 *
 *   - authenticated user only (401); the business comes from the session, never from the request;
 *   - the `document_supplier_linking` flag: OFF ⇒ 404, as if the route did not exist;
 *   - DocumentSupplierLinkError ⇒ its status + a stable code; anything else ⇒ 500 with no detail.
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { documentSupplierLinkingEnabled } from "@/lib/services/documents/issuer/issuer-context";
import { DocumentSupplierLinkError } from "./supplier-link.service";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

export type SupplierLinkActor = { businessId: number; userId: number };

export async function supplierLinkRoute(
  req: Request,
  handler: (actor: SupplierLinkActor) => Promise<unknown>
): Promise<Response> {
  try {
    const user = await getCurrentUser(req);
    if (!user || !user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
    if (!(await documentSupplierLinkingEnabled(user.businessId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
    }
    const body = await handler({ businessId: user.businessId, userId: user.id });
    return NextResponse.json(body, { status: 200, headers: NO_STORE });
  } catch (e) {
    if (e instanceof DocumentSupplierLinkError) {
      return NextResponse.json({ error: e.code }, { status: e.status, headers: NO_STORE });
    }
    console.error("[document-supplier-link] unexpected error", e instanceof Error ? e.name : "unknown");
    return NextResponse.json({ error: "INTERNAL" }, { status: 500, headers: NO_STORE });
  }
}

export function positiveInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export function invalid(): never {
  throw new DocumentSupplierLinkError("INVALID_REQUEST", 400);
}
