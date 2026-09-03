import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

/**
 * D2 / PRODUCTION-RUNTIME-CUTOVER-3A.2 — runtime identity probe.
 *
 * The cutover's central claim is that the *application* runs as a restricted,
 * NOBYPASSRLS, non-owner database identity. Everything short of asking the
 * running application itself is circumstantial: a Vercel environment variable
 * shows what was configured, a Neon dashboard shows what exists, and a lab
 * harness shows what a role *can* do. None of them prove which identity this
 * process actually holds. So this route asks the database, over the connection
 * the application is really using, and reports what the server sees.
 *
 * It is deliberately narrow and inert:
 *
 *   - it returns catalog facts only — role name, attributes, ownership count.
 *     No tenant rows, no credentials, no connection string, no host.
 *   - it is refused unless D2_PROBE_TOKEN is configured AND the caller presents
 *     it. An unset token disables the route entirely, so it cannot be reached
 *     in any environment that has not deliberately opted in.
 *   - a refusal is a 404, not a 401, so the route's existence is not disclosed
 *     to a caller who does not already know the token.
 *
 * PREVIEW ONLY. This lives on the rehearsal branch and must not be merged: the
 * token gate makes it safe, but a permanently-deployed introspection endpoint is
 * still attack surface that production has no reason to carry.
 */
export const dynamic = "force-dynamic";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: Request) {
  const expected = process.env.D2_PROBE_TOKEN?.trim();
  const presented = req.headers.get("x-d2-probe")?.trim() ?? "";
  if (!expected || !presented || !timingSafeEqual(expected, presented)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      current_user: string;
      is_superuser: string;
      bypassrls: boolean;
      createdb: boolean;
      createrole: boolean;
      replication: boolean;
      inherits: boolean;
      owned_relations: number;
      memberships: string[];
      rls_tables: number;
      can_read_ledger: boolean;
    }>
  >(`
    SELECT
      current_user::text                                        AS current_user,
      current_setting('is_superuser')                           AS is_superuser,
      r.rolbypassrls                                            AS bypassrls,
      r.rolcreatedb                                             AS createdb,
      r.rolcreaterole                                           AS createrole,
      r.rolreplication                                          AS replication,
      r.rolinherit                                              AS inherits,
      (SELECT count(*)::int FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relowner = r.oid)                               AS owned_relations,
      COALESCE((SELECT array_agg(g.rolname ORDER BY g.rolname)
                  FROM pg_auth_members am
                  JOIN pg_roles g ON g.oid = am.roleid
                 WHERE am.member = r.oid), ARRAY[]::name[])::text[] AS memberships,
      (SELECT count(*)::int FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind = 'r' AND c.relrowsecurity)             AS rls_tables,
      has_table_privilege(current_user, 'public."_prisma_migrations"', 'SELECT')
                                                                AS can_read_ledger
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);

  return NextResponse.json({ probe: "d2-3a2-runtime-identity", identity: rows[0] ?? null });
}
