/**
 * "Continue with Google" — the pilot (google-oauth.ts "who"): the pure half (no database, no network).
 *   npx tsx lib/auth/google-login-pilot.test.ts
 *
 *   A  The mode: only AUTH_GOOGLE_LOGIN_MODE=open opens to everyone; unset, "pilot", "Open", anything else → pilot.
 *   B  The list fails closed: missing, empty, malformed, a wildcard, a whole domain, too many → nobody. Deleting the
 *      list never opens the service. A valid list admits exactly its addresses (letter case folded as signup does).
 *   C  The button: open → shown; pilot → only on `?google=pilot`, and the parameter grants nothing.
 *   D  The callback: an unlisted address → "unavailable", before the linked lookup (no database reached), with no
 *      ticket, link or session cookie and no address in the log.
 *   E  Every route that completes a signup or a link refuses an unlisted ticket address BEFORE anything is spent,
 *      counted or sent; a listed address goes through; open mode does not even read the ticket for the pilot.
 *   F  Static: each of those routes checks googleLoginAllows; the pages use googleButtonVisible.
 *
 * The database half (real tickets on real rows, nothing created) is .agl/app-battery-pilot.ts; the browser half
 * is the "pilot" step of oauth-identity-lab.yml (.agl/browser-pilot.ts).
 */
process.env.AUTH_TOKEN_SECRET ??= "pure_test_auth_token_secret_0123456789abcdef0123456789";

import fs from "node:fs";
import path from "node:path";

import type { CompletedLink } from "./google-link";
import type { GoogleIdTokenResult } from "./google-id-token";
import {
  GOOGLE_LINK_COOKIE,
  GOOGLE_NOT_IN_PILOT,
  GOOGLE_START_COOKIE,
  GOOGLE_TICKET_COOKIE,
  googleButtonVisible,
  googleLoginAllows,
  isGoogleLoginEnabled,
  newStartState,
  readGoogleLoginConfig,
  sealStartState,
  type GoogleLoginConfig,
} from "./google-oauth";
import { resolveGoogleCallback } from "./google-sign-in";
import type { CreatedGoogleAccount } from "./signup";
import { handleGoogleCallback } from "@/app/api/auth/google/callback/route";
import { handleGoogleComplete, type CompleteDeps } from "@/app/api/auth/google/complete/route";
import { handleLinkPassword, type LinkPasswordDeps } from "@/app/api/auth/google/link/password/route";
import { handleLinkEmailRequest } from "@/app/api/auth/google/link/email/route";
import { handleLinkEmailComplete } from "@/app/api/auth/google/link/email/complete/route";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const BASE = {
  AUTH_GOOGLE_LOGIN_ENABLED: "true",
  AUTH_PLANE_ENABLED: "true",
  GOOGLE_LOGIN_CLIENT_ID: "client-1.apps.googleusercontent.com",
  GOOGLE_LOGIN_CLIENT_SECRET: "lab-secret",
  GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://app.dubiz.test",
};
const LISTED = "pilot.owner@lab.invalid";
const OTHER = "someone.else@lab.invalid";
const cfg = (env: Record<string, string>) => readGoogleLoginConfig({ ...BASE, ...env }) as GoogleLoginConfig;
const pilot = cfg({ AUTH_GOOGLE_LOGIN_PILOT_EMAILS: `${LISTED}, second@lab.invalid` });
const open = cfg({ AUTH_GOOGLE_LOGIN_MODE: "open" });

const allow = async () => ({ allowed: true, remaining: 1, resetAt: 0 });
const SECRET = "Ab-_".repeat(10) + "xyz";
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? "";
const clearedCookie = (res: Response, name: string) => /Max-Age=0/.test(cookieOf(res, name));
const req = (p: string, cookie: string, body: unknown = {}) =>
  new Request(`https://app.dubiz.test${p}`, {
    method: "POST",
    headers: {
      host: "app.dubiz.test",
      origin: "https://app.dubiz.test",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "198.51.100.7",
      "content-type": "application/json",
      cookie: `${cookie}=${SECRET}`,
    },
    body: JSON.stringify(body),
  });
const ticketOf = (email: string) => async () => ({ email, name: "דנה", expiresAt: new Date(Date.now() + 600_000) });
const linked: CompletedLink = { userId: 7, businessId: 9, identityId: 700, session: { sessionId: "s", credential: "refresh-credential-value", absoluteExpiresAt: new Date(Date.now() + 86_400_000) }, noticeEmailId: 7000 };

