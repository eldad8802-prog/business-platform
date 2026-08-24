// Pure client-side response contract for the Opportunities (collaboration
// deals) feature. Extracted from the page component so the F-20 trust
// invariants are unit-testable without a DOM:
//
//   - A 401 from any deals API means the session is invalid → the caller must
//     fail closed (redirect to /login) and MUST NOT render the raw server body.
//   - Any other non-2xx maps to a human Hebrew message — a raw English server
//     string ("Unauthorized", "Failed to fetch deals", …) must never reach the
//     UI as if it were business data.
//   - A 2xx response is the only case where the caller uses the payload.

export const DEALS_ERROR = {
  fetch: "שגיאה בטעינת שיתופי הפעולה. נסה שוב מאוחר יותר.",
  generate: "שגיאה ביצירת פעולות. נסה שוב מאוחר יותר.",
  update: "שגיאה בעדכון הפעולה. נסה שוב מאוחר יותר.",
} as const;

export type DealsCall = keyof typeof DEALS_ERROR;

export type DealsOutcome =
  | { kind: "unauthorized" } // caller redirects to /login, renders nothing
  | { kind: "error"; message: string } // caller shows the Hebrew message
  | { kind: "ok" }; // caller uses the response payload

/**
 * Classify a deals-API response into one of three UI outcomes. Deliberately
 * ignores the response body: the server's error text is never surfaced, so a
 * raw "Unauthorized" can never render as business data (F-20).
 */
export function resolveDealsOutcome(
  call: DealsCall,
  res: { ok: boolean; status: number }
): DealsOutcome {
  if (res.status === 401) {
    return { kind: "unauthorized" };
  }
  if (!res.ok) {
    return { kind: "error", message: DEALS_ERROR[call] };
  }
  return { kind: "ok" };
}
