/**
 * Verify — step-up re-authentication (lib/auth/sensitive-reauth.ts + lib/auth/google-reauth.ts) and the Google
 * callback's re-authentication branch (app/api/auth/google/callback/route.ts).
 * Run: npx tsx lib/auth/sensitive-reauth.test.ts
 *
 * Pure: no database, no network (Google's exchange / verification / identity lookup are injected).
 */
import assert from "node:assert/strict";

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "sensitive-reauth-test-secret-0123456789";

import { handleGoogleCallback, type CallbackRouteDeps } from "@/app/api/auth/google/callback/route";
import { issueAdminElevation, verifyAdminElevation } from "@/lib/auth/platform-admin-elevation";
import { googleReauthAuthorizeUrl, handleGoogleReauthCallback, type GoogleReauthCallbackDeps } from "@/lib/auth/google-reauth";
import type { GoogleLoginConfig } from "@/lib/auth/google-oauth";
import {
  GOOGLE_REAUTH_COOKIE,
  googleAuthIsFresh,
  issueReauthProof,
  newGoogleReauthState,
  openGoogleReauthState,
  REAUTH_ACTIONS,
  REAUTH_PROOF_TTL_SECONDS,
  requiredReauthMethod,
  sealGoogleReauthState,
  verifyReauthProof,
} from "@/lib/auth/sensitive-reauth";

let checks = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    checks += 1;
  } catch (e) {
    console.error(`FAIL ${label}`);
    throw e;
  }
}

const ACTION = "BUSINESS_KIND_TRANSITION" as const;
const T0 = Date.parse("2026-11-20T10:00:00Z");
const claims = { userId: 41, sessionId: "sess-a", action: ACTION, method: "PASSWORD" as const };
const expected = { userId: 41, sessionId: "sess-a", action: ACTION };

const config: GoogleLoginConfig = {
  clientId: "client-1.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectBase: "https://app.lab.invalid",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: null,
  access: { mode: "open" },
};