async function main() {
  // ── A  the mode ───────────────────────────────────────────────────────────
  ok("A1 unset mode → pilot", cfg({}).access.mode === "pilot");
  ok("A2 mode=pilot → pilot", cfg({ AUTH_GOOGLE_LOGIN_MODE: "pilot" }).access.mode === "pilot");
  for (const v of ["Open", "OPEN", "true", "1", "all", "opened", ""]) {
    ok(`A3 mode=${JSON.stringify(v)} → pilot (only the exact word opens)`, cfg({ AUTH_GOOGLE_LOGIN_MODE: v, AUTH_GOOGLE_LOGIN_PILOT_EMAILS: LISTED }).access.mode === "pilot");
  }
  ok("A4 mode=open → everyone", open.access.mode === "open" && googleLoginAllows(open, OTHER));
  ok("A5 the mode never turns the feature on by itself", !isGoogleLoginEnabled({ AUTH_GOOGLE_LOGIN_MODE: "open", GOOGLE_LOGIN_CLIENT_ID: "x", GOOGLE_LOGIN_CLIENT_SECRET: "y", GOOGLE_LOGIN_REDIRECT_BASE_URL: "https://a.test" }));

  // ── B  the list fails closed ──────────────────────────────────────────────
  const nobody = (label: string, list: string | undefined) => {
    const c = cfg(list === undefined ? {} : { AUTH_GOOGLE_LOGIN_PILOT_EMAILS: list });
    ok(`B nobody: ${label}`, c.access.mode === "pilot" && !googleLoginAllows(c, LISTED) && !googleLoginAllows(c, OTHER) && !googleLoginAllows(c, ""));
  };
  nobody("the list deleted (missing)", undefined);
  nobody("an empty list", "");
  nobody("only separators", " , ,\n");
  nobody("one malformed entry spoils the list", `${LISTED}, not-an-address`);
  nobody("a wildcard", "*");
  nobody("a wildcard address", `*@lab.invalid`);
  nobody("a whole domain", "@lab.invalid");
  nobody("more than 20 entries", Array.from({ length: 21 }, (_, i) => `p${i}@lab.invalid`).join(","));
  ok("B a valid list admits its addresses", googleLoginAllows(pilot, LISTED) && googleLoginAllows(pilot, "second@lab.invalid"));
  ok("B …compared as signup folds them (letter case, spaces)", googleLoginAllows(pilot, "  Pilot.Owner@LAB.invalid "));
  ok("B …and nobody else", !googleLoginAllows(pilot, OTHER) && !googleLoginAllows(pilot, `x${LISTED}`) && !googleLoginAllows(pilot, `${LISTED}.evil.test`));

  // ── C  the button ─────────────────────────────────────────────────────────
  ok("C1 OFF: never shown", !googleButtonVisible(null, "pilot"));
  ok("C2 open: shown with or without the parameter", googleButtonVisible(open, undefined) && googleButtonVisible(open, "existing"));
  ok("C3 pilot: hidden without ?google=pilot", !googleButtonVisible(pilot, undefined) && !googleButtonVisible(pilot, "existing") && !googleButtonVisible(pilot, "Pilot"));
  ok("C4 pilot: hidden for a repeated parameter", !googleButtonVisible(pilot, ["pilot", "pilot"]));
  ok("C5 pilot: shown on ?google=pilot", googleButtonVisible(pilot, "pilot"));
  ok("C6 pilot without a list: the button may show on ?google=pilot, the server still lets nobody in", googleButtonVisible(cfg({}), "pilot") && !googleLoginAllows(cfg({}), LISTED));

  // ── D  the callback ───────────────────────────────────────────────────────
  // No database is configured for this suite: an unlisted address that reached the linked lookup would throw.
  const verified = (email: string): GoogleIdTokenResult => ({ ok: true, identity: { subject: "sub-1", email, name: "דנה" } });
  const outcome = await resolveGoogleCallback({ idToken: "t", nonce: "n", config: pilot, now: new Date(), userAgent: null }, { verify: async () => verified(OTHER) });
  ok("D1 an unlisted address → not_in_pilot, before any lookup", outcome.kind === "not_in_pilot");
  const noList = await resolveGoogleCallback({ idToken: "t", nonce: "n", config: cfg({}), now: new Date(), userAgent: null }, { verify: async () => verified(LISTED) });
  ok("D2 no list → not_in_pilot even for the owner's address", noList.kind === "not_in_pilot");
  const bad = await resolveGoogleCallback({ idToken: "t", nonce: "n", config: pilot, now: new Date(), userAgent: null }, { verify: async () => ({ ok: false, reason: "EMAIL_UNVERIFIED" }) as GoogleIdTokenResult });
  ok("D3 an unverified Google address never reaches the list", bad.kind === "invalid_token");

  const logged: string[] = [];
  const realInfo = console.info;
  console.info = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  const start = newStartState("register");
  let resolved = 0;
  const res = await handleGoogleCallback(
    new Request(`https://app.dubiz.test/api/auth/google/callback?code=c&state=${start.state}`, {
      headers: { cookie: `${GOOGLE_START_COOKIE}=${encodeURIComponent(sealStartState(start))}`, "x-forwarded-for": "198.51.100.8" },
    }),
    {
      config: () => pilot,
      exchange: async () => "id-token",
      resolve: (input) => { resolved += 1; return resolveGoogleCallback(input, { verify: async () => verified(OTHER) }); },
      rateLimit: allow,
      recordUsage: async () => undefined,
    }
  );
  console.info = realInfo;
  ok("D4 the route answers the generic 'unavailable' on the page the person came from", res.status === 303 && (res.headers.get("location") ?? "").endsWith("/register?google=unavailable") && resolved === 1);
  ok("D5 …no ticket, no link, no session cookie; the start cookie cleared",
    cookieOf(res, GOOGLE_TICKET_COOKIE) === "" && cookieOf(res, GOOGLE_LINK_COOKIE) === "" && cookieOf(res, "dubiz_rt") === "" && clearedCookie(res, GOOGLE_START_COOKIE));
  ok("D6 …and the address is not logged", logged.some((l) => l.includes("pilot")) && !logged.some((l) => l.includes(OTHER)));

  // ── E  every completing route ─────────────────────────────────────────────
  // Signup completion
  const account: CreatedGoogleAccount = {
    userId: 7, businessId: 90, email: LISTED, name: "דנה", businessName: "עסק", tokenVersion: 0,
    session: { sessionId: "s", credential: "sid.secret", absoluteExpiresAt: new Date(Date.now() + 86_400_000) },
    welcomeEmailId: 3, identityId: 1,
  };
  const calls = { created: 0, limited: 0, read: 0 };
  const completeDeps = (config: GoogleLoginConfig, email: string | null): CompleteDeps => ({
    config: () => config, isSignupEnabled: () => true,
    signupAllowlist: () => ({ configured: false, size: 0, error: null, has: () => false }) as never,
    readTicket: async () => { calls.read += 1; return email ? ticketOf(email)() : null; },
    rateLimit: async () => { calls.limited += 1; return allow(); },
    createAccount: async () => { calls.created += 1; return account; },
    recordUsage: async () => undefined, scheduleWelcome: () => {},
  });
  const body = { name: "דנה", businessName: "עסק", acceptTerms: true };
  const refused = await handleGoogleComplete(req("/api/auth/google/complete", GOOGLE_TICKET_COOKIE, body), completeDeps(pilot, OTHER));
  ok("E1 signup: an unlisted ticket → 403 GOOGLE_NOT_AVAILABLE, nothing created, the rate limit untouched, the ticket cookie cleared",
    refused.status === 403 && (await refused.json()).code === GOOGLE_NOT_IN_PILOT.code && calls.created === 0 && calls.limited === 0 && clearedCookie(refused, GOOGLE_TICKET_COOKIE)
    && cookieOf(refused, "dubiz_rt") === "");
  const gone = await handleGoogleComplete(req("/api/auth/google/complete", GOOGLE_TICKET_COOKIE, body), completeDeps(pilot, null));
  ok("E2 signup: no open ticket during the pilot → 409, nothing created", gone.status === 409 && calls.created === 0);
  const listed = await handleGoogleComplete(req("/api/auth/google/complete", GOOGLE_TICKET_COOKIE, body), completeDeps(pilot, LISTED));
  ok("E3 signup: a listed ticket completes (one account, a session cookie)", listed.status === 200 && calls.created === 1 && cookieOf(listed, "dubiz_rt") !== "");
  calls.read = 0;
  const opened = await handleGoogleComplete(req("/api/auth/google/complete", GOOGLE_TICKET_COOKIE, body), completeDeps(open, OTHER));
  ok("E4 signup: open mode — anyone completes, the ticket is not read for the pilot", opened.status === 200 && calls.read === 0 && calls.created === 2);

  // Link by password
  const pw = { reserved: 0, compared: 0, completed: 0 };
  const pwDeps = (config: GoogleLoginConfig, email: string): LinkPasswordDeps => ({
    config: () => config,
    readTicket: ticketOf(email),
    findAccount: async () => ({ id: 7, businessId: 9, password: "$2b$10$hash" }) as never,
    rateLimit: allow,
    reserve: async () => { pw.reserved += 1; return { allowed: true, count: 1, retryAfterMs: 0, lock: async () => {}, clear: async () => {} } as never; },
    compare: async () => { pw.compared += 1; return true; },
    complete: async () => { pw.completed += 1; return linked; },
    deliver: () => {},
  });
  const pwRefused = await handleLinkPassword(req("/api/auth/google/link/password", GOOGLE_LINK_COOKIE, { password: "right" }), pwDeps(pilot, OTHER));
  ok("E5 link by password: unlisted → 403 before the ledger, the password and the link; the link cookie cleared",
    pwRefused.status === 403 && pw.reserved === 0 && pw.compared === 0 && pw.completed === 0 && clearedCookie(pwRefused, GOOGLE_LINK_COOKIE) && cookieOf(pwRefused, "dubiz_rt") === "");
  const pwListed = await handleLinkPassword(req("/api/auth/google/link/password", GOOGLE_LINK_COOKIE, { password: "right" }), pwDeps(pilot, LISTED));
  ok("E6 link by password: listed → linked and signed in", pwListed.status === 200 && pw.completed === 1 && cookieOf(pwListed, "dubiz_rt") !== "");

  // Link by email: the request
  let requested = 0;
  const emailDeps = (config: GoogleLoginConfig, email: string) => ({
    config: () => config, readTicket: ticketOf(email), rateLimit: allow,
    request: async () => { requested += 1; return { emailId: 1, businessId: 9 }; }, deliver: () => {},
  });
  const reqRefused = await handleLinkEmailRequest(req("/api/auth/google/link/email", GOOGLE_LINK_COOKIE), emailDeps(pilot, OTHER) as never);
  ok("E7 link email request: unlisted → 403, nothing recorded or sent", reqRefused.status === 403 && requested === 0 && clearedCookie(reqRefused, GOOGLE_LINK_COOKIE));
  const reqListed = await handleLinkEmailRequest(req("/api/auth/google/link/email", GOOGLE_LINK_COOKIE), emailDeps(pilot, LISTED) as never);
  ok("E8 link email request: listed → sent", reqListed.status === 200 && requested === 1);

  // Link by email: the completion
  let spent = 0;
  let readForPilot = 0;
  const doneDeps = (config: GoogleLoginConfig, email: string | null) => ({
    config: () => config,
    readTicket: async () => { readForPilot += 1; return email ? ticketOf(email)() : null; },
    rateLimit: allow,
    complete: async () => { spent += 1; return linked; },
    deliver: () => {},
  });
  const doneRefused = await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", GOOGLE_LINK_COOKIE, { token: "t.v" }), doneDeps(pilot, OTHER));
  ok("E9 link email completion: unlisted → 403, nothing spent, no session", doneRefused.status === 403 && spent === 0 && cookieOf(doneRefused, "dubiz_rt") === "" && clearedCookie(doneRefused, GOOGLE_LINK_COOKIE));
  const doneGone = await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", GOOGLE_LINK_COOKIE, { token: "t.v" }), doneDeps(pilot, null));
  ok("E10 link email completion: no open ticket during the pilot → 409, nothing spent", doneGone.status === 409 && spent === 0);
  const doneListed = await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", GOOGLE_LINK_COOKIE, { token: "t.v" }), doneDeps(pilot, LISTED));
  ok("E11 link email completion: listed → linked and signed in", doneListed.status === 200 && spent === 1 && cookieOf(doneListed, "dubiz_rt") !== "");
  readForPilot = 0;
  const doneOpen = await handleLinkEmailComplete(req("/api/auth/google/link/email/complete", GOOGLE_LINK_COOKIE, { token: "t.v" }), doneDeps(open, OTHER));
  ok("E12 link email completion: open mode — unchanged, the ticket not read for the pilot", doneOpen.status === 200 && readForPilot === 0 && spent === 2);

  // ── F  static ─────────────────────────────────────────────────────────────
  const ROOT = process.cwd();
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const r of ["complete/route.ts", "link/password/route.ts", "link/email/route.ts", "link/email/complete/route.ts"]) {
    ok(`F1 ${r} checks the pilot`, /googleLoginAllows\(config, /.test(read(`app/api/auth/google/${r}`)));
  }
  ok("F2 the callback decision checks the pilot right after the token is verified, before the linked lookup", (() => {
    const s = read("lib/auth/google-sign-in.ts");
    const check = s.indexOf("if (!googleLoginAllows(input.config, identity.email))");
    return check > s.indexOf("const identity: GoogleIdentity = verified.identity;") && check < s.indexOf("await resolveGoogleIdentity(");
  })());
  for (const p of ["app/login/page.tsx", "app/register/page.tsx"]) {
    const s = read(p);
    ok(`F3 ${p} shows the button through googleButtonVisible only`, /googleButtonVisible\(readGoogleLoginConfig\(\), google\)/.test(s) && !/isGoogleLoginEnabled\(\)/.test(s));
  }
  ok("F4 settings: during the pilot the Google card shows only for a connected account",
    /onlyWhenLinked=\{google\.access\.mode === "pilot"\}/.test(read("app/settings/security/page.tsx"))
    && /if \(onlyWhenLinked && !s\.linked && !message\) return null;/.test(read("components/settings/security/google-connection.tsx")));

  console.log(`\n[google-login-pilot] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
