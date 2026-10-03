import { NextResponse } from "next/server";
import { IdentityInputError } from "./identity-vocabulary";
import { IdentityConflictError, IdentityNotFoundError } from "./identity-statement.service";

/** Shared error mapping for the /api/business/identity routes. */
export function identityErrorResponse(error: unknown, label: string): NextResponse {
  if (error instanceof IdentityInputError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  if (error instanceof IdentityNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof IdentityConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
  console.error(`${label} error:`, error instanceof Error ? error.name : "unknown");
  return NextResponse.json({ error: "Server error" }, { status: 500 });
}
