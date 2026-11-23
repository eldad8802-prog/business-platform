/**
 * "מעבר לעוסק מורשה" — the one place the feature flag is read.
 *
 * OFF by default: BUSINESS_KIND_TRANSITION_ENABLED must be exactly "true" (a separate owner approval). Server-side
 * only (no NEXT_PUBLIC_ prefix, so it never reaches a browser bundle). Every API route enforces it on the server
 * (lib/services/legal-identity/kind-transition-handlers.ts); app/business/layout.tsx passes the same answer to the
 * screens only so they do not call an API that would answer 404 — hiding is never the protection.
 */
export function isBusinessKindTransitionEnabled(): boolean {
  return process.env.BUSINESS_KIND_TRANSITION_ENABLED === "true";
}
