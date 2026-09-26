/**
 * SEC-E — the AUTH PLANE in a laboratory, replayed from the migrations, never hand-written.
 *
 * The erasure now revokes authority on the auth plane (User.tokenVersion, AuthSession,
 * AuthSessionSecret). In Production those statements run as `app_auth`, whose grants
 * come from three migrations. A lab that granted the tenant runtime AuthSession
 * privileges instead would prove the erasure against a capability the tenant plane
 * deliberately does not have (20260908200000 revokes it). So a SECOND fresh role is made
 * per proof and handed exactly the `app_auth` GRANT/REVOKE statements those migrations
 * contain, with the role name substituted — nothing more.
 */
import fs from "node:fs";

export const AUTH_PLANE_MIGRATIONS = [
  "prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql",
  "prisma/migrations/20260908200000_auth_session_privilege_contract/migration.sql",
  "prisma/migrations/20260913120000_authsession_user_agent/migration.sql",
];

/** Every GRANT/REVOKE naming app_auth in the three migrations, role substituted. */
export function authPlaneStatements(role) {
  const out = [];
  for (const f of AUTH_PLANE_MIGRATIONS) {
    const sql = fs.readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/\b(GRANT|REVOKE)\b[^;]*?\bapp_auth\b[^;]*;/g)) {
      out.push(m[0].replace(/\bapp_auth\b/g, role).replace(/\s+/g, " "));
    }
  }
  if (out.length < 10) throw new Error(`auth-plane replay found only ${out.length} statements — migrations moved?`);
  return out;
}

export async function applyAuthPlane(owner, role) {
  const stmts = authPlaneStatements(role);
  for (const s of stmts) await owner.$executeRawUnsafe(s);
  return stmts.length;
}
