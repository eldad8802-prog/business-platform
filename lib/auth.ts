import { NextResponse } from "next/server";
import { authDb } from "./prisma-auth";
import { verifyAuthTokenPayload } from "./auth-token";
import { acceptsNormalWrites } from "./tenant/business-lifecycle";

export {
  AuthTokenConfigError,
  signAuthToken,
  verifyAuthToken,
  verifyAuthTokenPayload,
} from "./auth-token";

/**
 * The single authentication chokepoint. Inventory (`lib/auth/inventory-auth.ts`)
 * and platform-admin (`lib/auth/platform-admin.ts`) both delegate here, so every
 * gate below applies to every authenticated surface in the product.
 *
 * A request is authenticated only if it clears all four, in this order:
 *
 *   1. token envelope   — authentic signature, known version, not expired
 *   2. account lifecycle — the business still accepts normal use (D2/AD-2A)
 *   3. session generation — the token's generation is the user's current one
 *   4. this device       — the session the token NAMES is still usable
 *
 * The order matters. Cheap cryptography first, then the reads, then the checks
 * that need those rows. Nothing below gate 1 runs for a forged token.
 *
 * Gate 3 is global and gate 4 is per-device, and both are needed. Logging out
 * everywhere moves the generation; revoking one phone marks one row. Before gate
 * 4 existed, that second act changed a row and nothing else, and the phone kept
 * working until its token expired.
 */
/**
 * The columns session resolution actually needs, and no others.
 *
 * This runs on every authenticated request, and it used to load the whole row —
 * `password` included — purely because `include` selects all scalars by default.
 * Nothing downstream reads the hash from here; the only server-side comparison
 * lives in the login route, which selects it deliberately. Removing it from this
 * path takes the credential out of the hottest query in the product.
 *
 * The nested Business selection is the lifecycle gate's input plus the two
 * fields callers read off the relation (`/api/home` uses id and name). The gate
 * needs `deletionRequestedAt` as well as `deletedAt`: checking the latter alone
 * left the whole quarantine window authenticated.
 */
const SESSION_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  businessId: true,
  role: true,
  tokenVersion: true,
  business: {
    select: {
      id: true,
      name: true,
      deletionRequestedAt: true,
      deletedAt: true,
    },
  },
} as const;

/** What the session row must satisfy for a token naming it to be honoured. */
const SESSION_GATE_SELECT = {
  id: true,
  userId: true,
  revokedAt: true,
  idleExpiresAt: true,
  absoluteExpiresAt: true,
  tokenVersionAtIssue: true,
} as const;

/**
 * The authenticated context: who, and from WHICH device.
 *
 * `getCurrentUser` is the name a hundred call sites already use, so it keeps its
 * exact signature and delegates here. Only the surfaces that must know which
 * session is talking — device management — read `sessionId`.
 */
export async function getAuthContext(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return null;
    }

    // Gate 1 — envelope. Proves the token was minted here and has not expired.
    // It cannot prove the session is still current; that needs the rows below.
    const verified = verifyAuthTokenPayload(token);
    if (verified === null) {
      return null;
    }

    // The session row is fetched ALONGSIDE the user, not after it. The two reads
    // are independent, so serialising them would buy nothing but a round trip.
    // The verdict is still reached only once both have resolved, and any refusal
    // or thrown error still denies — parallel here buys latency, not leniency.
    //
    // `sid` is a SELECTOR. It has already survived the signature check so a
    // caller cannot choose it, and the row it names is still required to belong
    // to `sub` below. It is never authority on its own.
    const [user, session] = await Promise.all([
      authDb().user.findUnique({
        where: { id: verified.userId },
        select: SESSION_USER_SELECT,
      }),
      verified.sessionId === null
        ? Promise.resolve(null)
        : authDb().authSession.findUnique({
            where: { id: verified.sessionId },
            select: SESSION_GATE_SELECT,
          }),
    ]);

    if (!user) {
      return null;
    }

    // Gate 2 — account lifecycle (D2/AD-2A). Fail closed for a business under
    // account-deletion quarantine. Tokens are stateless HMAC with no server-side
    // session store, so this DB check IS the revocation boundary — and it must
    // fire the moment deletion is REQUESTED, not only once the purge has
    // finished. Checking deletedAt alone left the whole quarantine window
    // authenticated.
    if (user.business && !acceptsNormalWrites(user.business)) {
      return null;
    }

    // Gate 3 — session generation. The token carries the generation it was
    // minted under; logging out increments the user's generation, so every token
    // issued before that moment — including ones already copied off this device
    // — stops verifying here. Signing out used to be a purely client-side act:
    // the browser forgot the token, and the server went on honouring it until it
    // expired.
    //
    // Inequality rather than "older than", so a token from a FUTURE generation
    // is refused too. If those ever disagree in that direction something is
    // wrong, and the safe reading of "wrong" is "not authenticated".
    if (verified.tokenVersion !== user.tokenVersion) {
      return null;
    }

    // Gate 4 — THIS DEVICE. Without it, revoking one device changed a row and
    // nothing else: the token carried no session identity, so the request path
    // could not tell that this particular device had been cut off, and it went on
    // working for up to 24 hours. Every condition below is a refusal.
    if (verified.sessionId !== null) {
      if (session === null) return null;
      // The selector named a row; the row must be the caller's own. Refusing here
      // is what keeps `sid` from becoming a way to borrow another account.
      if (session.userId !== verified.userId) return null;
      if (session.revokedAt !== null) return null;
      const now = new Date();
      if (session.idleExpiresAt <= now) return null;
      if (session.absoluteExpiresAt <= now) return null;
      // The row's own generation, as well as the token's. Both must agree with
      // the user's current one, so a global logout is caught even by a token that
      // somehow carried the right `tv`.
      if (session.tokenVersionAtIssue !== user.tokenVersion) return null;
    }
    // TEMPORARY, AND BOUNDED BY THE TOKEN ITSELF.
    //
    // A token with no `sid` was minted before this shipped. Gate 1 already
    // refuses anything past its `exp`, and that is capped at 24 hours by
    // CASA 2.2.3 — so 24 hours after rollout no sid-less token can reach this
    // line at all. The window closes on its own; there is no date in this file
    // to get wrong, and nothing to clean up.
    //
    // Nothing in this codebase mints one any more: login fails closed if the
    // session cannot be created, and refresh only mints after a rotation. The
    // follow-up PR deletes this branch outright rather than leaving it
    // unreachable.
    //
    // DATED REMOVAL NOTE (sec-B, 2026-09-25): register was the LAST minting
    // path without a sid (L-9) and now issues a real session. Once the sec-B
    // PR has been deployed to Production for more than 24 hours, no live
    // sid-less token can exist (gate 1 enforces the 24h exp), and this branch
    // must be deleted — every token without a sid then becomes a refusal.
    // Kept today only because tokens minted by the previous register code may
    // still be inside their 24h life at deploy time.
    else {
      console.log(JSON.stringify({ event: "auth_sidless_token_accepted", userId: user.id }));
    }

    return { user, sessionId: verified.sessionId };
  } catch (error) {
    console.error("getAuthContext error:", error);
    return null;
  }
}

/**
 * The historical chokepoint, unchanged for its callers: the user, or null.
 *
 * Every gate above applies. Keeping the signature identical is deliberate — a
 * hundred routes call this, and a per-device revocation check is not a reason to
 * touch a hundred routes.
 */
export async function getCurrentUser(req: Request) {
  const context = await getAuthContext(req);
  return context === null ? null : context.user;
}

/** Standard 401 response for routes that require an authenticated user. */
export function authRequiredResponse(_req: Request): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
