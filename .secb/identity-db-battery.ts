/**
 * sec-B — identity, session and admin authority: DB-backed behavioural battery.
 *
 *   OWNER_URL=postgresql://owner@host:port/db npx tsx .secb/identity-db-battery.ts
 *
 * Preconditions: the database was built by `.secb/build-lab.sh` (prisma migrate
 * deploy — the SHIPPED grants for app_auth / app_runtime are in place).
 *
 * Drives the REAL route handlers with real Request objects, as two fresh
 * NON-OWNER, NOBYPASSRLS login roles: one in app_auth (auth plane), one in
 * app_runtime (tenant plane). Every assertion carries a stable LABEL; the
 * negative proofs in .secb/mutate.mjs name the label they must turn red.
 *
 * Synthetic credentials only. No network (the "failing Redis" is 127.0.0.1:9).
 */

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required");
  process.exit(2);
}

const AUTH_ROLE = "secb_auth_login";
const RT_ROLE = "secb_rt_login";
const PW = "secb_ci_synthetic_pw";
const asRole = (role: string) => OWNER_URL.replace(/\/\/[^@/]*@/, `//${role}:${PW}@`);

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  - ${label}`);
  } else {
    fail += 1;
    console.error(`FAIL  - ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let ipSeq = 0;
const freshIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request(`https://lab.invalid${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function useFailingRedis(on: boolean): void {
  if (on) {
    process.env.RATE_LIMIT_BACKEND = "redis";
    process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9";
    process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic";
  } else {
    process.env.RATE_LIMIT_BACKEND = "memory";
  }
}

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });

  // ── roles: fresh, non-owner, NOBYPASSRLS, attached to the shipped groups ──
  for (const sql of [
    `DROP ROLE IF EXISTS ${AUTH_ROLE}`,
    `DROP ROLE IF EXISTS ${RT_ROLE}`,
    `CREATE ROLE ${AUTH_ROLE} LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${PW}' IN ROLE app_auth`,
    `CREATE ROLE ${RT_ROLE} LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${PW}' IN ROLE app_runtime`,
    `GRANT USAGE ON SCHEMA public TO app_auth, app_runtime`,
    // The admin MFA service runs on the runtime plane (T-04, workstream C owns
    // moving it). Production's runtime holds DML on it via its broad grant; the
    // migrations do not carry that grant, so the lab states it explicitly.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "PlatformAdminMfa" TO app_runtime`,
    `GRANT USAGE ON SEQUENCE "PlatformAdminMfa_id_seq" TO app_runtime`,
    // Usage telemetry (swallowed on failure, but noisy): same reason as above.
    `GRANT SELECT, INSERT ON "ProductUsageEvent" TO app_runtime`,
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_runtime`,
  ]) await owner.$executeRawUnsafe(sql);
  const roleAttrs = await owner.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('${AUTH_ROLE}','${RT_ROLE}')`
  );
  ok("LAB: both login roles are non-superuser NOBYPASSRLS", roleAttrs.length === 2 && roleAttrs.every((r) => !r.rolsuper && !r.rolbypassrls));

  // ── environment, BEFORE any app module is imported ──
  Object.assign(process.env, {
    AUTH_PLANE_ENABLED: "true",
    AUTH_DATABASE_URL: asRole(AUTH_ROLE),
    DATABASE_URL: asRole(RT_ROLE),
    DIRECT_URL: asRole(RT_ROLE),
    AUTH_TOKEN_SECRET: "secb-battery-synthetic-secret-not-a-real-key",
    ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    PUBLIC_SIGNUP_ENABLED: "true",
    PLATFORM_ADMIN_EMAILS: "admin@secb.lab.invalid",
    NEXT_PUBLIC_APP_URL: "https://lab.invalid",
    RATE_LIMIT_REDIS_TIMEOUT_MS: "300",
  });
  delete process.env.PLATFORM_ADMIN_MFA_REQUIRED;
  delete process.env.PLATFORM_ADMIN_ENROLLMENT_CODE_HASH;
  useFailingRedis(false);

  const bcrypt = (await import("bcrypt")).default;
  const { signAuthToken } = await import("@/lib/auth-token");
  const { getAuthContext } = await import("@/lib/auth");
  const { handleLogin } = await import("@/app/api/auth/login/route");
  const { handlePasswordChange } = await import("@/app/api/auth/password/change/route");
  const { handleResetRequest } = await import("@/app/api/auth/password/reset/request/route");
  const { handleResetConfirm } = await import("@/app/api/auth/password/reset/confirm/route");
  const { handleStepUp } = await import("@/app/api/auth/step-up/route");
  const { handleCookieLogout } = await import("@/app/api/auth/refresh/logout/route");
  const { handleRefresh } = await import("@/app/api/auth/refresh/route");
  const { handleRegister } = await import("@/app/api/auth/register/route");
  const accountRoute = await import("@/app/api/account/route");
  const revokeOthersRoute = await import("@/app/api/security/sessions/revoke-others/route");
  const enrollRoute = await import("@/app/api/platform-admin/mfa/enroll/route");
  const confirmRoute = await import("@/app/api/platform-admin/mfa/confirm/route");
  const { requirePlatformAdmin } = await import("@/lib/auth/platform-admin");
  const { issuePasswordResetToken } = await import("@/lib/auth/password-reset");
  const { issueSession } = await import("@/lib/auth/session-directory");
  const { verifyAdminMfaCode } = await import("@/lib/auth/admin-mfa.service");
  const { resetMemoryBackendForTests } = await import("@/lib/security/rate-limiter/memory-backend");
  const OTPAuth = await import("otpauth");

  // ── fixtures (owner writes; the code under test never runs as owner) ──
  const PASSWORD = "Lab-Password-9431";
  const hash = await bcrypt.hash(PASSWORD, 10);
  const biz = await owner.business.create({ data: { name: "SecB Lab" }, select: { id: true } });
  let seq = 0;
  const mkUser = async (over: { email?: string; businessId?: number; role?: "PLATFORM_ADMIN" } = {}) => {
    seq += 1;
    return owner.user.create({
      data: {
        email: over.email ?? `u${seq}-${Date.now()}@secb.lab.invalid`,
        password: hash,
        name: `u${seq}`,
        businessId: over.businessId ?? biz.id,
        ...(over.role ? { role: over.role } : {}),
      },
      select: { id: true, email: true, tokenVersion: true },
    });
  };
  const tvOf = async (id: number) =>
    (await owner.user.findUniqueOrThrow({ where: { id }, select: { tokenVersion: true } })).tokenVersion;
  const liveSessions = (userId: number) => owner.authSession.count({ where: { userId, revokedAt: null } });
  const loginAs = async (email: string, password = PASSWORD) => {
    const res = await handleLogin(jsonReq("/api/auth/login", { email, password }));
    const body = (await res.json().catch(() => ({}))) as { token?: string };
    return { status: res.status, token: body.token ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
  };
  const cookieOf = (setCookie: string) => /dubiz_rt=([^;]+)/.exec(setCookie)?.[1] ?? "";

  // ════════════════════════════ LOGIN (M-7) ════════════════════════════
  {
    const alice = await mkUser();
    const good = await loginAs(alice.email);
    ok("LOGIN-OK: correct password → 200 with a session-bound token", good.status === 200 && (await getAuthContext(new Request("https://x", { headers: bearer(good.token) })))?.sessionId != null);

    // Timing/enumeration: exactly one bcrypt comparison either way, same answer.
    let compares = 0;
    const counting = async (p: string, h: string) => {
      compares += 1;
      return bcrypt.compare(p, h);
    };
    compares = 0;
    const unknown = await handleLogin(jsonReq("/api/auth/login", { email: "nobody-here@secb.lab.invalid", password: "whatever-123" }), { compare: counting });
    const unknownCompares = compares;
    compares = 0;
    const wrong = await handleLogin(jsonReq("/api/auth/login", { email: alice.email, password: "wrong-password-1" }), { compare: counting });
    const wrongCompares = compares;
    ok("LOGIN-TIMING: unknown email runs exactly one bcrypt compare", unknownCompares === 1, `compares=${unknownCompares}`);
    ok("LOGIN-TIMING: wrong password runs exactly one bcrypt compare", wrongCompares === 1);
    const ub = await unknown.json();
    const wb = await wrong.json();
    ok("LOGIN-ENUM: unknown email and wrong password give identical status+body", unknown.status === 401 && wrong.status === 401 && JSON.stringify(ub) === JSON.stringify(wb));

    // Per-(account, IP): 5/min. Same for an address with no account.
    const ip = "10.99.0.1";
    const burst = async (email: string) => {
      const out: number[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await handleLogin(
          new Request("https://lab.invalid/api/auth/login", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify({ email, password: "wrong-password-1" }),
          })
        );
        out.push(r.status);
        if (i === 5) return { statuses: out, body: await r.json() };
      }
      throw new Error("unreachable");
    };
    const bob = await mkUser();
    const existing = await burst(bob.email);
    const ghost = await burst("ghost-account@secb.lab.invalid");
    ok("LOGIN-ACCOUNT-IP: 6th attempt on one account from one address is 429", existing.statuses[5] === 429);
    ok("LOGIN-ENUM-THROTTLE: throttled response identical for existing and non-existing account", ghost.statuses[5] === 429 && JSON.stringify(existing.body) === JSON.stringify(ghost.body));

    // Distributed guessing against ONE account from many addresses.
    const carol = await mkUser();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await handleLogin(jsonReq("/api/auth/login", { email: carol.email, password: "wrong-password-1" }))).status;
    }
    ok("LOGIN-DISTRIBUTED: 21st attempt on one account from fresh IPs is throttled", last === 429, `status=${last}`);
    const carolAfter = await loginAs(carol.email);
    ok("LOGIN-DISTRIBUTED: even the right password is throttled while the account is under attack", carolAfter.status === 429);

    // Fail-CLOSED: the limiter backend is down.
    useFailingRedis(true);
    const before = await liveSessions(alice.id);
    compares = 0;
    const down = await handleLogin(jsonReq("/api/auth/login", { email: alice.email, password: PASSWORD }), { compare: counting });
    useFailingRedis(false);
    ok("LOGIN-FAILCLOSED: backend down → 503", down.status === 503, `status=${down.status}`);
    ok("LOGIN-FAILCLOSED: no password comparison and no session while the limiter is down", compares === 0 && (await liveSessions(alice.id)) === before);

    // Lifecycle (AUTH-12).
    const qBiz = await owner.business.create({ data: { name: "Quarantined", deletionRequestedAt: new Date() }, select: { id: true } });
    const qUser = await mkUser({ businessId: qBiz.id });
    const q = await loginAs(qUser.email);
    ok("LOGIN-LIFECYCLE: correct password on a quarantined business gets no session (403)", q.status === 403 && q.token === "" && (await owner.authSession.count({ where: { userId: qUser.id } })) === 0, `status=${q.status}`);
  }

  // ════════════════════════ PASSWORD CHANGE (M-7) ═══════════════════════
  {
    const dana = await mkUser();
    const phone = await loginAs(dana.email);
    const laptop = await loginAs(dana.email);
    const phoneCookie = cookieOf(phone.setCookie);

    const wrongCur = await handlePasswordChange(jsonReq("/api/auth/password/change", { currentPassword: "nope-nope-1", newPassword: "Fresh-Password-5521" }, bearer(laptop.token)));
    ok("CHANGE-CURRENT: wrong current password → 403, generation unchanged", wrongCur.status === 403 && (await tvOf(dana.id)) === dana.tokenVersion);

    const weak = await handlePasswordChange(jsonReq("/api/auth/password/change", { currentPassword: PASSWORD, newPassword: "short" }, bearer(laptop.token)));
    ok("CHANGE-POLICY: a weak new password → 400 PASSWORD_POLICY", weak.status === 400 && (await weak.json()).code === "PASSWORD_POLICY");

    const res = await handlePasswordChange(jsonReq("/api/auth/password/change", { currentPassword: PASSWORD, newPassword: "Fresh-Password-5521" }, { ...bearer(laptop.token), "user-agent": "lab" }));
    const body = (await res.json()) as { token?: string };
    ok("CHANGE-OK: 200 and a fresh token for this device", res.status === 200 && typeof body.token === "string");
    ok("CHANGE-OK: the fresh token authenticates", (await getAuthContext(new Request("https://x", { headers: bearer(body.token ?? "") }))) !== null);
    ok("CHANGE-KILLS-TOKENS: the other device's access token is refused", (await getAuthContext(new Request("https://x", { headers: bearer(phone.token) }))) === null);
    ok("CHANGE-KILLS-TOKENS: this device's OLD token is refused too", (await getAuthContext(new Request("https://x", { headers: bearer(laptop.token) }))) === null);
    ok("CHANGE-REVOKES: other sessions' rows are revoked (only the new one is live)", (await liveSessions(dana.id)) === 1);
    const r = await handleRefresh(new Request("https://lab.invalid/api/auth/refresh", { method: "POST", headers: { origin: "https://lab.invalid", host: "lab.invalid", cookie: `dubiz_rt=${phoneCookie}` } }));
    ok("CHANGE-KILLS-REFRESH: the other device's refresh credential is dead", r.status === 401);
    ok("CHANGE-HASH: old password no longer logs in", (await loginAs(dana.email)).status === 401);
    ok("CHANGE-HASH: new password logs in (hash written under the runtime role's shipped grant)", (await loginAs(dana.email, "Fresh-Password-5521")).status === 200);

    // Rate limit (per user, fail-closed bucket).
    const erin = await mkUser();
    const et = (await loginAs(erin.email)).token;
    let st = 0;
    for (let i = 0; i < 6; i++) st = (await handlePasswordChange(jsonReq("/api/auth/password/change", { currentPassword: "bad-guess-000", newPassword: "Fresh-Password-5521" }, bearer(et)))).status;
    ok("CHANGE-RATELIMIT: 6th wrong current-password attempt is 429", st === 429);
  }

  // ═════════════════════════ PASSWORD RESET (M-7) ═══════════════════════
  {
    const frank = await mkUser();
    const sent: { to: string; resetUrl: string }[] = [];
    const configuredSender = { configured: true, async send(m: { to: string; resetUrl: string }) { sent.push(m); } };
    const disabledSender = { configured: false, async send() { throw new Error("never"); } };

    const r1 = await handleResetRequest(jsonReq("/api/auth/password/reset/request", { email: frank.email }), { sender: disabledSender, floorMs: 0 });
    const r2 = await handleResetRequest(jsonReq("/api/auth/password/reset/request", { email: "no-such@secb.lab.invalid" }), { sender: disabledSender, floorMs: 0 });
    ok("RESET-ENUM: disabled sender → identical generic 200 for existing and unknown address", r1.status === 200 && r2.status === 200 && JSON.stringify(await r1.json()) === JSON.stringify(await r2.json()));

    const r3 = await handleResetRequest(jsonReq("/api/auth/password/reset/request", { email: frank.email.toUpperCase() }), { sender: configuredSender, floorMs: 0 });
    const r4 = await handleResetRequest(jsonReq("/api/auth/password/reset/request", { email: "no-such-2@secb.lab.invalid" }), { sender: configuredSender, floorMs: 0 });
    ok("RESET-ENUM: configured sender → identical generic 200 either way", JSON.stringify(await r3.json()) === JSON.stringify(await r4.json()));
    ok("RESET-DELIVERY: exactly one message, to the account's own address", sent.length === 1 && sent[0].to === frank.email);
    const token = decodeURIComponent(/token=([^&]+)/.exec(sent[0]?.resetUrl ?? "")?.[1] ?? "");

    const blocked = await handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token, newPassword: "Reset-Password-7710" }), { senderConfigured: false });
    ok("RESET-FAILCLOSED: with no configured sender even a valid token is refused", blocked.status === 400 && (await tvOf(frank.id)) === frank.tokenVersion);

    const sess = await loginAs(frank.email);
    const done = await handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token, newPassword: "Reset-Password-7710" }), { senderConfigured: true });
    ok("RESET-OK: confirm → 200, generation moved", done.status === 200 && (await tvOf(frank.id)) === frank.tokenVersion + 1);
    ok("RESET-REVOKES: every session revoked and the old token refused", (await liveSessions(frank.id)) === 0 && (await getAuthContext(new Request("https://x", { headers: bearer(sess.token) }))) === null);
    ok("RESET-HASH: new password logs in", (await loginAs(frank.email, "Reset-Password-7710")).status === 200);
    const again = await handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token, newPassword: "Another-Password-8821" }), { senderConfigured: true });
    ok("RESET-SINGLEUSE: the same token a second time is refused", again.status === 400);

    // Race: two concurrent confirms of one token → exactly one wins.
    const gina = await mkUser();
    const subject = { id: gina.id, tokenVersion: gina.tokenVersion, passwordHash: hash };
    const raceToken = issuePasswordResetToken(subject);
    const [a, b] = await Promise.all([
      handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token: raceToken, newPassword: "Race-Password-A-1" }), { senderConfigured: true }),
      handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token: raceToken, newPassword: "Race-Password-B-2" }), { senderConfigured: true }),
    ]);
    ok("RESET-RACE: exactly one of two concurrent confirms wins", [a.status, b.status].sort().join(",") === "200,400", `${a.status},${b.status}`);
    ok("RESET-RACE: the generation moved exactly once", (await tvOf(gina.id)) === gina.tokenVersion + 1);

    const hank = await mkUser();
    const expired = issuePasswordResetToken({ id: hank.id, tokenVersion: hank.tokenVersion, passwordHash: hash }, Date.now() - 31 * 60 * 1000);
    ok("RESET-EXPIRY: a 31-minute-old token is refused", (await handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token: expired, newPassword: "Expired-Password-1" }), { senderConfigured: true })).status === 400);
    const stale = issuePasswordResetToken({ id: hank.id, tokenVersion: hank.tokenVersion, passwordHash: hash });
    await owner.user.update({ where: { id: hank.id }, data: { tokenVersion: { increment: 1 } } });
    ok("RESET-BINDING: a token issued before a logout (generation moved) is refused", (await handleResetConfirm(jsonReq("/api/auth/password/reset/confirm", { token: stale, newPassword: "Stale-Password-11" }), { senderConfigured: true })).status === 400);
  }

  // ═════════════════════════════ STEP-UP (M-9) ══════════════════════════
  {
    const biz2 = await owner.business.create({ data: { name: "StepUp Lab" }, select: { id: true } });
    const ivy = await mkUser({ businessId: biz2.id });
    await mkUser({ businessId: biz2.id }); // second user: deletion would be 409, never executed
    const s1 = await loginAs(ivy.email);
    const s2 = await loginAs(ivy.email);

    const noStep = await accountRoute.DELETE(jsonReq("/api/account", undefined, bearer(s1.token), "DELETE") as never);
    ok("STEPUP-ACCOUNT: DELETE without step-up is refused 403 STEP_UP_REQUIRED", noStep.status === 403 && (await noStep.json()).code === "STEP_UP_REQUIRED");
    const noStepOthers = await revokeOthersRoute.POST(jsonReq("/api/security/sessions/revoke-others", undefined, bearer(s1.token)));
    ok("STEPUP-REVOKE: revoke-others without step-up is refused 403", noStepOthers.status === 403 && (await liveSessions(ivy.id)) === 2);

    const bad = await handleStepUp(jsonReq("/api/auth/step-up", { password: "not-it-000", action: "account.delete" }, bearer(s1.token)));
    ok("STEPUP-PASSWORD: wrong password → 403, no token", bad.status === 403);
    const getTok = async (tok: string, action: string) =>
      ((await (await handleStepUp(jsonReq("/api/auth/step-up", { password: PASSWORD, action }, bearer(tok)))).json()) as { stepUpToken?: string }).stepUpToken ?? "";

    const forOthers = await getTok(s1.token, "sessions.revoke_others");
    const wrongAction = await accountRoute.DELETE(jsonReq("/api/account", undefined, { ...bearer(s1.token), "x-step-up": forOthers }, "DELETE") as never);
    ok("STEPUP-ACTION: a revoke-others step-up cannot delete the account", wrongAction.status === 403);

    const forDelete = await getTok(s1.token, "account.delete");
    const passes = await accountRoute.DELETE(jsonReq("/api/account", undefined, { ...bearer(s1.token), "x-step-up": forDelete }, "DELETE") as never);
    const pb = (await passes.json()) as { code?: string };
    ok("STEPUP-ACCOUNT: a valid step-up passes the gate (reaches the deletion service: 409 not_sole_user)", passes.status !== 403 && pb.code !== "STEP_UP_REQUIRED", `status=${passes.status} code=${pb.code}`);

    const fromOtherDevice = await getTok(s2.token, "sessions.revoke_others");
    const crossDev = await revokeOthersRoute.POST(jsonReq("/api/security/sessions/revoke-others", undefined, { ...bearer(s1.token), "x-step-up": fromOtherDevice }));
    ok("STEPUP-BINDING: a step-up minted on another device session is refused", crossDev.status === 403 && (await liveSessions(ivy.id)) === 2);

    const good = await getTok(s1.token, "sessions.revoke_others");
    const used = await revokeOthersRoute.POST(jsonReq("/api/security/sessions/revoke-others", undefined, { ...bearer(s1.token), "x-step-up": good }));
    ok("STEPUP-REVOKE: with a valid step-up the other device is signed out", used.status === 200 && (await liveSessions(ivy.id)) === 1);
    const reused = await revokeOthersRoute.POST(jsonReq("/api/security/sessions/revoke-others", undefined, { ...bearer(s1.token), "x-step-up": good }));
    ok("STEPUP-SINGLEUSE: the same step-up token a second time is refused", reused.status === 403 && (await reused.json()).code === "STEP_UP_REQUIRED");

    // A different user: the step-up bucket (5 per user per 5 min) is spent above.
    const jill = await mkUser();
    const j1 = await loginAs(jill.email);
    await loginAs(jill.email);
    const fresh = await getTok(j1.token, "sessions.revoke_others");
    useFailingRedis(true);
    const down = await revokeOthersRoute.POST(jsonReq("/api/security/sessions/revoke-others", undefined, { ...bearer(j1.token), "x-step-up": fresh }));
    useFailingRedis(false);
    ok("STEPUP-FAILCLOSED: single-use store down → 503, nothing revoked", fresh !== "" && down.status === 503 && (await liveSessions(jill.id)) === 2, `status=${down.status}`);
  }

  // ═══════════════════════ COOKIE LOGOUT / REGISTER (L-9) ═══════════════
  {
    const jay = await mkUser();
    const a = await loginAs(jay.email);
    await loginAs(jay.email);
    const cookie = cookieOf(a.setCookie);
    const csrfBad = await handleCookieLogout(new Request("https://lab.invalid/api/auth/refresh/logout", { method: "POST", headers: { host: "lab.invalid", cookie: `dubiz_rt=${cookie}` } }));
    ok("COOKIE-LOGOUT-CSRF: no Origin → 403 and nothing revoked", csrfBad.status === 403 && (await liveSessions(jay.id)) === 2);
    const bogus = await handleCookieLogout(new Request("https://lab.invalid/api/auth/refresh/logout", { method: "POST", headers: { origin: "https://lab.invalid", host: "lab.invalid", cookie: `dubiz_rt=${cookie.split(".")[0]}.${"0".repeat(64)}` } }));
    ok("COOKIE-LOGOUT-UNKNOWN: an unknown secret changes nothing", bogus.status === 200 && (await liveSessions(jay.id)) === 2);
    // The access token has "expired": this endpoint needs none.
    const out = await handleCookieLogout(new Request("https://lab.invalid/api/auth/refresh/logout", { method: "POST", headers: { origin: "https://lab.invalid", host: "lab.invalid", cookie: `dubiz_rt=${cookie}` } }));
    ok("COOKIE-LOGOUT: refresh sessions revoked without an access token", out.status === 200 && (await liveSessions(jay.id)) === 0);
    ok("COOKIE-LOGOUT: generation moved (every access token dead)", (await tvOf(jay.id)) === jay.tokenVersion + 1 && (await getAuthContext(new Request("https://x", { headers: bearer(a.token) }))) === null);
    ok("COOKIE-LOGOUT: cookie cleared", /dubiz_rt=;/.test(out.headers.get("set-cookie") ?? ""));

    // Account creation is injected (owner client): under the SHIPPED auth-plane
    // grants signup itself fails 42501 — Prisma sends "createdAt" on INSERT and
    // app_auth holds no INSERT on it (pre-existing defect, reported separately).
    // What this proves is the session half, which runs on the real auth plane.
    const reg = await handleRegister(
      jsonReq("/api/auth/register", { email: `reg-${Date.now()}@secb.lab.invalid`, password: "Register-Password-31", name: "בעל עסק", businessName: "עסק מעבדה" }, { "user-agent": "lab" }),
      {
        isSignupEnabled: () => true,
        rateLimit: async () => ({ allowed: true, remaining: 1, resetAt: 0 }),
        hashPassword: (p: string) => bcrypt.hash(p, 10),
        createAccount: async (input) => {
          const b = await owner.business.create({ data: { name: input.businessName }, select: { id: true, name: true } });
          const u = await owner.user.create({ data: { email: input.email, password: input.passwordHash, name: input.name, businessId: b.id }, select: { id: true, email: true, tokenVersion: true } });
          return { userId: u.id, businessId: b.id, email: u.email, name: input.name, businessName: b.name, tokenVersion: u.tokenVersion };
        },
        signToken: signAuthToken,
        issueSession,
        recordUsage: async () => {},
      }
    );
    const rb = (await reg.json()) as { token?: string };
    const ctx = rb.token ? await getAuthContext(new Request("https://x", { headers: bearer(rb.token) })) : null;
    ok("REGISTER-SID: the signup token names a real, live session", reg.status === 200 && ctx?.sessionId != null);
    ok("REGISTER-SID: the refresh cookie is set", /dubiz_rt=[^;]+\./.test(reg.headers.get("set-cookie") ?? ""));
  }

  // ═══════════════════════════ ADMIN MFA (M-10 / L-10) ══════════════════
  {
    const adminEmail = `admin-${Date.now()}@secb.lab.invalid`;
    process.env.PLATFORM_ADMIN_EMAILS = adminEmail;
    const admin = await mkUser({ email: adminEmail, role: "PLATFORM_ADMIN" });
    const s1 = await loginAs(admin.email);
    const s2 = await loginAs(admin.email);

    const disabled = await enrollRoute.POST(jsonReq("/api/platform-admin/mfa/enroll", {}, bearer(s1.token)));
    ok("ENROLL-DISABLED: no bootstrap hash configured → enrollment refused", disabled.status === 403 && (await disabled.json()).code === "ENROLLMENT_DISABLED");
    const CODE = "secb-bootstrap-synthetic-7f3a9c";
    process.env.PLATFORM_ADMIN_ENROLLMENT_CODE_HASH = createHash("sha256").update(CODE).digest("hex");
    const noCode = await enrollRoute.POST(jsonReq("/api/platform-admin/mfa/enroll", {}, bearer(s1.token)));
    ok("ENROLL-CODE: enrollment without the bootstrap code is refused", noCode.status === 403 && (await owner.platformAdminMfa.count({ where: { userId: admin.id } })) === 0);
    const en = await enrollRoute.POST(jsonReq("/api/platform-admin/mfa/enroll", { enrollmentCode: CODE }, bearer(s1.token)));
    const uri = ((await en.json()) as { otpauthUri?: string }).otpauthUri ?? "";
    ok("ENROLL-CODE: the bootstrap code opens enrollment", en.status === 200 && uri.startsWith("otpauth://"));
    const totp = OTPAuth.URI.parse(uri) as InstanceType<typeof OTPAuth.TOTP>;
    const row0 = await owner.platformAdminMfa.findUniqueOrThrow({ where: { userId: admin.id } });
    ok("SEED-V2: a new seed is stored in the owner-bound v2 format", row0.secretEncrypted.startsWith("gcm_v2:"));

    const t0 = Date.now();
    const cf = await confirmRoute.POST(jsonReq("/api/platform-admin/mfa/confirm", { code: totp.generate({ timestamp: t0 }) }, bearer(s1.token)));
    const cb = (await cf.json()) as { elevation?: string; recoveryCodes?: string[] };
    ok("CONFIRM: enrollment confirmed with a real code", cf.status === 200 && typeof cb.elevation === "string" && (cb.recoveryCodes?.length ?? 0) === 10);

    const withElev = (tok: string, elev: string) => new Request("https://lab.invalid/api/platform-admin/overview", { headers: { ...bearer(tok), "x-admin-elevation": elev } });
    let sameOk = false;
    try { await requirePlatformAdmin(withElev(s1.token, cb.elevation ?? "")); sameOk = true; } catch { sameOk = false; }
    ok("ELEVATION: accepted on the session that earned it", sameOk);
    let crossOk = true;
    try { await requirePlatformAdmin(withElev(s2.token, cb.elevation ?? "")); } catch { crossOk = false; }
    ok("ELEVATION-SESSION: refused on another session of the same admin", crossOk === false);
    let unset = true;
    try { await requirePlatformAdmin(new Request("https://x", { headers: bearer(s1.token) })); } catch { unset = false; }
    ok("MFA-FAILCLOSED: flag unset → an un-elevated admin request is refused", unset === false);

    const reEnroll = await enrollRoute.POST(jsonReq("/api/platform-admin/mfa/enroll", { enrollmentCode: CODE }, bearer(s1.token)));
    ok("ENROLL-ONCE: an enrolled authenticator cannot be replaced via enroll", reEnroll.status === 409);

    // TOTP race: the same fresh code, twice, concurrently.
    const later = new Date(t0 + 90_000);
    const code = totp.generate({ timestamp: later.getTime() });
    const [v1, v2] = await Promise.all([verifyAdminMfaCode(admin.id, code, later), verifyAdminMfaCode(admin.id, code, later)]);
    ok("TOTP-RACE: exactly one of two concurrent uses of one code is accepted", [v1.ok, v2.ok].filter(Boolean).length === 1, `${JSON.stringify(v1)} ${JSON.stringify(v2)}`);

    // Recovery race: one code twice; then two different codes concurrently.
    const rc = cb.recoveryCodes ?? [];
    const [r1, r2] = await Promise.all([verifyAdminMfaCode(admin.id, rc[0]), verifyAdminMfaCode(admin.id, rc[0])]);
    ok("RECOVERY-RACE: exactly one of two concurrent uses of one recovery code is accepted", [r1.ok, r2.ok].filter(Boolean).length === 1);
    const [r3, r4] = await Promise.all([verifyAdminMfaCode(admin.id, rc[1]), verifyAdminMfaCode(admin.id, rc[2])]);
    const left = (await owner.platformAdminMfa.findUniqueOrThrow({ where: { userId: admin.id } })).recoveryCodeHashes.length;
    ok("RECOVERY-CONCURRENT: two different codes both spent, neither resurrected", r3.ok && r4.ok && left === 7, `left=${left}`);

    // Legacy v1 seed: still usable, upgraded on use.
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const legacyAdmin = await mkUser({ role: "PLATFORM_ADMIN" });
    const seed = new OTPAuth.Secret({ size: 20 });
    const key = Buffer.from(process.env.ADMIN_MFA_ENCRYPTION_KEY as string, "base64");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([c.update(seed.base32, "utf8"), c.final()]);
    await owner.platformAdminMfa.create({
      data: {
        userId: legacyAdmin.id,
        secretEncrypted: `gcm_v1:${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${ct.toString("base64")}`,
        encryptionKeyId: "gcm_v1",
        enrolledAt: new Date(),
        recoveryCodeHashes: [],
      },
    });
    const lt = new OTPAuth.TOTP({ issuer: "Dubiz", label: "platform-admin", algorithm: "SHA1", digits: 6, period: 30, secret: seed });
    const lv = await verifyAdminMfaCode(legacyAdmin.id, lt.generate());
    const lrow = await owner.platformAdminMfa.findUniqueOrThrow({ where: { userId: legacyAdmin.id } });
    ok("SEED-LEGACY: a v1 seed still verifies (no data loss)", lv.ok);
    ok("SEED-LEGACY: and is re-encrypted as v2 on use", lrow.secretEncrypted.startsWith("gcm_v2:") && lrow.encryptionKeyId === "gcm_v2");
  }

  resetMemoryBackendForTests();
  await owner.$disconnect();
  console.log(`\nsec-B identity DB battery: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("BATTERY SETUP/RUNTIME CRASH:", error);
    process.exit(3);
  }
);
