import { NextResponse } from "next/server";
import { identityErrorResponse } from "@/lib/services/identity/identity-http";
import { TrustClaimInputError } from "./trust-claim-catalogue";
import { TrustClaimConflictError, TrustClaimNotFoundError } from "./trust-claim.service";

/** Shared error mapping for the /api/business/trust-claims and identity-context routes. */
export function trustErrorResponse(error: unknown, label: string): NextResponse {
  if (error instanceof TrustClaimInputError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof TrustClaimNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof TrustClaimConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
  return identityErrorResponse(error, label);
}