async function main() {
  // ---------------------------------------------------------------- the proof
  await check("R1 a proof verifies for the same user, session and action, with its method and time", () => {
    const r = verifyReauthProof(issueReauthProof(claims, T0), expected, T0 + 1000);
    assert.ok(r.ok && r.method === "PASSWORD" && r.reauthAt.getTime() === Math.floor(T0 / 1000) * 1000);
  });

  await check("R2 another user / another session / no session (legacy token) → refused", () => {
    const p = issueReauthProof(claims, T0);
    assert.deepEqual(verifyReauthProof(p, { ...expected, userId: 42 }, T0), { ok: false, reason: "user_mismatch" });
    assert.deepEqual(verifyReauthProof(p, { ...expected, sessionId: "sess-b" }, T0), { ok: false, reason: "session_mismatch" });
    assert.deepEqual(verifyReauthProof(p, { ...expected, sessionId: null }, T0), { ok: false, reason: "session_mismatch" });
  });

  await check("R3 expired after 5 minutes; a proof dated in the future is refused", () => {
    const p = issueReauthProof(claims, T0);
    assert.equal(verifyReauthProof(p, expected, T0 + (REAUTH_PROOF_TTL_SECONDS - 1) * 1000).ok, true);
    assert.deepEqual(verifyReauthProof(p, expected, T0 + REAUTH_PROOF_TTL_SECONDS * 1000), { ok: false, reason: "expired" });
    assert.deepEqual(verifyReauthProof(issueReauthProof(claims, T0 + 10 * 60_000), expected, T0), { ok: false, reason: "expired" });
  });

  await check("R4 tampered, truncated, empty, garbage → refused, never thrown", () => {
    const p = issueReauthProof(claims, T0);
    const [body, sig] = p.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), sub: 42 })).toString("base64url");
    assert.equal(verifyReauthProof(`${forged}.${sig}`, { ...expected, userId: 42 }, T0).ok, false);
    for (const raw of ["", null, undefined, "abc", `${body}.`, `.${sig}`, `${body}.${sig}.x`, "x".repeat(5000)]) {
      assert.equal(verifyReauthProof(raw as string, expected, T0).ok, false);
    }
  });

  await check("R5 purpose separation: an admin elevation is not a proof, a proof is not an elevation, a Google state is neither", () => {
    const elevation = issueAdminElevation(41, T0);
    assert.equal(verifyReauthProof(elevation, expected, T0).ok, false);
    assert.equal(verifyAdminElevation(issueReauthProof(claims, T0), 41, T0).ok, false);
    const g = sealGoogleReauthState(newGoogleReauthState(expected, T0));
    assert.equal(verifyReauthProof(g, expected, T0).ok, false);
    assert.equal(openGoogleReauthState(issueReauthProof(claims, T0), T0), null);
  });

  await check("R6 the method follows the account: a password → PASSWORD; none → GOOGLE", () => {
    assert.equal(requiredReauthMethod({ hasPassword: true }), "PASSWORD");
    assert.equal(requiredReauthMethod({ hasPassword: false }), "GOOGLE");
  });

  // ---------------------------------------------------------------- the Google state + URL
  await check("G1 the Google state round-trips, expires after 10 minutes, and rejects tampering", () => {
    const s = newGoogleReauthState(expected, T0);
    const sealed = sealGoogleReauthState(s);
    assert.deepEqual(openGoogleReauthState(sealed, T0 + 1000), s);
    assert.equal(openGoogleReauthState(sealed, T0 + 10 * 60_000 + 1000), null);
    assert.equal(openGoogleReauthState(sealed.slice(0, -2) + "xx", T0), null);
  });

  await check("G2 the authorize URL forces a fresh login (prompt=login, max_age=0) with state, nonce and PKCE", () => {
    const s = newGoogleReauthState(expected, T0);
    const u = new URL(googleReauthAuthorizeUrl(config, s));
    assert.equal(u.searchParams.get("prompt"), "login");
    assert.equal(u.searchParams.get("max_age"), "0");
    assert.equal(u.searchParams.get("state"), s.state);
    assert.equal(u.searchParams.get("nonce"), s.nonce);
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  });

  await check("G3 auth_time must be present and at most ~5 minutes old", () => {
    const now = Math.floor(T0 / 1000);
    assert.equal(googleAuthIsFresh(now - 30, T0), true);
    assert.equal(googleAuthIsFresh(now - 10 * 60, T0), false);
    assert.equal(googleAuthIsFresh(null, T0), false);
    assert.equal(googleAuthIsFresh(undefined, T0), false);
    assert.equal(googleAuthIsFresh(now + 600, T0), false);
  });

  // ---------------------------------------------------------------- the callback branch
  const s = newGoogleReauthState(expected, T0);
  const deps = (over: Partial<GoogleReauthCallbackDeps> = {}): GoogleReauthCallbackDeps => ({
    exchange: async () => "id-token",
    verify: async () => ({ ok: true, identity: { subject: "g-sub-41", email: "a@lab.invalid", name: null, authTime: Math.floor(T0 / 1000) - 20 } }),
    resolve: async (sub) => (sub === "g-sub-41" ? { userId: 41, businessId: 7 } : null),
    now: () => new Date(T0),
    ...over,
  });
  const params = (q: Record<string, string>) => new URLSearchParams({ state: s.state, code: "code-1", ...q });
  const cookiesOf = (res: Response) => res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const proofCookie = (res: Response) => cookiesOf(res).find((c) => c.startsWith(`${REAUTH_ACTIONS[ACTION].cookie}=`) && !/Max-Age=0/i.test(c));

  await check("C1 same Google account, fresh auth → redirect ?reauth=ok, proof cookie httpOnly on the action path, state cookie cleared", async () => {
    const res = await handleGoogleReauthCallback(params({}), config, s, deps());
    assert.equal(res.status, 303);
    assert.ok(res.headers.get("location")!.endsWith(`${REAUTH_ACTIONS[ACTION].returnPage}?reauth=ok`));
    const c = proofCookie(res);
    assert.ok(c && /HttpOnly/i.test(c) && c.includes(`Path=${REAUTH_ACTIONS[ACTION].path}`), c);
    assert.ok(cookiesOf(res).some((x) => x.startsWith(`${GOOGLE_REAUTH_COOKIE}=;`) || (x.startsWith(`${GOOGLE_REAUTH_COOKIE}=`) && /Max-Age=0/i.test(x))));
    const value = decodeURIComponent(c!.split(";")[0].split("=").slice(1).join("="));
    const v = verifyReauthProof(value, expected, T0 + 1000);
    assert.ok(v.ok && v.method === "GOOGLE");
    assert.ok(!res.headers.get("location")!.includes(value), "the URL never carries the proof");
  });

  await check("C2 a Google account linked to ANOTHER user, or to nobody → other_account, no proof", async () => {
    for (const resolve of [async () => ({ userId: 99, businessId: 8 }), async () => null]) {
      const res = await handleGoogleReauthCallback(params({}), config, s, deps({ resolve }));
      assert.ok(res.headers.get("location")!.endsWith("?reauth=other_account"));
      assert.equal(proofCookie(res), undefined);
    }
  });

  await check("C3 stale or missing auth_time → stale, no proof", async () => {
    for (const authTime of [Math.floor(T0 / 1000) - 3600, null, undefined]) {
      const res = await handleGoogleReauthCallback(params({}), config, s,
        deps({ verify: async () => ({ ok: true, identity: { subject: "g-sub-41", email: "a@lab.invalid", name: null, authTime } }) }));
      assert.ok(res.headers.get("location")!.endsWith("?reauth=stale"), String(authTime));
      assert.equal(proofCookie(res), undefined);
    }
  });

  await check("C4 cancelled at Google / failed exchange / refused token / throwing lookup → no proof", async () => {
    const cases: [URLSearchParams, Partial<GoogleReauthCallbackDeps>, string][] = [
      [params({ error: "access_denied" }), {}, "cancelled"],
      [params({}), { exchange: async () => null }, "error"],
      [params({}), { verify: async () => ({ ok: false, reason: "NONCE" }) }, "error"],
      [params({}), { resolve: async () => { throw new Error("db down"); } }, "error"],
    ];
    for (const [p, over, result] of cases) {
      const res = await handleGoogleReauthCallback(p, config, s, deps(over));
      assert.ok(res.headers.get("location")!.endsWith(`?reauth=${result}`), result);
      assert.equal(proofCookie(res), undefined);
    }
  });

  // ---------------------------------------------------------------- the shared callback route
  let reauthCalls = 0;
  let resolveCalls = 0;
  const routeDeps: CallbackRouteDeps = {
    config: () => config,
    exchange: async () => "id-token",
    resolve: async () => { resolveCalls += 1; return { kind: "invalid_token", reason: "NONCE" } as never; },
    rateLimit: async () => ({ allowed: true }) as never,
    recordUsage: async () => undefined as never,
    reauth: async () => { reauthCalls += 1; return new Response(null, { status: 303, headers: { location: "/reauth" } }) as never; },
  };
  const req = (cookie: string | null, state: string) => new Request(`https://app.lab.invalid/api/auth/google/callback?state=${encodeURIComponent(state)}&code=c`,
    { headers: cookie ? { cookie } : {} });

  await check("C5 a valid re-auth cookie whose state Google echoed → the re-auth branch; sign-in is not run", async () => {
    reauthCalls = 0; resolveCalls = 0;
    const live = newGoogleReauthState(expected);
    await handleGoogleCallback(req(`${GOOGLE_REAUTH_COOKIE}=${encodeURIComponent(sealGoogleReauthState(live))}`, live.state), routeDeps);
    assert.equal(reauthCalls, 1);
    assert.equal(resolveCalls, 0);
  });

  await check("C6 no re-auth cookie, a forged one, or a state that does not match → ordinary sign-in path, never the re-auth branch", async () => {
    reauthCalls = 0;
    const live = newGoogleReauthState(expected);
    for (const r of [
      req(null, live.state),
      req(`${GOOGLE_REAUTH_COOKIE}=forged.value`, live.state),
      req(`${GOOGLE_REAUTH_COOKIE}=${encodeURIComponent(sealGoogleReauthState(live))}`, "another-state"),
    ]) {
      const res = await handleGoogleCallback(r, routeDeps);
      assert.equal(res.status, 303);
      assert.ok(res.headers.get("location")!.includes("/login?google="), "ordinary sign-in answer");
    }
    assert.equal(reauthCalls, 0);
  });

  console.log(`sensitive-reauth: ${checks} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
