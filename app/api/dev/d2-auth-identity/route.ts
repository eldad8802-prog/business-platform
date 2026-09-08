import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { authDb } from "@/lib/prisma-auth";

/**
 * TEMPORARY D2 STAGE D PROBE — MUST BE REMOVED IN PR-B AFTER PRODUCTION IDENTITY PROOF
 *
 * Stage D activates the auth plane in Production. The claim that needs proving
 * afterwards is narrow: that an auth operation runs as `app_auth_prod` and not
 * as the tenant runtime identity. Nothing outside the process can settle it.
 * Connection counts show that *something* connected; an environment variable
 * shows what was configured. Only the application, asked over the connection
 * `authDb()` actually returns, can answer which identity it holds.
 *
 * Deliberately the smallest thing that answers that question and nothing more:
 *
 *   - ONE query, `SELECT current_user`, through `authDb()` only. No tenant
 *     client, no admin or control-plane client, no second plane.
 *   - ONE field in the response. Role attributes, memberships, owned-relation
 *     counts, host, database and schema are all omitted — they describe the
 *     privilege topology, which a Production endpoint has no reason to publish
 *     even behind a token.
 *   - No input of any kind is read into the query, so there is nothing to
 *     inject and no arbitrary-query surface.
 *   - No mutation.
 *
 * Refusal is 404 rather than 401, so a caller without the token learns nothing
 * about the route existing. An unset or empty `D2_AUTH_PROBE_TOKEN` refuses
 * every request, which is what keeps this inert in any environment that has not
 * deliberately opted in — including Production before Stage D and after PR-B.
 *
 * A failure of the auth plane propagates. There is no fallback to the tenant
 * client here or in `authDb()`: a probe that answered through another identity
 * when the auth plane was broken would report exactly the reassuring result
 * that the whole exercise exists to disprove.
 */
export const dynamic = "force-dynamic";

/**
 * Constant-time compare over a fixed-width digest.
 *
 * Comparing the raw strings would return early on a length mismatch and leak
 * the token's length. Hashing both sides to 32 bytes first makes every
 * comparison the same width, so neither length nor content is observable in
 * the timing.
 */
function secretsMatch(expected: string, presented: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

const NOT_FOUND = () => new NextResponse("Not Found", { status: 404 });

export async function GET(req: Request) {
  const expected = process.env.D2_AUTH_PROBE_TOKEN?.trim();
  if (!expected) return NOT_FOUND();

  const presented = req.headers.get("x-d2-auth-probe")?.trim();
  if (!presented) return NOT_FOUND();

  if (!secretsMatch(expected, presented)) return NOT_FOUND();

  const rows = await authDb().$queryRawUnsafe<Array<{ current_user: string }>>(
    `SELECT current_user::text AS current_user`
  );

  return NextResponse.json({ currentUser: rows[0]?.current_user ?? null });
}
