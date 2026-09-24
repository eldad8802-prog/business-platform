/**
 * sec-B — identity/session/admin authority: offline behavioural matrix.
 *
 *   npx tsx .secb/identity-unit.test.ts
 *
 * No database. The "failing Redis" is a real Upstash client pointed at
 * 127.0.0.1:9 (connection refused), so fail-closed is proven against a backend
 * that actually fails, not a stub that says it did. Every assertion has a
 * stable LABEL that the negative proofs in .secb/mutate.mjs target.
 */
import { readFileSync } from "node:fs";

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

function failingRedis(on: boolean) {
  if (on) {
    process.env.RATE_LIMIT_BACKEND = "redis";
    process.env.UPSTASH_REDIS_REST_URL = "http://127.0.0.1:9";
    process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic";
  } else {
    process.env.RATE_LIMIT_BACKEND = "memory";
  }
}

async function main() {
  process.env.AUTH_TOKEN_SECRET = "secb-unit-synthetic-secret";
  process.env.RATE_LIMIT_REDIS_TIMEOUT_MS = "300";
  failingRedis(false);

  // ── password policy (owner-tunable numbers; the invariants are asserted) ──
  const { checkNewPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES } = await import("@/lib/auth/password-policy");
  ok("POLICY: minimum is at least 8 (NIST 800-63B floor)", MIN_PASSWORD_LENGTH >= 8);
  ok("POLICY: max is exactly the bcrypt 72-byte limit", MAX_PASSWORD_BYTES === 72);
  ok("POLICY: below minimum refused", checkNewPassword("a".repeat(MIN_PASSWORD_LENGTH - 1)).ok === false);
  ok("POLICY: 72 ASCII bytes accepted", checkNewPassword("Zq".repeat(36)).ok === true);
  ok("POLICY: 73 bytes refused (bcrypt would silently truncate)", checkNewPassword("Zq".repeat(36) + "x").ok === false);
  ok("POLICY: multi-byte text counted in BYTES (25 Hebrew letters = 50 bytes ok; 37 = 74 refused)", checkNewPassword("ש".repeat(25)).ok === true && checkNewPassword("ש".repeat(37)).ok === false);
  ok("POLICY: common password refused", checkNewPassword("password123").ok === false && checkNewPassword("QWERTYUIOP").ok === false);
  ok("POLICY: password equal to the email refused", checkNewPassword("owner@biz.test", { email: "Owner@Biz.test" }).ok === false);
  ok("POLICY: no composition rules — a long lowercase passphrase is accepted", checkNewPassword("correct horse battery").ok === true);

  // ── limiter: strict auth buckets ──
  const { checkRateLimit, consumeRawLimit, consumeOnce } = await import("@/lib/security/rate-limiter");
  const miss = await checkRateLimit({ bucket: "AUTH_LOGIN_ACCOUNT", ip: "1.2.3.4" });
  ok("LIMITER-STRICT: an auth bucket with a missing identifier DENIES (misconfigured)", !miss.allowed && miss.outcome === "misconfigured");
  failingRedis(true);
  const down = await checkRateLimit({ bucket: "AUTH_LOGIN_IP", ip: "1.2.3.4" });
  const rawClosed = await consumeRawLimit({ key: "k", limit: 5, windowSeconds: 60, failMode: "closed" });
  const rawOpen = await consumeRawLimit({ key: "k", limit: 5, windowSeconds: 60 });
  const onceDown = await consumeOnce("t", "n", 60);
  failingRedis(false);
  ok("LIMITER-FAILCLOSED: auth bucket with the backend down denies (backend_unavailable)", !down.allowed && down.outcome === "backend_unavailable");
  ok("LIMITER-FAILCLOSED: legacy raw limiter with failMode=closed denies when the backend is down", rawClosed.allowed === false && rawClosed.backendUnavailable === true);
  ok("LIMITER-LEGACY: default legacy callers keep their documented fail-open", rawOpen.allowed === true);
  ok("LIMITER-ONCE: single-use marker is unavailable (deny) when the backend is down", onceDown === "unavailable");
  ok("LIMITER-ONCE: first then reused", (await consumeOnce("t2", "n", 60)) === "first" && (await consumeOnce("t2", "n", 60)) === "reused");
  const { BUCKETS } = await import("@/lib/security/rate-limiter/buckets");
  const authBuckets = Object.entries(BUCKETS).filter(([k]) => k.startsWith("AUTH_") || k === "ADMIN_MFA_ENROLL");
  ok("LIMITER-CONFIG: every auth bucket is fail-closed and strict", authBuckets.length === 7 && authBuckets.every(([, c]) => c.failMode === "closed" && c.requireAllIdentifiers === true));

  // ── credential check: one compare, whatever happens ──
  const { verifyPassword, DUMMY_BCRYPT_HASH } = await import("@/lib/auth/credential-check");
  const seen: string[] = [];
  const cmp = async (_p: string, h: string) => { seen.push(h); return false; };
  await verifyPassword("x", null, cmp);
  await verifyPassword("x".repeat(5000), "$2b$10$real", cmp);
  ok("LOGIN-TIMING: missing account and oversized input both compare against the dummy hash once", seen.length === 2 && seen.every((h) => h === DUMMY_BCRYPT_HASH));
  ok("LOGIN-TIMING: dummy hash has the production cost factor", DUMMY_BCRYPT_HASH.startsWith("$2b$10$"));

  // ── step-up envelope ──
  const { issueStepUpToken, verifyAndConsumeStepUp } = await import("@/lib/auth/step-up");
  const bind = { userId: 5, sessionId: "s-1", tokenVersion: 2 };
  const t = issueStepUpToken(bind, "account.delete");
  ok("STEPUP-UNIT: wrong action refused", (await verifyAndConsumeStepUp(t, bind, "sessions.revoke_others")).ok === false);
  ok("STEPUP-UNIT: other generation refused", (await verifyAndConsumeStepUp(t, { ...bind, tokenVersion: 3 }, "account.delete")).ok === false);
  ok("STEPUP-UNIT: sid-less caller refused", (await verifyAndConsumeStepUp(t, { ...bind, sessionId: null }, "account.delete")).ok === false);
  const expiredT = issueStepUpToken(bind, "account.delete", Date.now() - 6 * 60 * 1000);
  const ex = await verifyAndConsumeStepUp(expiredT, bind, "account.delete");
  ok("STEPUP-UNIT: 6-minute-old token expired", ex.ok === false && ex.reason === "expired");
  ok("STEPUP-UNIT: valid once", (await verifyAndConsumeStepUp(t, bind, "account.delete")).ok === true);
  const { signAuthToken } = await import("@/lib/auth-token");
  ok("STEPUP-UNIT: a session token is not a step-up token", (await verifyAndConsumeStepUp(signAuthToken(5, 2, "s-1"), bind, "account.delete")).ok === false);

  // ── reset token ──
  const { issuePasswordResetToken, readPasswordResetToken, resolvePasswordResetSender } = await import("@/lib/auth/password-reset");
  const rt = issuePasswordResetToken({ id: 9, tokenVersion: 1, passwordHash: "$2b$10$h" });
  ok("RESET-UNIT: a fresh token reads back its binding", readPasswordResetToken(rt)?.userId === 9 && readPasswordResetToken(rt)?.tokenVersion === 1);
  const [pl, sg] = rt.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl, "base64url").toString()), sub: 10 })).toString("base64url") + "." + sg;
  ok("RESET-UNIT: a tampered token is refused", readPasswordResetToken(forged) === null);
  ok("RESET-UNIT: a step-up token is not a reset token (purpose separation)", readPasswordResetToken(t) === null);
  delete process.env.PASSWORD_RESET_EMAIL_PROVIDER;
  ok("RESET-UNIT: no provider configured → the sender is disabled (fail-closed)", resolvePasswordResetSender().configured === false);
  process.env.PASSWORD_RESET_EMAIL_PROVIDER = "made-up";
  ok("RESET-UNIT: an unknown provider value is NOT guessed", resolvePasswordResetSender().configured === false);
  delete process.env.PASSWORD_RESET_EMAIL_PROVIDER;

  // ── L-11 ──
  const { secretsEqual } = await import("@/lib/security/constant-time");
  ok("CT: equal secrets", secretsEqual("abc", "abc") && !secretsEqual("abc", "abd") && !secretsEqual(null, "abc") && !secretsEqual("ab", "abc"));
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verify-token-synthetic";
  const { verifySubscribeChallenge } = await import("@/lib/services/integrations/whatsapp/webhook-verify.service");
  ok("WA-VERIFY: right token accepted, wrong refused", verifySubscribeChallenge({ mode: "subscribe", verifyToken: "verify-token-synthetic", challenge: "c" }).ok === true && verifySubscribeChallenge({ mode: "subscribe", verifyToken: "verify-token-synthetiX", challenge: "c" }).ok === false);
  const waSrc = readFileSync("lib/services/integrations/whatsapp/webhook-verify.service.ts", "utf8");
  ok("CT-SOURCE: webhook verify token is compared in constant time", /secretsEqual\(params\.verifyToken, expectedToken\)/.test(waSrc) && !/params\.verifyToken !== expectedToken/.test(waSrc));
  const posSrc = readFileSync("app/api/inventory/pos/sale/route.ts", "utf8");
  ok("CT-SOURCE: POS env secret compared in constant time", /secretsEqual\(rawKey, envSecret\)/.test(posSrc) && !/rawKey !== envSecret/.test(posSrc));

  // POS: the address limiter runs BEFORE key authentication (behavioural, no DB:
  // a request with no key is refused before any lookup).
  const pos = await import("@/app/api/inventory/pos/sale/route");
  const posReq = () => new Request("https://lab.invalid/api/inventory/pos/sale", { method: "POST", headers: { "x-forwarded-for": "10.55.0.1" }, body: "{}" });
  let st = 0;
  for (let i = 0; i < 121; i++) st = (await pos.POST(posReq() as never)).status;
  ok("POS-PREAUTH-LIMIT: the 121st keyless request from one address is 429, not 401", st === 429, `status=${st}`);

  // ── L-12 ──
  const L12 = [
    "app/api/conversation/route.ts",
    "app/api/conversations/route.ts",
    "app/api/conversation/[id]/route.ts",
    "app/api/conversation/[id]/close/route.ts",
    "app/api/deals/[id]/route.ts",
    "app/api/deals/generate/route.ts",
    "app/api/inbox/attention/route.ts",
    "app/api/message/route.ts",
    "app/api/reply-suggestion/action/route.ts",
    "app/api/video/generate/route.ts",
  ];
  const leaks = L12.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /details\s*[:,]/.test(src) || /error:\s*e\?\.message/.test(src) || /details:\s*error/.test(src);
  });
  ok("L12-NO-DETAILS: no listed route returns raw exception text", leaks.length === 0, leaks.join(","));
  const { logRouteError } = await import("@/lib/security/route-error");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  logRouteError("X", Object.assign(new Error("customer phone 0501234567"), { code: "P2002" }));
  console.error = orig;
  ok("L12-LOG: the server log carries the class and code, never the message", lines.length === 1 && lines[0].includes("P2002") && !lines[0].includes("0501234567"));
  const video = await import("@/app/api/video/generate/route");
  void video;

  // ── M-8 CSP / I-1 ──
  const { buildContentSecurityPolicy, PERMISSIONS_POLICY } = await import("@/lib/security/csp");
  const prod = buildContentSecurityPolicy({ nonce: "N0NCE", isDev: false, r2PublicBaseUrl: "https://pub.example.r2.dev/some/path" });
  const scriptSrc = /script-src ([^;]+)/.exec(prod)?.[1] ?? "";
  ok("CSP: script-src is nonce + strict-dynamic", scriptSrc.includes("'nonce-N0NCE'") && scriptSrc.includes("'strict-dynamic'"));
  ok("CSP: script-src has no unsafe-inline / unsafe-eval / wildcard in production", !/'unsafe-inline'|'unsafe-eval'|\s\*(\s|$)|https:(\s|$)/.test(scriptSrc));
  ok("CSP: object-src none, base-uri self, form-action self, frame-ancestors self", /object-src 'none'/.test(prod) && /base-uri 'self'/.test(prod) && /form-action 'self'/.test(prod) && /frame-ancestors 'self'/.test(prod));
  ok("CSP: R2 public ORIGIN (not path) is allowed for img/media", /img-src[^;]*https:\/\/pub\.example\.r2\.dev(\s|;|$)/.test(prod) && /media-src[^;]*https:\/\/pub\.example\.r2\.dev/.test(prod));
  ok("CSP: unsafe-eval only in development", buildContentSecurityPolicy({ nonce: "n", isDev: true }).includes("'unsafe-eval'"));
  ok("PERMISSIONS: camera and geolocation self only; microphone off", /camera=\(self\)/.test(PERMISSIONS_POLICY) && /geolocation=\(self\)/.test(PERMISSIONS_POLICY) && /microphone=\(\)/.test(PERMISSIONS_POLICY));
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  const p1 = proxy(new NextRequest("https://lab.invalid/login"));
  const p2 = proxy(new NextRequest("https://lab.invalid/login"));
  const n1 = /'nonce-([^']+)'/.exec(p1.headers.get("content-security-policy") ?? "")?.[1];
  const n2 = /'nonce-([^']+)'/.exec(p2.headers.get("content-security-policy") ?? "")?.[1];
  ok("CSP-PROXY: every document response carries an enforcing CSP with a fresh nonce", !!n1 && !!n2 && n1 !== n2 && Buffer.from(n1!, "base64").length === 16);
  const cfg = readFileSync("next.config.ts", "utf8");
  ok("I1: X-Powered-By disabled", /poweredByHeader:\s*false/.test(cfg));

  console.log(`\nsec-B identity unit matrix: PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("UNIT MATRIX CRASH:", e);
    process.exit(3);
  }
);
