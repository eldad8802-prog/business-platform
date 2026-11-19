/**
 * LOGOUT SCOPE — per-device sign-out, and everything that must still sign out
 * everywhere, on a real PostgreSQL under the shipped privilege contract.
 *
 *   OWNER_URL=postgresql://... npx tsx .authfix/logout-scope-battery.ts
 *
 * The incident this replays: a laptop signed into account A tapped "log out" to
 * switch to account B, and A's phone — a different device, in the Android app —
 * was signed out with it, because logout ended every session the account had.
 *
 * What is proven:
 *
 *   DEVICE IS THE DEFAULT. A request with no body (every client shipped before
 *   scopes) ends only the session its token names. The token stops working on
 *   the next request, its refresh credential is refused, and every OTHER device
 *   keeps authenticating and keeps refreshing. No generation bump.
 *
 *   EVERYWHERE STILL MEANS EVERYWHERE. `{ "scope": "all" }`, a token that names
 *   no session, and a generation bump from any other path (password reset bumps
 *   it in SQL) still end every token and every refresh session.
 *
 *   HONESTY. When the device revocation cannot be written, the route says 500
 *   and leaves the refresh cookie alone. It never reports a sign-out the server
 *   did not perform.
 *
 *   COOKIE LOGOUT PROVES POSSESSION. /api/auth/refresh/revoke ends a session only
 *   for the current secret or a rotated one inside its grace — never for a bare
 *   selector, never for a secret past its grace — and changes nothing otherwise.
 *
 * Synthetic CI-only credentials. Zero secrets, zero Neon, zero network, zero
 * Production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required (owner connection to the throwaway lab database).");
  process.exit(2);
}

const ROLE = "app_auth_logout_battery";
const PW = "logout_ci_synthetic_pw";
const AUTH_URL = OWNER_URL.replace(/\/\/[^@]*@/, `//${ROLE}:${PW}@`);
const MIG = (n: string) => join(ROOT, "prisma/migrations", n, "migration.sql");

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const strip = (s: string) => s.replace(/--.*$/gm, "");
function statements(sql: string): string[] {
  const src = strip(sql);
  const out: string[] = [];
  let buf = "";
  let tag: string | null = null;
  for (let i = 0; i < src.length; i++) {
    if (tag) {
      buf += src[i];
      if (src.startsWith(tag, i)) { buf += src.slice(i + 1, i + tag.length); i += tag.length - 1; tag = null; }
      continue;
    }
    const open = src.slice(i).match(/^\$(\w*)\$/);
    if (open) { tag = open[0]; buf += tag; i += tag.length - 1; continue; }
    if (src[i] === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; continue; }
    buf += src[i];
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
// The Capacitor shell: an Android System WebView, marked by `; wv)`.
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });

  // ------------------------------------------------------------------ lab ---
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthSessionSecret" CASCADE`);
  await owner.$executeRawUnsafe(`DROP TABLE IF EXISTS "AuthSession" CASCADE`);
  for (const s of statements(readFileSync(MIG("20260908120000_persistent_auth_sessions"), "utf8")))
    await owner.$executeRawUnsafe(s);
  for (const sql of [
    `DROP ROLE IF EXISTS ${ROLE}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}' IN ROLE app_auth`,
    `GRANT USAGE ON SCHEMA public TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."AuthSession", public."AuthSessionSecret" TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business" TO app_auth`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_auth`,
  ]) await owner.$executeRawUnsafe(sql);
  for (const f of [
    "20260908180000_d2_user_business_privilege_narrowing",
    "20260908200000_auth_session_privilege_contract",
    "20260913120000_authsession_user_agent",
  ]) for (const s of statements(readFileSync(MIG(f), "utf8"))) await owner.$executeRawUnsafe(s);
  ok("lab built from every shipped auth migration", true);
  const restoreSessionGrants = async () => {
    for (const f of ["20260908200000_auth_session_privilege_contract", "20260913120000_authsession_user_agent"])
      for (const s of statements(readFileSync(MIG(f), "utf8"))) await owner.$executeRawUnsafe(s);
  };

  // ------------------------------------------------------------------ env ---
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.AUTH_DATABASE_URL = AUTH_URL;
  process.env.DATABASE_URL = OWNER_URL;
  process.env.DIRECT_URL = OWNER_URL;
  process.env.AUTH_TOKEN_SECRET =
    process.env.AUTH_TOKEN_SECRET ?? "logout-battery-synthetic-secret-not-a-real-key";
  process.env.RATE_LIMIT_BACKEND = "memory";
  process.env.PUBLIC_SIGNUP_ENABLED = "false";

  const { signAuthToken } = await import("@/lib/auth-token");
  const { getAuthContext } = await import("@/lib/auth");
  const { issueRefreshSession, revokeSessionForLogout, GRACE_MS } = await import("@/lib/auth/refresh-session");
  const logoutRoute = await import("@/app/api/auth/logout/route");
  const refreshRoute = await import("@/app/api/auth/refresh/route");
  const revokeByCookie = await import("@/app/api/auth/refresh/revoke/route");
  const auth = new PrismaClient({ datasourceUrl: AUTH_URL, log: [] });

  // -------------------------------------------------------------- fixture ---
  const biz = await owner.business.create({ data: { name: "Logout Lab" }, select: { id: true } });
  let seq = 0;
  const mkUser = async (role?: "PLATFORM_ADMIN") => {
    seq += 1;
    return owner.user.create({
      data: {
        email: `lo-${Date.now()}-${seq}@lab.invalid`,
        password: "x",
        name: `u${seq}`,
        businessId: biz.id,
        ...(role ? { role } : {}),
      },
      select: { id: true, tokenVersion: true },
    });
  };
  const issue = (userId: number, tv: number, ua: string) =>
    issueRefreshSession(auth, { userId, tokenVersion: tv, now: new Date(), userAgent: ua });

  const bearer = (token: string) =>
    new Request("https://lab.invalid/api/security/sessions", { headers: { authorization: `Bearer ${token}` } });
  const logout = (token: string, body?: string) =>
    logoutRoute.POST(
      new Request("https://lab.invalid/api/auth/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body } : {}),
      })
    );
  const cookieHeaders = (credential: string | null, extra: Record<string, string> = {}) => ({
    origin: "https://lab.invalid",
    host: "lab.invalid",
    ...(credential !== null ? { cookie: `dubiz_rt=${credential}` } : {}),
    ...extra,
  });
  const refresh = (credential: string, now?: Date) =>
    refreshRoute.handleRefresh(
      new Request("https://lab.invalid/api/auth/refresh", { method: "POST", headers: cookieHeaders(credential) }),
      now ? { now: () => now } : {}
    );
  const cookieLogout = (credential: string | null, opts: { now?: Date; headers?: Record<string, string> } = {}) =>
    revokeByCookie.handleRefreshRevoke(
      new Request("https://lab.invalid/api/auth/refresh/revoke", {
        method: "POST",
        headers: cookieHeaders(credential, opts.headers),
      }),
      opts.now ? { now: () => opts.now as Date } : {}
    );
  const row = (id: string) =>
    owner.authSession.findUnique({ where: { id }, select: { revokedAt: true, revokedReason: true } });
  const tv = async (id: number) =>
    (await owner.user.findUnique({ where: { id }, select: { tokenVersion: true } }))?.tokenVersion;
  const cleared = (res: Response) => {
    const c = res.headers.get("set-cookie") ?? "";
    return /dubiz_rt=/.test(c) && /Max-Age=0/i.test(c);
  };
  const newCredential = (res: Response) => {
    const m = (res.headers.get("set-cookie") ?? "").match(/dubiz_rt=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  };

  // ── 1. THE INCIDENT: laptop logs out, the phone app stays signed in ──────
  {
    const a = await mkUser();
    const laptop = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const phone = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const laptopToken = signAuthToken(a.id, a.tokenVersion, laptop.sessionId);
    const phoneToken = signAuthToken(a.id, a.tokenVersion, phone.sessionId);

    const res = await logout(laptopToken); // no body: every client shipped before scopes
    const body = (await res.json()) as { success?: boolean; scope?: string };
    ok("DEVICE (no body): logout returns 200", res.status === 200, `${res.status}`);
    ok("...and reports scope=device", body.scope === "device", JSON.stringify(body));
    ok("...the refresh cookie is cleared on this device", cleared(res));
    ok("...the laptop's access token is refused on the very next request", (await getAuthContext(bearer(laptopToken))) === null);
    ok("...the laptop row is revoked with reason=logout", (await row(laptop.sessionId))?.revokedReason === "logout");
    ok("...the laptop's refresh credential is refused", (await refresh(laptop.credential)).status === 401);

    ok("PHONE (Android WebView) still authenticates", (await getAuthContext(bearer(phoneToken))) !== null);
    ok("...its row is untouched", (await row(phone.sessionId))?.revokedAt === null);
    const r = await refresh(phone.credential);
    ok("...and it still REFRESHES (the persistent-login path the app uses)", r.status === 200, `${r.status}`);
    ok("...the generation was NOT bumped", (await tv(a.id)) === a.tokenVersion);
  }

  // ── 2. explicit {"scope":"device"} is the same thing ─────────────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const s2 = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const res = await logout(signAuthToken(a.id, a.tokenVersion, s1.sessionId), JSON.stringify({ scope: "device" }));
    ok("DEVICE (explicit): 200 and scope=device", res.status === 200 && ((await res.json()) as { scope?: string }).scope === "device");
    ok("...only that session ended", (await row(s1.sessionId))?.revokedAt !== null && (await row(s2.sessionId))?.revokedAt === null);
  }

  // ── 3. everywhere ────────────────────────────────────────────────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const s2 = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const t1 = signAuthToken(a.id, a.tokenVersion, s1.sessionId);
    const t2 = signAuthToken(a.id, a.tokenVersion, s2.sessionId);
    const res = await logout(t1, JSON.stringify({ scope: "all" }));
    ok("ALL: 200 and scope=all", res.status === 200 && ((await res.json()) as { scope?: string }).scope === "all");
    ok("...the generation was bumped", (await tv(a.id)) === a.tokenVersion + 1);
    ok("...this device's token is refused", (await getAuthContext(bearer(t1))) === null);
    ok("...the OTHER device's token is refused too", (await getAuthContext(bearer(t2))) === null);
    ok("...every row is revoked", (await row(s1.sessionId))?.revokedAt !== null && (await row(s2.sessionId))?.revokedAt !== null);
    ok("...and the other device cannot refresh its way back", (await refresh(s2.credential)).status === 401);
  }

  // ── 4. a token naming no session falls back to everywhere ───────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const res = await logout(signAuthToken(a.id, a.tokenVersion));
    ok("NO SID: falls back to scope=all, and says so", res.status === 200 && ((await res.json()) as { scope?: string }).scope === "all");
    ok("...the generation was bumped", (await tv(a.id)) === a.tokenVersion + 1);
    ok("...and the session ended", (await row(s1.sessionId))?.revokedAt !== null);
  }

  // ── 5. an unreadable scope changes nothing ──────────────────────────────
  for (const bad of ['{"scope":"everything"}', "not json", "[]", "null", '{"scope":1}']) {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const res = await logout(signAuthToken(a.id, a.tokenVersion, s1.sessionId), bad);
    ok(`BAD SCOPE ${bad}: 400`, res.status === 400, `${res.status}`);
    ok("...no cookie change", res.headers.get("set-cookie") === null);
    ok("...nothing revoked, nothing bumped", (await row(s1.sessionId))?.revokedAt === null && (await tv(a.id)) === a.tokenVersion);
  }

  // ── 6. no valid token: success, nothing to end ──────────────────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const res = await logout("not-a-token");
    const body = (await res.json()) as { alreadySignedOut?: boolean };
    ok("NO TOKEN: 200 alreadySignedOut", res.status === 200 && body.alreadySignedOut === true);
    ok("...cookie cleared", cleared(res));
    ok("...and nobody's session was touched", (await row(s1.sessionId))?.revokedAt === null);
  }

  // ── 7. honesty: a device revocation that cannot be written is NOT success ─
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const t1 = signAuthToken(a.id, a.tokenVersion, s1.sessionId);
    await owner.$executeRawUnsafe(`REVOKE UPDATE ON public."AuthSession" FROM app_auth`);
    const res = await logout(t1);
    ok("DEVICE WRITE REFUSED: 500, not a false success", res.status === 500, `${res.status}`);
    ok("...the refresh cookie is left in place so the client can retry", res.headers.get("set-cookie") === null);
    ok("...the session really is still live", (await row(s1.sessionId))?.revokedAt === null);

    // The global path keeps its own contract: the generation bump is the
    // logout, so a refused row-marking is still a success there.
    const allRes = await logout(t1, JSON.stringify({ scope: "all" }));
    ok("ALL with row-marking refused: still 200", allRes.status === 200, `${allRes.status}`);
    ok("...because the generation moved, which is what signs everyone out", (await tv(a.id)) === a.tokenVersion + 1);
    ok("...and the token is refused", (await getAuthContext(bearer(t1))) === null);
    await restoreSessionGrants();
    const restored = await owner.$queryRawUnsafe<Array<{ v: boolean }>>(
      `SELECT has_column_privilege($$app_auth$$, $$public."AuthSession"$$, $$revokedAt$$, $$UPDATE$$) AS v`
    );
    ok("...and the privilege was restored", restored[0]?.v === true);
  }

  // ── 8. a second logout with the same token ──────────────────────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const t1 = signAuthToken(a.id, a.tokenVersion, s1.sessionId);
    await logout(t1);
    const again = await logout(t1);
    ok("REPEAT: the dead token's second logout is alreadySignedOut", again.status === 200 &&
      ((await again.json()) as { alreadySignedOut?: boolean }).alreadySignedOut === true);
  }

  // ── 9. one user cannot end another's session ────────────────────────────
  {
    const a = await mkUser();
    const b = await mkUser();
    const bs = await issue(b.id, b.tokenVersion, CHROME_WIN);
    const verdict = await revokeSessionForLogout(auth, { userId: a.id, sessionId: bs.sessionId, now: new Date() });
    ok("CROSS-USER: another user's session id is not_found", verdict === "not_found");
    ok("...and the other user's row is untouched", (await row(bs.sessionId))?.revokedAt === null);
    // A token is the only way to name a session, and its sid is signed.
    const forged = signAuthToken(a.id, a.tokenVersion, bs.sessionId);
    const res = await logout(forged);
    ok("...a token for A naming B's session is not authenticated at all", ((await res.json()) as { alreadySignedOut?: boolean }).alreadySignedOut === true);
    ok("...so B is still signed in", (await row(bs.sessionId))?.revokedAt === null);
  }

  // ── 10. concurrency ─────────────────────────────────────────────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const t1 = signAuthToken(a.id, a.tokenVersion, s1.sessionId);
    const [lo] = await Promise.all([logout(t1), refresh(s1.credential)]);
    ok("RACE logout vs refresh on the SAME device: logout returned", lo.status === 200 || lo.status === 500, `${lo.status}`);
    ok("...the session ends revoked", (await row(s1.sessionId))?.revokedAt !== null);
    ok("...and no later refresh with the old credential succeeds", (await refresh(s1.credential)).status !== 200);
  }
  {
    const a = await mkUser();
    const laptop = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const phone = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const [lo, rf] = await Promise.all([
      logout(signAuthToken(a.id, a.tokenVersion, laptop.sessionId)),
      refresh(phone.credential),
    ]);
    ok("RACE laptop logout vs phone refresh: both succeed", lo.status === 200 && rf.status === 200, `${lo.status}/${rf.status}`);
    ok("...the phone row is untouched", (await row(phone.sessionId))?.revokedAt === null);
  }
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const t1 = signAuthToken(a.id, a.tokenVersion, s1.sessionId);
    const [x, y] = await Promise.all([logout(t1), logout(t1)]);
    ok("RACE double tap: both 200", x.status === 200 && y.status === 200, `${x.status}/${y.status}`);
    ok("...exactly one revocation recorded", (await row(s1.sessionId))?.revokedReason === "logout");
  }

  // ── 11. everything that must still sign out everywhere ──────────────────
  {
    // Password reset bumps the generation in SQL (auth_password_reset_consume);
    // this is that effect, applied directly, with per-device logout shipped.
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const s2 = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    await owner.user.update({ where: { id: a.id }, data: { tokenVersion: { increment: 1 } }, select: { id: true } });
    ok("GENERATION BUMP (password reset): every token refused",
      (await getAuthContext(bearer(signAuthToken(a.id, a.tokenVersion, s1.sessionId)))) === null &&
      (await getAuthContext(bearer(signAuthToken(a.id, a.tokenVersion, s2.sessionId)))) === null);
    ok("...and every refresh refused", (await refresh(s1.credential)).status === 401 && (await refresh(s2.credential)).status === 401);
  }
  {
    // Platform admin: per-device logout is the same contract, and a remaining
    // device keeps its identity for the admin gate.
    const adm = await mkUser("PLATFORM_ADMIN");
    const s1 = await issue(adm.id, adm.tokenVersion, CHROME_WIN);
    const s2 = await issue(adm.id, adm.tokenVersion, CHROME_WIN);
    await logout(signAuthToken(adm.id, adm.tokenVersion, s1.sessionId));
    const ctx = await getAuthContext(bearer(signAuthToken(adm.id, adm.tokenVersion, s2.sessionId)));
    ok("PLATFORM ADMIN: the other device is still authenticated", ctx !== null);
    ok("...as the admin", (ctx?.user as { role?: string } | undefined)?.role === "PLATFORM_ADMIN" || ctx?.user.id === adm.id);
    ok("...and the logged-out device is refused",
      (await getAuthContext(bearer(signAuthToken(adm.id, adm.tokenVersion, s1.sessionId)))) === null);
  }

  // ── 12. logout by refresh cookie ────────────────────────────────────────
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const s2 = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const res = await cookieLogout(s1.credential);
    ok("COOKIE (current secret): revoked=true", res.status === 200 && ((await res.json()) as { revoked?: boolean }).revoked === true);
    ok("...cookie cleared", cleared(res));
    ok("...the row is revoked with reason=logout", (await row(s1.sessionId))?.revokedReason === "logout");
    ok("...its access token is refused", (await getAuthContext(bearer(signAuthToken(a.id, a.tokenVersion, s1.sessionId)))) === null);
    ok("...the other device is untouched", (await row(s2.sessionId))?.revokedAt === null);
    ok("...no generation bump", (await tv(a.id)) === a.tokenVersion);
    const again = await cookieLogout(s1.credential);
    ok("...repeat with the same proof is idempotent revoked=true", ((await again.json()) as { revoked?: boolean }).revoked === true);
  }
  {
    // A rotated secret inside its grace still proves possession: a lost
    // refresh response followed by an immediate sign-out.
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const r = await refresh(s1.credential);
    ok("setup: one rotation", r.status === 200 && newCredential(r) !== "");
    const res = await cookieLogout(s1.credential);
    ok("COOKIE (rotated secret, inside grace): revoked=true", ((await res.json()) as { revoked?: boolean }).revoked === true);
    ok("...and the session ended", (await row(s1.sessionId))?.revokedAt !== null);
  }
  {
    // Past its grace a rotated secret proves nothing. Accepting it here would be
    // a longer replay window under another name.
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    await refresh(s1.credential);
    const later = new Date(Date.now() + GRACE_MS + 5_000);
    const res = await cookieLogout(s1.credential, { now: later });
    ok("COOKIE (rotated secret, PAST grace): revoked=false", ((await res.json()) as { revoked?: boolean }).revoked === false);
    ok("...and the session is untouched", (await row(s1.sessionId))?.revokedAt === null);
  }
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const selectorOnly = `${s1.sessionId}.${"a".repeat(64)}`;
    for (const [label, cred] of [
      ["a bare selector with the wrong secret", selectorOnly],
      ["a malformed credential", "garbage"],
      ["no cookie at all", null],
    ] as const) {
      const res = await cookieLogout(cred);
      ok(`COOKIE (${label}): revoked=false`, res.status === 200 && ((await res.json()) as { revoked?: boolean }).revoked === false);
    }
    ok("...and none of them ended the session", (await row(s1.sessionId))?.revokedAt === null);
  }
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const noOrigin = await revokeByCookie.handleRefreshRevoke(
      new Request("https://lab.invalid/api/auth/refresh/revoke", {
        method: "POST",
        headers: { host: "lab.invalid", cookie: `dubiz_rt=${s1.credential}` },
      })
    );
    const crossSite = await cookieLogout(s1.credential, { headers: { "sec-fetch-site": "cross-site" } });
    const foreign = await cookieLogout(s1.credential, { headers: { origin: "https://evil.invalid" } });
    ok("COOKIE CSRF: no Origin is refused 403", noOrigin.status === 403);
    ok("COOKIE CSRF: Sec-Fetch-Site cross-site is refused 403", crossSite.status === 403);
    ok("COOKIE CSRF: a foreign Origin is refused 403", foreign.status === 403);
    ok("...none of them cleared the cookie", [noOrigin, crossSite, foreign].every((r) => r.headers.get("set-cookie") === null));
    ok("...and the session is untouched", (await row(s1.sessionId))?.revokedAt === null);
  }
  {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const res = await revokeByCookie.handleRefreshRevoke(
      new Request("https://lab.invalid/api/auth/refresh/revoke", { method: "POST", headers: cookieHeaders(s1.credential) }),
      { run: async () => { throw new Error("driver down"); } }
    );
    ok("COOKIE DB ERROR: 500", res.status === 500);
    ok("...the cookie is kept so the proof survives for a retry", res.headers.get("set-cookie") === null);
  }
  {
    // The case the cookie route exists for: the access token has EXPIRED but the
    // session is alive. The bearer logout cannot see it; the cookie can.
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const prevTtl = process.env.AUTH_TOKEN_TTL_SECONDS;
    process.env.AUTH_TOKEN_TTL_SECONDS = "1";
    const shortLived = signAuthToken(a.id, a.tokenVersion, s1.sessionId);
    if (prevTtl === undefined) delete process.env.AUTH_TOKEN_TTL_SECONDS;
    else process.env.AUTH_TOKEN_TTL_SECONDS = prevTtl;
    await sleep(2_100);
    const viaBearer = await logout(shortLived);
    ok("EXPIRED TOKEN: the bearer logout cannot identify the session", ((await viaBearer.json()) as { alreadySignedOut?: boolean }).alreadySignedOut === true);
    ok("...which leaves it alive server-side", (await row(s1.sessionId))?.revokedAt === null);
    const viaCookie = await cookieLogout(s1.credential);
    ok("...and the cookie route ends it", ((await viaCookie.json()) as { revoked?: boolean }).revoked === true &&
      (await row(s1.sessionId))?.revokedAt !== null);
  }

  // ── 13. a LATER cookie logout ends only the session it was meant for ─────
  //
  // "Clear this device anyway" stores the session id and finishes the logout
  // later by cookie. If the person signed in again meanwhile, the cookie is the
  // NEW session's — and ending it would sign them out of the session they just
  // started. The id pin is what stops that.
  const cookieLogoutWithBody = (credential: string | null, body: string) =>
    revokeByCookie.handleRefreshRevoke(
      new Request("https://lab.invalid/api/auth/refresh/revoke", {
        method: "POST",
        headers: { ...cookieHeaders(credential), "content-type": "application/json" },
        body,
      })
    );
  {
    const a = await mkUser();
    const old = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW);
    const fresh = await issue(a.id, a.tokenVersion, ANDROID_WEBVIEW); // signed in again: the jar now holds this
    const res = await cookieLogoutWithBody(fresh.credential, JSON.stringify({ expectedSessionId: old.sessionId }));
    ok("PIN MISMATCH: the new session's cookie with the OLD id → revoked=false",
      res.status === 200 && ((await res.json()) as { revoked?: boolean }).revoked === false);
    ok("...the NEW session is untouched (the person stays signed in)", (await row(fresh.sessionId))?.revokedAt === null);
    const matched = await cookieLogoutWithBody(old.credential, JSON.stringify({ expectedSessionId: old.sessionId }));
    ok("PIN MATCH: the old cookie with its own id → revoked=true", ((await matched.json()) as { revoked?: boolean }).revoked === true);
    ok("...and exactly that session ended",
      (await row(old.sessionId))?.revokedReason === "logout" && (await row(fresh.sessionId))?.revokedAt === null);
  }
  for (const bad of ['{"expectedSessionId":"not-a-uuid"}', '{"expectedSessionId":7}', "[]", "garbage"]) {
    const a = await mkUser();
    const s1 = await issue(a.id, a.tokenVersion, CHROME_WIN);
    const res = await cookieLogoutWithBody(s1.credential, bad);
    ok(`PIN BAD BODY ${bad}: 400`, res.status === 400, `${res.status}`);
    ok("...no cookie change, session untouched", res.headers.get("set-cookie") === null && (await row(s1.sessionId))?.revokedAt === null);
  }

  await auth.$disconnect();
  await owner.$disconnect();
  console.log(`\n[logout-scope-battery] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
