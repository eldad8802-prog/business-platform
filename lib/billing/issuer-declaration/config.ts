/**
 * The declaration screens and routes (#1081) are OFF unless ISSUER_DECLARATION_ENABLED is exactly "true".
 * OFF → the routes answer 404 and the pages are not found. Turning them on is an owner decision, and it needs the
 * declaration migration (20261126100000) and the link migration (20261126090000) applied first.
 *
 * This switch does NOT enforce anything: enforcement is the single row of "IssuerDeclarationEnforcement", written
 * only by an owner-approved step, never by the application.
 */
export function isIssuerDeclarationEnabled(): boolean {
  return process.env.ISSUER_DECLARATION_ENABLED === "true";
}
