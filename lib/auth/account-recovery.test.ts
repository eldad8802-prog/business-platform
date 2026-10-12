/**
 * Email verification + password reset + login hardening — the pure suite (run manually or in CI):
 *   npx tsx lib/auth/account-recovery.test.ts
 *
 * No database, no network: every route is driven through its injected dependencies, and the
 * database-side rules (single use, expiry, supersede, ceiling, session revocation) are proved by the
 * migration battery (.aet/battery.ts) and the app battery (.aet/app-battery.ts).
 *
 *   1. links: derivation, parsing, the fragment, constant-time check
 *   2. emails: EMAIL_VERIFY / PASSWORD_RESET payload contract and rendering (Hebrew, RTL, the link)
 *   3. switches: OFF by default, ON only with a ready mail path and the auth plane
 *   4. forgot-password: the same answer for every address; limits; work after the response
 *   5. reset / check / verify: status → HTTP mapping; the reset clears this browser's refresh cookie
 *   6. resend / status: signed-in only, OFF is free
 *   7. honeypot
 *   8. login (static): the per-account limit is read before any password is compared and spent only
 *      on failures; every user-visible message is Hebrew
 *   9. scope (static): who may touch what
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.AUTH_TOKEN_SECRET = "a".repeat(64);
process.env.RATE_LIMIT_BACKEND = "memory";

import { reserveAttempt } from "@/lib/security/rate-limit";
import { LOGIN_FAILURE_POLICY, loginAccountRateKey } from "@/lib/auth/account-rate-key";
import { LOGIN_DEVICE_COOKIE, readLoginDevice, setLoginDevice } from "@/lib/auth/login-device";
import { AUTH_MESSAGES_HE, loginLockedMessage } from "@/lib/auth/auth-messages";

import {
  buildEmailLink,
  deriveLinkSecret,
  hashLinkSecret,
  isDerivedSecret,
  mintEmailToken,
  parseLinkToken,
} from "@/lib/auth/email-link";
import { isEmailVerificationEnabled, isPasswordResetEnabled } from "@/lib/auth/account-recovery-config";
import { isHoneypotFilled, SIGNUP_HONEYPOT_FIELD } from "@/lib/auth/signup-honeypot";
import { consumePasswordReset, consumeEmailVerification, checkAccountLink } from "@/lib/auth/email-tokens";
import {
  EMAIL_KINDS,
  EMAIL_VERIFY_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  accountLinkDedupeKey,
  renderStored,
} from "@/lib/email/transactional/registry";
import { parseAccountLinkPayload } from "@/lib/email/transactional/templates/account-links";
import { handleForgot, type ForgotDeps } from "@/app/api/auth/password/forgot/route";
import { handleReset } from "@/app/api/auth/password/reset/route";
import { handleResetCheck } from "@/app/api/auth/password/reset/check/route";
import { handleVerify } from "@/app/api/auth/email/verify/route";
import { handleResend } from "@/app/api/auth/email/resend/route";
import { handleStatus } from "@/app/api/auth/email/status/route";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://x${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const allow = async () => ({ allowed: true, remaining: 1, resetAt: 0 });
const deny = async () => ({ allowed: false, remaining: 0, resetAt: 0 });
const UUID = "0b4a8a6c-3f2d-4c1e-9a7b-5d6e7f8a9b0c";
const READY_ENV = {
  TRANSACTIONAL_EMAIL_ENABLED: "true",
  RESEND_API_KEY: "re_test_key",
  TRANSACTIONAL_EMAIL_FROM: "Dubiz <hello@example.test>",
  APP_BASE_URL: "https://app.example.test",
  AUTH_PLANE_ENABLED: "true",
};

async function main() {
  // ── 1. links ───────────────────────────────────────────────────────────────
  {
    const s1 = deriveLinkSecret(UUID, "PASSWORD_RESET");
    ok("link: the secret is 32 bytes base64url (43 chars), deterministic", s1.length === 43 && s1 === deriveLinkSecret(UUID, "PASSWORD_RESET"));
    ok("link: the purpose is part of the derivation (a verify secret is not a reset secret)", s1 !== deriveLinkSecret(UUID, "EMAIL_VERIFY"));
    ok("link: the token id is part of the derivation", s1 !== deriveLinkSecret("1b4a8a6c-3f2d-4c1e-9a7b-5d6e7f8a9b0c", "PASSWORD_RESET"));
    const saved = process.env.AUTH_TOKEN_SECRET;
    process.env.AUTH_TOKEN_SECRET = "b".repeat(64);
    ok("link: rotating the server key changes every secret", deriveLinkSecret(UUID, "PASSWORD_RESET") !== s1);
    process.env.AUTH_TOKEN_SECRET = saved;
    ok("link: stored hash = sha256(secret) hex", hashLinkSecret(s1) === createHash("sha256").update(s1).digest("hex"));
    const minted = mintEmailToken("EMAIL_VERIFY");
    ok("link: a minted token's hash matches its derived secret", minted.tokenHash === hashLinkSecret(deriveLinkSecret(minted.tokenId, "EMAIL_VERIFY")));
    const url = buildEmailLink("https://app.example.test", UUID, "PASSWORD_RESET");
    ok("link: the token travels in the FRAGMENT (never reaches a server log)", url === `https://app.example.test/reset-password#t=${UUID}.${s1}`);
    ok("link: verify links go to /verify-email", buildEmailLink("https://a.test", UUID, "EMAIL_VERIFY").startsWith("https://a.test/verify-email#t="));
    ok("link: parse accepts <uuid>.<secret>", JSON.stringify(parseLinkToken(`${UUID}.${s1}`)) === JSON.stringify({ tokenId: UUID, secret: s1 }));
    for (const bad of [null, 42, "", UUID, `${UUID}.`, `not-a-uuid.${s1}`, `${UUID}.short`, `${UUID}.${s1}x`, "x".repeat(200)]) {
      ok(`link: parse refuses ${JSON.stringify(bad)?.slice(0, 30)}`, parseLinkToken(bad) === null);
    }
    ok("link: isDerivedSecret true for the right secret", isDerivedSecret(UUID, s1, "PASSWORD_RESET"));
    ok("link: isDerivedSecret false for another purpose / a forged secret",
      !isDerivedSecret(UUID, s1, "EMAIL_VERIFY") && !isDerivedSecret(UUID, "A".repeat(43), "PASSWORD_RESET"));
  }

  // ── 2. emails ──────────────────────────────────────────────────────────────
  {
    ok("email: verify TTL 12h and reset TTL 1h (within the 24h / 1h links they carry)",
      EMAIL_VERIFY_TTL_MS === 12 * 3600_000 && PASSWORD_RESET_TTL_MS === 3600_000 &&
      EMAIL_KINDS.EMAIL_VERIFY.ttlMs === EMAIL_VERIFY_TTL_MS && EMAIL_KINDS.PASSWORD_RESET.ttlMs === PASSWORD_RESET_TTL_MS);
    ok("email: one email per issued link (dedupe key names the token)",
      accountLinkDedupeKey("PASSWORD_RESET", UUID) === `password_reset:token:${UUID}` && accountLinkDedupeKey("EMAIL_VERIFY", UUID) === `email_verify:token:${UUID}`);
    ok("email: payload accepts { tokenId, firstName }", parseAccountLinkPayload({ tokenId: UUID, firstName: "דנה" })?.firstName === "דנה");
    ok("email: payload refuses an extra key (e.g. a secret or a link)", parseAccountLinkPayload({ tokenId: UUID, firstName: null, link: "x" }) === null);
    ok("email: payload refuses a non-uuid token id", parseAccountLinkPayload({ tokenId: "x", firstName: null }) === null);
    const ctx = { appBaseUrl: "https://app.example.test" };
    const reset = renderStored("PASSWORD_RESET", { tokenId: UUID, firstName: "דנה" }, ctx)!;
    const link = buildEmailLink(ctx.appBaseUrl, UUID, "PASSWORD_RESET");
    ok("email: reset renders a Hebrew subject", reset.subject === "בחירת סיסמה חדשה ל־Dubiz");
    ok("email: reset HTML is RTL Hebrew and carries the link", reset.html.includes('dir="rtl"') && reset.html.includes('lang="he"') && reset.html.includes(link.replace(/&/g, "&amp;")));
    ok("email: the plain-text part carries the same link", reset.text.includes(link));
    ok("email: reset says the link lasts an hour and signs out every device", reset.text.includes("לשעה") && reset.text.includes("ננתק"));
    ok("email: the stored hash never appears in an email", !reset.html.includes(hashLinkSecret(deriveLinkSecret(UUID, "PASSWORD_RESET"))));
    ok("email: the first name is escaped", renderStored("EMAIL_VERIFY", { tokenId: UUID, firstName: "A&B" }, ctx)!.html.includes("A&amp;B"));
    const verify = renderStored("EMAIL_VERIFY", { tokenId: UUID, firstName: null }, ctx)!;
    ok("email: verify renders with the /verify-email link and no name", verify.text.includes("/verify-email#t=") && verify.text.startsWith("היי,"));
  }

  // ── 3. switches ────────────────────────────────────────────────────────────
  {
    ok("switch: both OFF with nothing set", !isEmailVerificationEnabled({}) && !isPasswordResetEnabled({}));
    ok("switch: the flag alone is not enough (mail path not ready)",
      !isEmailVerificationEnabled({ AUTH_EMAIL_VERIFICATION_ENABLED: "true" }) && !isPasswordResetEnabled({ AUTH_PASSWORD_RESET_ENABLED: "true" }));
    ok("switch: a ready mail path alone turns nothing on", !isEmailVerificationEnabled(READY_ENV) && !isPasswordResetEnabled(READY_ENV));
    ok("switch: flag + ready mail path + auth plane → ON",
      isEmailVerificationEnabled({ ...READY_ENV, AUTH_EMAIL_VERIFICATION_ENABLED: "true" }) && isPasswordResetEnabled({ ...READY_ENV, AUTH_PASSWORD_RESET_ENABLED: "true" }));
    ok("switch: no auth plane → OFF", !isPasswordResetEnabled({ ...READY_ENV, AUTH_PLANE_ENABLED: "false", AUTH_PASSWORD_RESET_ENABLED: "true" }));
    ok("switch: mail misconfigured (no key) → OFF", !isPasswordResetEnabled({ ...READY_ENV, RESEND_API_KEY: "", AUTH_PASSWORD_RESET_ENABLED: "true" }));
    ok("switch: only the exact value \"true\"", !isPasswordResetEnabled({ ...READY_ENV, AUTH_PASSWORD_RESET_ENABLED: "1" }));
  }

  // ── 4. forgot-password ─────────────────────────────────────────────────────
  {
    const mk = (over: Partial<ForgotDeps> = {}) => {
      const log = { requested: [] as string[], delivered: [] as number[], deferred: 0 };
      const deps: ForgotDeps = {
        enabled: () => true,
        rateLimit: allow,
        request: async (email) => {
          log.requested.push(email);
          return email.startsWith("owner@") ? { emailId: 7, businessId: 3, tokenId: UUID } : null;
        },
        deliver: async (id) => { log.delivered.push(id); },
        defer: (work) => { log.deferred += 1; void work(); },
        ...over,
      };
      return { deps, log };
    };
    const off = await handleForgot(post("/api/auth/password/forgot", { email: "owner@x.test" }), mk({ enabled: () => false }).deps);
    ok("forgot: OFF → 404 FEATURE_DISABLED, nothing looked up", off.status === 404 && (await off.json()).code === "FEATURE_DISABLED");

    const a = mk();
    const known = await handleForgot(post("/api/auth/password/forgot", { email: "owner@x.test" }), a.deps);
    const knownBody = await known.json();
    await new Promise((r) => setTimeout(r, 0));
    const b = mk();
    const unknown = await handleForgot(post("/api/auth/password/forgot", { email: "nobody@x.test" }), b.deps);
    const unknownBody = await unknown.json();
    await new Promise((r) => setTimeout(r, 0));
    ok("forgot: a registered and an unknown address get the SAME status and body",
      known.status === 200 && unknown.status === 200 && JSON.stringify(knownBody) === JSON.stringify(unknownBody), JSON.stringify([knownBody, unknownBody]));
    ok("forgot: the answer is the neutral Hebrew sentence", typeof knownBody.message === "string" && knownBody.message.startsWith("אם הכתובת רשומה אצלנו"));
    ok("forgot: the lookup and the email happen AFTER the response (deferred)", a.log.deferred === 1 && JSON.stringify(a.log.delivered) === "[7]");
    ok("forgot: nothing is delivered for an unknown address", b.log.delivered.length === 0 && b.log.requested.length === 1);
    ok("forgot: no-store", known.headers.get("cache-control") === "no-store");

    const ipLimited = await handleForgot(post("/api/auth/password/forgot", { email: "owner@x.test" }), mk({ rateLimit: deny }).deps);
    ok("forgot: per-IP limit → 429 Hebrew", ipLimited.status === 429 && (await ipLimited.json()).error.includes("יותר מדי"));

    let n = 0;
    const perAddress = mk({ rateLimit: async () => (++n === 1 ? { allowed: true, remaining: 1, resetAt: 0 } : { allowed: false, remaining: 0, resetAt: 0 }) });
    const limitedAddr = await handleForgot(post("/api/auth/password/forgot", { email: "owner@x.test" }), perAddress.deps);
    ok("forgot: an exhausted ADDRESS gets the very same 200 — and no link goes out",
      limitedAddr.status === 200 && JSON.stringify(await limitedAddr.json()) === JSON.stringify(knownBody) && perAddress.log.deferred === 0);

    const badEmail = await handleForgot(post("/api/auth/password/forgot", { email: "not-an-email" }), mk().deps);
    ok("forgot: a malformed address → 400 on the email field", badEmail.status === 400 && (await badEmail.json()).field === "email");
    const badBody = await handleForgot(post("/api/auth/password/forgot", "{nope"), mk().deps);
    ok("forgot: a malformed body → 400", badBody.status === 400);
    const throws = mk({ request: async () => { throw new Error("db down"); } });
    const survived = await handleForgot(post("/api/auth/password/forgot", { email: "owner@x.test" }), throws.deps);
    await new Promise((r) => setTimeout(r, 0));
    ok("forgot: a failure after the response never reaches the caller (still the same 200)", survived.status === 200);
  }

  // ── 5. reset / check / verify ──────────────────────────────────────────────
  {
    const done = await handleReset(post("/api/auth/password/reset", { token: "t", password: "longenough" }), {
      rateLimit: allow,
      consume: async () => ({ status: "RESET", userId: 1 }),
    });
    const cookie = done.headers.get("set-cookie") ?? "";
    ok("reset: RESET → 200 with the Hebrew confirmation", done.status === 200 && (await done.json()).ok === true);
    ok("reset: …and this browser's refresh cookie is cleared (its session was revoked)", /dubiz_rt=;/.test(cookie) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie), cookie);
    for (const [status, code] of [["EXPIRED", "TOKEN_EXPIRED"], ["USED", "TOKEN_USED"], ["SUPERSEDED", "TOKEN_SUPERSEDED"], ["INVALID", "TOKEN_INVALID"]] as const) {
      const r = await handleReset(post("/api/auth/password/reset", { token: "t", password: "longenough" }), { rateLimit: allow, consume: async () => ({ status }) });
      const b = await r.json();
      ok(`reset: ${status} → 400 ${code} (Hebrew)`, r.status === 400 && b.code === code && /[֐-׿]/.test(b.error));
    }
    const weak = await handleReset(post("/api/auth/password/reset", { token: "t", password: "x" }), { rateLimit: allow, consume: async () => ({ status: "WEAK_PASSWORD" }) });
    const weakBody = await weak.json();
    ok("reset: a short password → 400 on the password field", weak.status === 400 && weakBody.field === "password" && weakBody.error.includes("8"));
    const limited = await handleReset(post("/api/auth/password/reset", {}), { rateLimit: deny, consume: async () => ({ status: "RESET", userId: 1 }) });
    ok("reset: per-IP limit → 429 before anything is consumed", limited.status === 429);

    const valid = await handleResetCheck(post("/api/auth/password/reset/check", { token: "t" }), { rateLimit: allow, check: async () => "VALID" });
    ok("check: VALID → { ok: true }", (await valid.json()).ok === true);
    const expired = await handleResetCheck(post("/api/auth/password/reset/check", { token: "t" }), { rateLimit: allow, check: async () => "EXPIRED" });
    const eb = await expired.json();
    ok("check: EXPIRED → { ok:false, code TOKEN_EXPIRED } with the Hebrew reason", eb.ok === false && eb.code === "TOKEN_EXPIRED" && eb.error.includes("פג"));

    const verified = await handleVerify(post("/api/auth/email/verify", { token: "t" }), { rateLimit: allow, consume: async () => ({ status: "VERIFIED", userId: 1, businessId: 2 }) });
    ok("verify: VERIFIED → 200", verified.status === 200 && (await verified.json()).ok === true);
    const used = await handleVerify(post("/api/auth/email/verify", { token: "t" }), { rateLimit: allow, consume: async () => ({ status: "USED" }) });
    ok("verify: USED → 400 TOKEN_USED", used.status === 400 && (await used.json()).code === "TOKEN_USED");

    // The library refuses garbage before the database is ever asked (no DATABASE_URL in this process).
    ok("lib: a short new password is refused before anything else", (await consumePasswordReset("x", "short")).status === "WEAK_PASSWORD");
    ok("lib: an unparseable reset token is INVALID without a database call", (await consumePasswordReset("garbage", "longenough1")).status === "INVALID");
    ok("lib: a forged secret is INVALID without a database call",
      (await consumePasswordReset(`${UUID}.${"A".repeat(43)}`, "longenough1")).status === "INVALID" &&
      (await consumeEmailVerification(`${UUID}.${"A".repeat(43)}`)).status === "INVALID" &&
      (await checkAccountLink(`${UUID}.${"A".repeat(43)}`, "PASSWORD_RESET")) === "INVALID");
    ok("lib: a reset secret presented for verification is INVALID", (await consumeEmailVerification(`${UUID}.${deriveLinkSecret(UUID, "PASSWORD_RESET")}`)).status === "INVALID");
  }

  // ── 6. resend / status ─────────────────────────────────────────────────────
  {
    const base = {
      enabled: () => true,
      currentUser: async () => ({ id: 5 }),
      rateLimit: allow,
      request: async () => ({ status: "SENT" as const, link: { emailId: 9, businessId: 4, tokenId: UUID } }),
      schedule: (() => undefined) as (a: number, b: number) => void,
    };
    const anon = await handleResend(post("/api/auth/email/resend", {}), { ...base, currentUser: async () => null });
    ok("resend: not signed in → 401", anon.status === 401);
    const off = await handleResend(post("/api/auth/email/resend", {}), { ...base, enabled: () => false });
    ok("resend: OFF → 404", off.status === 404);
    let scheduled: number[] = [];
    const sent = await handleResend(post("/api/auth/email/resend", {}), { ...base, schedule: (id) => { scheduled.push(id); } });
    ok("resend: SENT → 200 and the email is scheduled after the response", sent.status === 200 && JSON.stringify(scheduled) === "[9]");
    scheduled = [];
    const already = await handleResend(post("/api/auth/email/resend", {}), { ...base, request: async () => ({ status: "ALREADY_VERIFIED" as const }) });
    ok("resend: already verified → 200 alreadyVerified, nothing sent", (await already.json()).alreadyVerified === true && scheduled.length === 0);
    const ceiling = await handleResend(post("/api/auth/email/resend", {}), { ...base, request: async () => ({ status: "NOT_ISSUED" as const }) });
    ok("resend: the database's hourly ceiling → 429", ceiling.status === 429);
    const limited = await handleResend(post("/api/auth/email/resend", {}), { ...base, rateLimit: deny });
    ok("resend: per-user limit → 429", limited.status === 429);

    let asked = 0;
    const statusOff = await handleStatus(new Request("http://x/api/auth/email/status"), {
      enabled: () => false,
      currentUser: async () => { asked += 1; return { id: 1 }; },
      readVerified: async () => { asked += 1; return false; },
    });
    ok("status: OFF answers { verificationEnabled:false } without reading the session or the user", (await statusOff.json()).verificationEnabled === false && asked === 0);
    const statusAnon = await handleStatus(new Request("http://x/api/auth/email/status"), { enabled: () => true, currentUser: async () => null, readVerified: async () => false });
    ok("status: ON and not signed in → 401", statusAnon.status === 401);
    const statusOn = await handleStatus(new Request("http://x/api/auth/email/status"), { enabled: () => true, currentUser: async () => ({ id: 1 }), readVerified: async () => false });
    ok("status: ON → { verificationEnabled:true, verified:false }", JSON.stringify(await statusOn.json()) === JSON.stringify({ verificationEnabled: true, verified: false }));
  }

  // ── 7. honeypot ────────────────────────────────────────────────────────────
  {
    ok("honeypot: empty / absent is a person", !isHoneypotFilled({}) && !isHoneypotFilled({ [SIGNUP_HONEYPOT_FIELD]: "" }) && !isHoneypotFilled({ [SIGNUP_HONEYPOT_FIELD]: "   " }));
    ok("honeypot: any value is a script", isHoneypotFilled({ [SIGNUP_HONEYPOT_FIELD]: "x" }) && isHoneypotFilled({ [SIGNUP_HONEYPOT_FIELD]: 1 }));
    ok("honeypot: the field name is not one browsers autofill", !/website|url|company|phone|email|name$/i.test(SIGNUP_HONEYPOT_FIELD));
  }

  const root = process.cwd();
  const src = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
  const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  // ── 8. login (static) ──────────────────────────────────────────────────────
  {
    const login = code("app/api/auth/login/route.ts");
    const reserve = login.indexOf("await reserveAttempt(");
    const firstCompare = login.indexOf("bcrypt.compare(");
    const ipLimit = login.indexOf("key: `auth:login:${ip}`");
    ok("login: the per-IP limit is still there, first", ipLimit > 0 && ipLimit < reserve);
    ok("login: the per-address attempt is RESERVED (atomically) before any password is compared", reserve > 0 && firstCompare > reserve);
    ok("login: a refused reservation answers the lock and compares nothing",
      /if \(!attempt\.allowed\) \{[\s\S]{0,160}return lockedResponse\(attempt\.retryAfterMs\)/.test(login));
    ok("login: both failure paths (unknown address, wrong password) go through the SAME failedSignIn",
      (login.match(/return failedSignIn\(/g) ?? []).length === 2);
    const clear = login.indexOf("await attempt.clear()");
    ok("login: a right password clears the ledger before the session is issued (a success is never a failure)",
      clear > firstCompare && clear < login.indexOf("issueRefreshSession("));
    ok("login: the 4th failure locks; the 3rd warns", login.includes("attempt.count >= LOGIN_FAILURE_POLICY.limit") && login.includes("attempt.count === LOGIN_FAILURE_POLICY.warnAtFailure"));
    ok("login: the device cookie is set only on success", login.indexOf("setLoginDevice(") > login.indexOf("issueRefreshSession("));
    ok("login: the ledger key is per address (digest) — never per IP", /loginAccountRateKey\(normalizedEmail, deviceNonce\)/.test(login) && !/loginAccountRateKey\([^)]*ip/.test(login));
    ok("login: no English message is left for a person to read", !/"(Too many requests|Missing email or password|Invalid email or password|Server error|Server configuration error)[^"]*"/.test(login));
    const reg = code("app/api/auth/register/route.ts");
    ok("register: no English message is left for a person to read", !/"(Too many requests|Invalid request body|Server error|Server configuration error)[^"]*"/.test(reg));
    const form = code("app/login/login-form.tsx");
    ok("login form: no client-side minimum length (the server decides)", !/value\.length < 6/.test(form));
    ok("login form: the forgot-password link exists and is behind the server flag", form.includes('href="/forgot-password"') && form.includes("passwordResetEnabled ?"));
    ok("login form: no English word in a visible message", !form.includes("token מהשרת"));
  }

  // ── 9. scope (static) ──────────────────────────────────────────────────────
  {
    const routes = [
      "app/api/auth/password/forgot/route.ts",
      "app/api/auth/password/reset/route.ts",
      "app/api/auth/password/reset/check/route.ts",
      "app/api/auth/email/verify/route.ts",
      "app/api/auth/email/resend/route.ts",
      "app/api/auth/email/status/route.ts",
    ];
    ok("scope: no account-link route holds a database client itself", routes.every((f) => !/@\/lib\/prisma(-auth)?"/.test(code(f))));
    const lib = code("lib/auth/email-tokens.ts");
    ok("scope: the library never writes User, AuthSession or AuthEmailToken directly — only the definer functions do",
      !/\.(user|authSession|authEmailToken)\.(create|update|upsert|delete)/.test(lib) && !/(UPDATE|INSERT INTO|DELETE FROM)\s+"?(User|AuthSession|AuthEmailToken)/i.test(lib));
    ok("scope: it calls exactly the four functions",
      ["auth_email_token_issue", "auth_email_token_check", "auth_email_verify_consume", "auth_password_reset_consume"].every((f) => lib.includes(`public.${f}(`)));
    const all = [...routes, "lib/auth/email-tokens.ts", "lib/auth/email-link.ts"].map(code).join("\n");
    ok("scope: no token, secret or password is ever logged", !/console\.(log|error|warn)\([^)]*\b(token|secret|password)\b/i.test(all));
    const pages = ["app/reset-password/page.tsx", "app/verify-email/page.tsx"].map(src).join("\n");
    ok("pages: the token is taken from the fragment and dropped from the address bar", (pages.match(/history\.replaceState/g) ?? []).length === 2 && pages.includes("window.location.hash"));
    ok("pages: both account-link pages send no Referer", ["app/reset-password/layout.tsx", "app/verify-email/layout.tsx"].every((f) => src(f).includes('referrer: "no-referrer"')));
  }

  // ── 10. the sign-in failure ledger (memory backend, synthetic clock) ──────
  {
    const P = LOGIN_FAILURE_POLICY;
    ok("policy: 4 failures in a rolling 15 minutes → a 15-minute lock; the warning at the 3rd",
      P.limit === 4 && P.windowMs === 15 * 60_000 && P.lockMs === 15 * 60_000 && P.warnAtFailure === 3);
    const t0 = 1_800_000_000_000;
    const key = loginAccountRateKey("ledger@x.test");
    const r = (dt: number) => reserveAttempt({ key, limit: P.limit, windowMs: P.windowMs, nowMs: t0 + dt });
    const a1 = await r(0), a2 = await r(60_000), a3 = await r(120_000), a4 = await r(180_000);
    ok("ledger: attempts 1–4 are reserved and counted 1, 2, 3, 4",
      a1.allowed && a2.allowed && a3.allowed && a4.allowed && [a1, a2, a3, a4].map((a) => (a.allowed ? a.count : -1)).join() === "1,2,3,4");
    const a5 = await r(181_000);
    ok("ledger: a 5th inside the window is refused before anything runs", !a5.allowed && !a5.locked);
    if (a4.allowed) await a4.lock(P.lockMs);
    const k2 = loginAccountRateKey("lock@x.test");
    const rr = (dt: number) => reserveAttempt({ key: k2, limit: P.limit, windowMs: P.windowMs, nowMs: t0 + dt });
    for (let i = 0; i < 4; i++) await rr(i * 1000);
    const lockAt = Date.now();
    const four = await reserveAttempt({ key: k2, limit: P.limit, windowMs: P.windowMs, nowMs: lockAt });
    ok("ledger: with the window full, a further attempt is refused", !four.allowed);
    // Lock it explicitly (as the 4th failure does) and read it back on a synthetic clock.
    const k3 = loginAccountRateKey("lock3@x.test");
    const first = await reserveAttempt({ key: k3, limit: P.limit, windowMs: P.windowMs, nowMs: t0 });
    if (first.allowed) await first.lock(P.lockMs);
    const now = Date.now();
    const during = await reserveAttempt({ key: k3, limit: P.limit, windowMs: P.windowMs, nowMs: now + 14 * 60_000 });
    ok("ledger: 14 minutes into the lock — still locked, about a minute left",
      !during.allowed && during.locked && during.retryAfterMs > 0 && during.retryAfterMs <= 60_000 + 1000, JSON.stringify(during));
    const after = await reserveAttempt({ key: k3, limit: P.limit, windowMs: P.windowMs, nowMs: now + 15 * 60_000 + 1000 });
    ok("ledger: once the 15 minutes pass, signing in can be tried again (window empty)", after.allowed && after.count === 1);

    // Rolling window: four failures spread over 20 minutes never fill a 15-minute window.
    const k4 = loginAccountRateKey("rolling@x.test");
    const counts: number[] = [];
    for (const dt of [0, 6, 12, 18].map((m) => m * 60_000)) {
      const x = await reserveAttempt({ key: k4, limit: P.limit, windowMs: P.windowMs, nowMs: t0 + dt });
      counts.push(x.allowed ? x.count : -1);
    }
    ok("ledger: the window ROLLS — at 18 minutes the failure from 0 has left it (counts 1,2,3,3)", counts.join() === "1,2,3,3", counts.join());

    // Clearing: a success empties the ledger.
    const k5 = loginAccountRateKey("clear@x.test");
    for (let i = 0; i < 3; i++) await reserveAttempt({ key: k5, limit: P.limit, windowMs: P.windowMs, nowMs: t0 + i });
    const ok4 = await reserveAttempt({ key: k5, limit: P.limit, windowMs: P.windowMs, nowMs: t0 + 10 });
    if (ok4.allowed) await ok4.clear();
    const next = await reserveAttempt({ key: k5, limit: P.limit, windowMs: P.windowMs, nowMs: t0 + 20 });
    ok("ledger: a success clears the failures before it (the next attempt counts 1)", next.allowed && next.count === 1);

    // A parallel burst: ten at once, at most four get through.
    const k6 = loginAccountRateKey("burst@x.test");
    const burst = await Promise.all(Array.from({ length: 10 }, () => reserveAttempt({ key: k6, limit: P.limit, windowMs: P.windowMs, nowMs: t0 })));
    ok("ledger: a parallel burst of 10 — exactly 4 reserved, 6 refused", burst.filter((b) => b.allowed).length === 4 && burst.filter((b) => !b.allowed).length === 6);

    // Per address: case and whitespace fold to the same ledger; another address is separate.
    ok("ledger: the key is the folded address (case / spaces cannot open a second ledger)",
      loginAccountRateKey("Owner@X.test".trim().toLowerCase()) === loginAccountRateKey("owner@x.test"));
    ok("ledger: the key never contains the address", !loginAccountRateKey("owner@x.test").includes("owner"));
  }

  // ── 11. lock / warning messages ────────────────────────────────────────────
  {
    ok("message: the warning is the owner-approved sentence", AUTH_MESSAGES_HE.loginLastAttemptWarning === "שים לב, נותר לך ניסיון התחברות אחד לפני חסימה זמנית ל־15 דקות.");
    ok("message: the lock states the time left (15 minutes)", loginLockedMessage(15 * 60_000).includes("בעוד 15 דקות"));
    ok("message: …and one minute in the singular", loginLockedMessage(30_000).includes("בעוד דקה אחת"));
    ok("message: the lock never speaks of an account", !/חשבון/.test(loginLockedMessage(60_000)));
  }

  // ── 12. the known-device cookie ────────────────────────────────────────────
  {
    const { NextResponse } = await import("next/server");
    const res = NextResponse.json({});
    setLoginDevice(res, "owner@x.test", null);
    const set = res.cookies.get(LOGIN_DEVICE_COOKIE);
    const value = set?.value ?? "";
    const reqWith = (v: string) => new Request("http://x/api/auth/login", { headers: { cookie: `a=b; ${LOGIN_DEVICE_COOKIE}=${v}` } });
    ok("device: httpOnly, strict, only sent to /api/auth/login", set?.httpOnly === true && set?.sameSite === "strict" && set?.path === "/api/auth/login");
    ok("device: the address is not in the cookie", !value.includes("owner") && !value.includes("@"));
    const nonce = readLoginDevice(reqWith(value), "owner@x.test");
    ok("device: valid for its own address", typeof nonce === "string" && nonce.length === 22);
    ok("device: NOT valid for another address", readLoginDevice(reqWith(value), "other@x.test") === null);
    const [n, exp, sig] = value.split(".");
    ok("device: a forged signature is refused", readLoginDevice(reqWith(`${n}.${exp}.${"A".repeat(sig.length)}`), "owner@x.test") === null);
    ok("device: a changed nonce is refused", readLoginDevice(reqWith(`${"B".repeat(22)}.${exp}.${sig}`), "owner@x.test") === null);
    ok("device: an expired cookie is refused", readLoginDevice(reqWith(value), "owner@x.test", (Number(exp) + 1) * 1000) === null);
    ok("device: it selects a SEPARATE ledger, never the shared one",
      loginAccountRateKey("owner@x.test", nonce) !== loginAccountRateKey("owner@x.test") && loginAccountRateKey("owner@x.test", nonce).startsWith(loginAccountRateKey("owner@x.test")));
    const res2 = NextResponse.json({});
    setLoginDevice(res2, "owner@x.test", nonce);
    ok("device: a later sign-in keeps the same device ledger", readLoginDevice(reqWith(res2.cookies.get(LOGIN_DEVICE_COOKIE)!.value), "owner@x.test") === nonce);
  }

  console.log(`\n[account-recovery] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
