import { NextResponse } from "next/server";

import { authDb, authPlaneMode } from "@/lib/prisma-auth";
import { prisma } from "@/lib/prisma";

/**
 * D2 / AUTH BOUNDARY STAGE B — auth-plane identity probe.
 *
 * The claim under test is about which database identity the APPLICATION holds
 * when it performs an auth operation. Nothing outside the process can settle
 * that: an environment variable shows what was configured, a catalog query shows
 * what exists, and a connection count shows that *something* connected. So this
 * asks the database over the connection `authDb()` actually returns — the same
 * call login, session validation and signup go through.
 *
 * It reports BOTH planes deliberately. Showing only the auth identity would
 * leave the more important property unproven: that the auth plane is a different
 * identity from the tenant runtime, and that the split is real rather than two
 * names for one connection.
 *
 * Inert by construction:
 *   - catalog facts only. No tenant rows, no credentials, no host, no password
 *     hash, no personal data.
 *   - refused unless D2_AUTH_PROBE_TOKEN is set AND presented, so it cannot be
 *     reached in an environment that has not deliberately opted in.
 *   - refusal is 404, not 401, so its existence is not disclosed to a caller who
 *     does not already hold the token.
 *
 * PREVIEW ONLY. Lives on the Stage B branch and must not be merged: the token
 * gate makes it safe, but a permanent introspection endpoint is attack surface
 * production has no reason to carry.
 */
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const IDENTITY_SQL = `
  SELECT current_user::text                                      AS current_user,
         current_setting('is_superuser')                         AS is_superuser,
         r.rolbypassrls                                          AS bypassrls,
         r.rolinherit                                            AS inherits,
         (SELECT count(*)::int FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace
             AND c.relowner = r.oid)                             AS owned_relations,
         COALESCE((SELECT array_agg(g.rolname ORDER BY g.rolname)
                     FROM pg_auth_members am
                     JOIN pg_roles g ON g.oid = am.roleid
                    WHERE am.member = r.oid), ARRAY[]::name[])::text[] AS memberships,
         pg_has_role(current_user, 'app_runtime', 'USAGE')       AS in_app_runtime,
         pg_has_role(current_user, 'app_admin', 'USAGE')         AS in_app_admin,
         pg_has_role(current_user, 'app_ctlplane', 'USAGE')      AS in_app_ctlplane
    FROM pg_roles r
   WHERE r.rolname = current_user
`;

type Identity = {
  current_user: string;
  is_superuser: string;
  bypassrls: boolean;
  inherits: boolean;
  owned_relations: number;
  memberships: string[];
  in_app_runtime: boolean;
  in_app_admin: boolean;
  in_app_ctlplane: boolean;
};

export async function GET(req: Request) {
  const expected = process.env.D2_AUTH_PROBE_TOKEN?.trim();
  const presented = req.headers.get("x-d2-auth-probe")?.trim() ?? "";
  if (!expected || !presented || !timingSafeEqual(expected, presented)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const authIdentity = (await authDb().$queryRawUnsafe<Identity[]>(IDENTITY_SQL))[0] ?? null;
  // The tenant plane is queried too, so the report can show that the two are
  // genuinely different connections rather than asserting it.
  const tenantIdentity = (await prisma.$queryRawUnsafe<Identity[]>(IDENTITY_SQL))[0] ?? null;

  return NextResponse.json({
    probe: "d2-stageb-auth-identity",
    mode: authPlaneMode(),
    authPlane: authIdentity,
    tenantPlane: tenantIdentity,
    planesAreDistinct:
      authIdentity !== null &&
      tenantIdentity !== null &&
      authIdentity.current_user !== tenantIdentity.current_user,
  });
}
