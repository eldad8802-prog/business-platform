import { NextResponse } from "next/server";

import { authorizeUrl, newStartState, readGoogleLoginConfig, sealStartState, setStartCookie } from "@/lib/auth/google-oauth";
import { consumeRateLimit, getClientIp } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

/**
 * "Continue with Google" — step 1: send the browser to Google with a fresh state, nonce and PKCE challenge,
 * bound to this browser by a signed httpOnly cookie. Writes nothing anywhere.
 * OFF (flag or config missing) → 404, as if the route did not exist.
 */
export type StartDeps = { config: typeof readGoogleLoginConfig; rateLimit: typeof consumeRateLimit };
const defaultDeps: StartDeps = { config: readGoogleLoginConfig, rateLimit: consumeRateLimit };

export async function handleGoogleStart(req: Request, deps: StartDeps = defaultDeps): Promise<NextResponse> {
  const config = deps.config();
  if (!config) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rl = await deps.rateLimit({ key: `auth:google:start:${getClientIp(req)}`, limit: 30, windowMs: 10 * 60_000 });
  if (!rl.allowed) return NextResponse.redirect(new URL("/login?google=busy", config.redirectBase), 303);

  const from = new URL(req.url).searchParams.get("from") === "register" ? "register" : "login";
  const state = newStartState(from);
  const res = NextResponse.redirect(authorizeUrl(config, state), 303);
  res.headers.set("cache-control", "no-store");
  setStartCookie(res, sealStartState(state));
  return res;
}

export async function GET(req: Request) {
  return handleGoogleStart(req);
}
