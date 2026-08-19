/**
 * Billing cryptographic-signing activation gate (Phase 2B-3A). SERVER-ONLY.
 *
 * A single boolean switch that decouples "the signing orchestration code is
 * deployed" from "signing is expected to happen." Default is OFF, and any
 * missing/invalid value evaluates to OFF (fail-safe to today's behavior).
 *
 *   OFF → current unsigned behavior exactly; no resolver, no signPdf, no signed
 *         upload, no signed DB record, no signing requirement.
 *   ON  → fiscal PDF delivery requires a canonical signed artifact; no silent
 *         unsigned downgrade.
 *
 * There is intentionally NO client-side flag and NO per-business flag. The
 * Production value is NOT provisioned in this phase — the switch stays OFF.
 */
export const ENV_BILLING_SIGNING_ACTIVE = "BILLING_SIGNING_ACTIVE";

/**
 * True only when the activation env var is exactly "1". Everything else —
 * unset, empty, "0", "true", arbitrary strings — is OFF. `env` is injectable
 * for deterministic tests; production reads process.env.
 */
export function isBillingSigningActive(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[ENV_BILLING_SIGNING_ACTIVE] === "1";
}
