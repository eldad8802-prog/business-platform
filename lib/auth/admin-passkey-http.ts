/**
 * Shared HTTP shaping for the platform-admin passkey routes. Kept out of the
 * routes so every one of them answers an unavailable feature the same way.
 */
import { NextResponse } from "next/server";
import { PasskeyUnavailableError } from "./admin-passkey.service";

export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/** 503 PASSKEY_UNAVAILABLE for a switched-off feature; null for anything else. */
export function passkeyUnavailableResponse(error: unknown): NextResponse | null {
  if (error instanceof PasskeyUnavailableError) {
    return NextResponse.json(
      {
        error: "Passkeys are not available on this environment",
        code: "PASSKEY_UNAVAILABLE",
        reason: error.reason,
      },
      { status: 503, headers: NO_STORE }
    );
  }
  return null;
}

/** Never echo a library or database error: it can carry configuration detail. */
export function passkeyFailure(tag: string, error: unknown): NextResponse {
  console.error(`${tag}:`, error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json({ error: "Passkey request failed" }, { status: 500, headers: NO_STORE });
}
