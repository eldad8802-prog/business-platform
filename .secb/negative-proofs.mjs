/**
 * sec-B negative proofs — a mutation per control, each expected to turn ONE
 * named assertion red.
 *
 *   node .secb/negative-proofs.mjs [suite...]      suites: unit db mfa ita (default: all)
 *
 * For every mutation:
 *   1. sha256 the file; the anchor must occur EXACTLY once; apply; assert changed.
 *   2. run the suite; it must exit 1 (an assertion failure — a crash exits 3 and
 *      FAILS the proof) AND print the specific expected label as a failure.
 *   3. restore; sha256 must be byte-identical.
 * Records MUTATION / EXPECTED RED / ACTUAL RED / INTENDED REASON / RESTORE.
 * POST-RESTORE GREEN is the workflow re-running every suite afterwards.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SUITES = {
  unit: { cmd: ["npx", "tsx", ".secb/identity-unit.test.ts"], red: (label) => `FAIL  - ${label}` },
  db: { cmd: ["npx", "tsx", ".secb/identity-db-battery.ts"], red: (label) => `FAIL  - ${label}` },
  mfa: { cmd: ["npx", "tsx", "lib/auth/platform-admin-mfa.test.ts"], red: (label) => label },
  ita: {
    cmd: ["npx", "tsx", "lib/services/billing/authority/billing-authority-oauth-start-route.service.test.ts"],
    red: (label) => `FAIL: ${label}`,
  },
};

const M = [
  // ── unit ──
  { id: "N1", suite: "unit", file: "lib/security/rate-limiter/index.ts", anchor: `if (config.failMode === "closed") {`, repl: `if (false) {`, label: "LIMITER-FAILCLOSED: auth bucket with the backend down denies (backend_unavailable)", why: "limiter outage becomes unlimited guessing" },
  { id: "N2", suite: "unit", file: "lib/security/rate-limiter/index.ts", anchor: `if (identifier === null && config.requireAllIdentifiers) {`, repl: `if (false) {`, label: "LIMITER-STRICT: an auth bucket with a missing identifier DENIES (misconfigured)", why: "a per-account rule silently skipped" },
  { id: "N3", suite: "unit", file: "lib/security/csp.ts", anchor: `      "'strict-dynamic'",\n`, repl: `      "'strict-dynamic'",\n      "'unsafe-inline'",\n`, label: "CSP: script-src has no unsafe-inline / unsafe-eval / wildcard in production", why: "inline script injection allowed" },
  { id: "N4", suite: "unit", file: "app/api/deals/generate/route.ts", anchor: `{ error: "Failed to generate deals" }`, repl: `{ error: "Failed to generate deals", details: error.message }`, label: "L12-NO-DETAILS: no listed route returns raw exception text", why: "raw exception text in a 500" },
  { id: "N5", suite: "unit", file: "app/api/inventory/pos/sale/route.ts", anchor: `    if (!ipLimit.allowed) {`, repl: `    if (false) {`, label: "POS-PREAUTH-LIMIT: the 121st keyless request from one address is 429, not 401", why: "POS key guessing unthrottled before auth" },
  { id: "N6", suite: "unit", file: "lib/services/integrations/whatsapp/webhook-verify.service.ts", anchor: `!secretsEqual(params.verifyToken, expectedToken)`, repl: `params.verifyToken !== expectedToken`, label: "CT-SOURCE: webhook verify token is compared in constant time", why: "timing-variable secret compare" },
  // ── db ──
  { id: "N7", suite: "db", file: "lib/auth/credential-check.ts", anchor: `const matched = await compare(candidate, realHash && !oversized ? realHash : DUMMY_BCRYPT_HASH);`, repl: `const matched = realHash && !oversized ? await compare(candidate, realHash) : false;`, label: "LOGIN-TIMING: unknown email runs exactly one bcrypt compare", why: "timing oracle for account existence" },
  { id: "N8", suite: "db", file: "lib/security/rate-limiter/buckets.ts", anchor: `      { scope: "account", limit: 20, windowSeconds: 15 * 60 },\n`, repl: ``, label: "LOGIN-DISTRIBUTED: 21st attempt on one account from fresh IPs is throttled", why: "distributed guessing against one account" },
  { id: "N9", suite: "db", file: "app/api/auth/login/route.ts", anchor: `if (!user.business || !acceptsNormalWrites(user.business)) {`, repl: `if (false) {`, label: "LOGIN-LIFECYCLE: correct password on a quarantined business gets no session (403)", why: "session issued to a business being erased" },
  { id: "N10", suite: "db", file: "app/api/auth/password/change/route.ts", anchor: `const revoked = await revokeAllSessions(subject.id, CREDENTIAL_REVOKED_REASON.PASSWORD_CHANGED);`, repl: `const revoked = 0;`, label: "CHANGE-REVOKES: other sessions' rows are revoked (only the new one is live)", why: "sessions survive a password change" },
  { id: "N11", suite: "db", file: "lib/auth/session-directory.ts", anchor: `where: { id: userId, tokenVersion: expected },`, repl: `where: { id: userId },`, label: "RESET-RACE: exactly one of two concurrent confirms wins", why: "reset token usable twice under concurrency" },
  { id: "N12", suite: "db", file: "app/api/auth/password/reset/confirm/route.ts", anchor: `    if (!deps.senderConfigured) return invalidToken();\n`, repl: ``, label: "RESET-FAILCLOSED: with no configured sender even a valid token is refused", why: "reset usable without a delivery channel" },
  { id: "N13", suite: "db", file: "app/api/account/route.ts", anchor: `  if (!stepUp.ok) {`, repl: `  if (false) {`, label: "STEPUP-ACCOUNT: DELETE without step-up is refused 403 STEP_UP_REQUIRED", why: "account deletion with a bearer token alone" },
  { id: "N14", suite: "db", file: "lib/auth/step-up.ts", anchor: `  if (once === "reused") return { ok: false, reason: "reused" };\n`, repl: ``, label: "STEPUP-SINGLEUSE: the same step-up token a second time is refused", why: "step-up replayable" },
  { id: "N15", suite: "db", file: "lib/auth/step-up.ts", anchor: `    p.sid !== binding.sessionId ||`, repl: `    false ||`, label: "STEPUP-BINDING: a step-up minted on another device session is refused", why: "step-up transferable between devices" },
  { id: "N16", suite: "db", file: "app/api/auth/refresh/logout/route.ts", anchor: `const outcome = await logoutByRefreshCredential(readRefreshCookie(req));`, repl: `const outcome = { kind: "unknown" as const, userId: 0 };`, label: "COOKIE-LOGOUT: refresh sessions revoked without an access token", why: "logout with an expired token leaves refresh sessions" },
  { id: "N17", suite: "db", file: "app/api/auth/register/route.ts", anchor: `deps.signToken(account.userId, account.tokenVersion, session.sessionId)`, repl: `deps.signToken(account.userId, account.tokenVersion, undefined as never)`, label: "REGISTER-SID: the signup token names a real, live session", why: "sid-less token at signup" },
  { id: "N18", suite: "db", file: "app/api/platform-admin/mfa/enroll/route.ts", anchor: `  if (verdict !== "ok") {`, repl: `  if (false) {`, label: "ENROLL-CODE: enrollment without the bootstrap code is refused", why: "TOFU enrollment with a stolen admin bearer" },
  { id: "N19", suite: "db", file: "lib/auth/admin-mfa.service.ts", anchor: `          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],\n`, repl: ``, label: "TOTP-RACE: exactly one of two concurrent uses of one code is accepted", why: "TOTP replay under concurrency" },
  { id: "N20", suite: "db", file: "lib/auth/admin-mfa.service.ts", anchor: `         AND \${match} = ANY("recoveryCodeHashes")\``, repl: "`", label: "RECOVERY-RACE: exactly one of two concurrent uses of one recovery code is accepted", why: "recovery code spent twice" },
  { id: "N21", suite: "db", file: "lib/auth/platform-admin-elevation.ts", anchor: `if (payload.sid !== binding.sessionId || payload.tv !== binding.tokenVersion) {`, repl: `if (false) {`, label: "ELEVATION-SESSION: refused on another session of the same admin", why: "elevation transferable between sessions" },
  { id: "N22", suite: "db", file: "lib/auth/platform-admin.ts", anchor: `return process.env.PLATFORM_ADMIN_MFA_REQUIRED?.trim().toLowerCase() !== "false";`, repl: `return process.env.PLATFORM_ADMIN_MFA_REQUIRED?.trim().toLowerCase() === "true";`, label: "MFA-FAILCLOSED: flag unset → an un-elevated admin request is refused", why: "MFA silently off when the flag is unset" },
  // ── mfa unit ──
  { id: "N23", suite: "mfa", file: "lib/auth/platform-admin.ts", anchor: `  if (isProductionRuntime()) return true;\n`, repl: ``, label: "must require MFA", why: "production MFA opt-out possible" },
  { id: "N24", suite: "mfa", file: "lib/auth/admin-mfa-crypto.ts", anchor: "return Buffer.from(`admin-mfa:user:${userId}`, \"utf8\");", repl: `return Buffer.from("admin-mfa:user", "utf8");`, label: "a seed moved to another admin's row must not decrypt", why: "seed ciphertext not bound to its owner" },
  // ── ita ──
  { id: "N25", suite: "ita", file: "lib/services/billing/authority/billing-authority-oauth-start-route.service.ts", anchor: `      isAllowlistedPlatformAdmin(input.user) &&\n`, repl: ``, label: "PLATFORM_ADMIN role off the allowlist cannot target another business", why: "cross-tenant ITA start skips the admin allowlist" },
];

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const wanted = new Set(process.argv.slice(2));
const rows = [];
let broken = 0;

for (const m of M) {
  if (wanted.size && !wanted.has(m.suite) && !wanted.has(m.id)) continue;
  const before = sha(m.file);
  const text = readFileSync(m.file, "utf8");
  const n = text.split(m.anchor).length - 1;
  if (n !== 1) {
    console.error(`${m.id}: anchor must occur exactly once in ${m.file}, found ${n}`);
    broken += 1;
    rows.push({ ...m, actual: `ANCHOR x${n}`, restore: "n/a", verdict: "BROKEN" });
    continue;
  }
  writeFileSync(m.file, text.replace(m.anchor, () => m.repl));
  if (sha(m.file) === before) throw new Error(`${m.id}: mutation did not change ${m.file}`);
  const suite = SUITES[m.suite];
  const r = spawnSync(suite.cmd[0], suite.cmd.slice(1), { encoding: "utf8", shell: process.platform === "win32", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  writeFileSync(m.file, text);
  const restored = sha(m.file) === before;
  const redLine = suite.red(m.label);
  const hit = out.includes(redLine);
  const verdict = r.status === 1 && hit && restored ? "PASS" : "FAIL";
  if (verdict !== "PASS") broken += 1;
  rows.push({ ...m, actual: `exit=${r.status}; ${hit ? "label red" : "LABEL NOT RED"}`, restore: restored ? "sha256 identical" : "RESTORE MISMATCH", verdict });
  console.log(`${verdict} ${m.id} [${m.suite}] exit=${r.status} labelRed=${hit} restored=${restored} — ${m.label}`);
  if (verdict !== "PASS") console.log(out.split("\n").filter((l) => /FAIL|CRASH|Error/.test(l)).slice(0, 12).join("\n"));
}

const table = [
  "| ID | MUTATION (file) | EXPECTED RED | ACTUAL RED | INTENDED REASON | RESTORE | VERDICT |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | \`${r.file}\` | ${r.label} | ${r.actual} | ${r.why} | ${r.restore} | ${r.verdict} |`),
].join("\n");
console.log("\n" + table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### sec-B negative proofs\n\n${table}\n`);
if (broken > 0) {
  console.error(`\nNEGATIVE PROOFS: ${broken} did not prove their control`);
  process.exit(1);
}
console.log(`\nNEGATIVE PROOFS: all ${rows.length} proved their control`);
