/**
 * Account recovery — the REAL routes and libraries against a Production-shaped database with migration
 * 20261017090000_auth_email_tokens applied (.aet/lab.sh <db> --with-aet), as the real planes:
 *   auth plane  (AUTH_DATABASE_URL = te_auth_login, member of app_auth, AUTH_PLANE_ENABLED=true),
 *   tenant plane (DATABASE_URL = app_runtime_prod), owner (OWNER_URL) for fixtures and read-back only.
 * No email is sent: delivery is OFF (no TRANSACTIONAL_EMAIL_*); the battery reads the recorded email row
 * and renders it exactly as delivery would, to follow the link a person would click.
 *
 *   1. forgot-password: a reset email is recorded for a registered address — token id + first name only,
 *      never the secret — and nothing for an unknown address or a business in deletion.
 *   2. reset: the rendered link checks VALID; the new password is set (bcrypt), tokenVersion bumps, every
 *      refresh session dies, a token minted before the reset is refused by getAuthContext; the old
 *      password fails at the REAL login route and the new one signs in; replay → TOKEN_USED.
 *   3. tenant isolation: another business's owner is untouched by all of it.
 *   4. verification (accounts OPENED with it only): an existing account reads NOT_REQUIRED and is sent
 *      nothing; signup with verification ON records only the link (no WELCOME); resend supersedes;
 *      verifying stamps emailVerifiedAt and records exactly one WELCOME for that account's own address
 *      and business; replay is USED with no second WELCOME; a reset link cannot verify and a verify
 *      link cannot reset; signup with verification OFF still records the WELCOME at signup.
 *   5. login (4 failures / rolling 15 min / 15-minute lock): the 3rd failure warns, the 4th locks; the lock
 *      holds across IPs and case variants, refuses even the right password, and is answered identically
 *      for an address with no account; a parallel burst runs at most 4 comparisons; a success clears
 *      the ledger; a known device (its cookie) keeps its own ledger; the per-IP limit still applies.
 *
 * env: OWNER_URL, DATABASE_URL, AUTH_DATABASE_URL, AUTH_PLANE_ENABLED=true, AUTH_TOKEN_SECRET,
 * RATE_LIMIT_BACKEND=memory. Synthetic only. ZERO network.
 */
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

import { getAuthContext, signAuthToken } from "@/lib/auth";
import { issueRefreshSession } from "@/lib/auth/refresh-session";
import {
  checkAccountLink,
  issueAccountLink,
  readEmailVerified,
  readVerificationState,
  requestEmailVerification,
  requestPasswordReset,
  consumeEmailVerification,
} from "@/lib/auth/email-tokens";
import { createAccount } from "@/lib/auth/signup";
import { renderStored } from "@/lib/email/transactional/registry";
import { handleReset } from "@/app/api/auth/password/reset/route";
import { handleForgot } from "@/app/api/auth/password/forgot/route";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { POST as login } from "@/app/api/auth/login/route";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

const OLD_PW = "old-password-1";
const NEW_PW = "new-password-2";
type Acct = { userId: number; businessId: number; email: string };

async function account(tag: string): Promise<Acct> {
  const hash = await bcrypt.hash(OLD_PW, 10);
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `aet-app-${tag}`)) as { id: number }[];
  const email = `aet-app-${tag.toLowerCase()}-${Date.now()}@lab.invalid`;
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,$3,$4, now()) RETURNING id`,
    email, hash, `דנה ${tag}`, Number(b[0].id),
  )) as { id: number }[];
  return { userId: Number(u[0].id), businessId: Number(b[0].id), email };
}
const user = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT "password","tokenVersion","emailVerifiedAt" FROM "User" WHERE id = $1`, id)) as Record<string, unknown>[])[0];
const openSessions = async (userId: number) =>
  Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "AuthSession" WHERE "userId" = $1 AND "revokedAt" IS NULL`, userId)) as { c: number }[])[0].c);
const emailRow = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT "kind","userId","businessId","toEmail","payload" FROM "TransactionalEmail" WHERE id = $1`, id)) as Record<string, unknown>[])[0];
/** The link a person would click: render the stored row exactly as delivery would, pull the fragment. */
function tokenFrom(kind: string, payload: unknown): string {
  const r = renderStored(kind, payload, { appBaseUrl: "https://app.example.test" });
  const m = r ? /#t=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})/.exec(r.text) : null;
  return m ? m[1] : "";
}
const post = (url: string, body: unknown, ip = "198.51.100.7") =>
  new Request(`http://lab${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "user-agent": "aet-app-battery" },
    body: JSON.stringify(body),
  });

async function main() {
  const A = await account("A");
  const B = await account("B");
  const now = new Date();
  // Two live sessions for A (two devices) and one for B; and an access token A held before the reset.
  const sA1 = await issueRefreshSession(owner, { userId: A.userId, tokenVersion: 0, now, userAgent: "device-1" });
  await issueRefreshSession(owner, { userId: A.userId, tokenVersion: 0, now, userAgent: "device-2" });
  await issueRefreshSession(owner, { userId: B.userId, tokenVersion: 0, now, userAgent: "device-b" });
  const oldTokenA = signAuthToken(A.userId, 0, sA1.sessionId);
  const bearer = (t: string) => new Request("http://lab/api/x", { headers: { authorization: `Bearer ${t}` } });
  ok("fixture: A's pre-reset access token authenticates", (await getAuthContext(bearer(oldTokenA)))?.user.id === A.userId);

  console.log("\n— 1. forgot-password —");
  const link = await requestPasswordReset(A.email.toUpperCase(), new Date());
  ok("a registered address (any case) gets a reset link and its email row", link !== null && link.businessId === A.businessId);
  const row = link ? await emailRow(link.emailId) : undefined;
  ok("the email row is PASSWORD_RESET, to the account's own address, filed under its business",
    row?.kind === "PASSWORD_RESET" && row?.toEmail === A.email && Number(row?.userId) === A.userId && Number(row?.businessId) === A.businessId);
  ok("the outbox holds the token id and the first name ONLY — never a secret or a link",
    JSON.stringify(Object.keys((row?.payload as object) ?? {}).sort()) === JSON.stringify(["firstName", "tokenId"]) && !JSON.stringify(row?.payload).includes("#t="));
  const before = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "TransactionalEmail"`)) as { c: number }[])[0].c);
  ok("an unknown address: nothing issued", (await requestPasswordReset("nobody-here@lab.invalid", new Date())) === null);
  const after = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "TransactionalEmail"`)) as { c: number }[])[0].c);
  ok("…and no email row written", after === before);
  const D = await account("deleting");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, D.businessId);
  ok("a business in deletion: nothing issued", (await requestPasswordReset(D.email, new Date())) === null);

  // The REAL route, end to end, with the work run inline instead of after a response.
  let deferredRan = false;
  const viaRoute = await handleForgot(post("/api/auth/password/forgot", { email: B.email }), {
    enabled: () => true,
    rateLimit: consumeRateLimit,
    request: requestPasswordReset,
    deliver: async () => undefined,
    defer: (work) => { deferredRan = true; void work(); },
  });
  ok("the real forgot route answers 200 with the neutral sentence", viaRoute.status === 200 && (await viaRoute.json()).message.startsWith("אם הכתובת"));
  await new Promise((r) => setTimeout(r, 500));
  ok("…and did its work after answering", deferredRan);

  console.log("\n— 2. reset —");
  const token = row ? tokenFrom("PASSWORD_RESET", row.payload) : "";
  ok("the rendered email carries a usable link", token.length > 0);
  ok("the link checks VALID", (await checkAccountLink(token, "PASSWORD_RESET")) === "VALID");
  const weak = await handleReset(post("/api/auth/password/reset", { token, password: "short" }));
  ok("a short password is refused and the link stays usable", weak.status === 400 && (await checkAccountLink(token, "PASSWORD_RESET")) === "VALID");
  const tvBefore = Number((await user(A.userId)).tokenVersion);
  const bBefore = await user(B.userId);
  const done = await handleReset(post("/api/auth/password/reset", { token, password: NEW_PW }));
  ok("the real reset route: 200", done.status === 200, `${done.status}`);
  ok("…and it clears this browser's refresh cookie", /dubiz_rt=;/.test(done.headers.get("set-cookie") ?? ""));
  const aAfter = await user(A.userId);
  ok("the new password is stored as bcrypt and matches", await bcrypt.compare(NEW_PW, String(aAfter.password)));
  ok("tokenVersion bumped", Number(aAfter.tokenVersion) === tvBefore + 1);
  ok("every refresh session of A is revoked", (await openSessions(A.userId)) === 0);
  ok("A's pre-reset access token is now refused everywhere", (await getAuthContext(bearer(oldTokenA))) === null);
  ok("a reset proves the address: emailVerifiedAt stamped", aAfter.emailVerifiedAt instanceof Date);
  const replay = await handleReset(post("/api/auth/password/reset", { token, password: "another-one-3" }));
  ok("replaying the link: 400 TOKEN_USED, password unchanged",
    replay.status === 400 && (await replay.json()).code === "TOKEN_USED" && (await bcrypt.compare(NEW_PW, String((await user(A.userId)).password))));

  const oldLogin = await login(post("/api/auth/login", { email: A.email, password: OLD_PW }, "198.51.100.20"));
  const oldBody = await oldLogin.json();
  ok("the REAL login route refuses the old password (401, Hebrew)", oldLogin.status === 401 && oldBody.error === "האימייל או הסיסמה שגויים", JSON.stringify(oldBody));
  const newLogin = await login(post("/api/auth/login", { email: A.email, password: NEW_PW }, "198.51.100.21"));
  const newBody = await newLogin.json();
  ok("…and signs in with the new one (fresh session at the new generation)", newLogin.status === 200 && typeof newBody.token === "string");
  ok("…whose token authenticates", (await getAuthContext(bearer(newBody.token)))?.user.id === A.userId);

  console.log("\n— 3. tenant isolation —");
  const bAfter = await user(B.userId);
  ok("B's password, generation and sessions are untouched by A's reset",
    bAfter.password === bBefore.password && Number(bAfter.tokenVersion) === Number(bBefore.tokenVersion) && (await openSessions(B.userId)) === 1);

  console.log("\n— 4. verification —");
  const rowsOf = async (userId: number) =>
    (await owner.$queryRawUnsafe(`SELECT "id","kind","toEmail","businessId","status" FROM "TransactionalEmail" WHERE "userId" = $1 ORDER BY "id"`, userId)) as
      { id: number; kind: string; toEmail: string; businessId: number; status: string }[];
  const kinds = async (userId: number) => (await rowsOf(userId)).map((r) => r.kind).join(",");

  // An account that existed before verification was switched on: never asked to verify.
  ok("an EXISTING account (opened without verification) reads NOT_REQUIRED — no banner",
    (await readVerificationState(B.userId)) === "NOT_REQUIRED" && (await readEmailVerified(B.userId)) === false);
  const bRowsBefore = (await rowsOf(B.userId)).length;
  ok("…and 'send again' issues nothing for it (NOT_REQUIRED), no email row written",
    (await requestEmailVerification(B.userId, new Date())).status === "NOT_REQUIRED" && (await rowsOf(B.userId)).length === bRowsBefore);

  // Regression: a signup with verification OFF records the WELCOME at signup, as before.
  const plain = await createAccount({
    email: `aet-app-plain-${Date.now()}@lab.invalid`, passwordHash: await bcrypt.hash(OLD_PW, 10), name: "נועה פלאן",
    businessName: "aet-app-plain", now: new Date(), sendVerification: false,
  });
  ok("signup, verification OFF: WELCOME recorded at signup, no link",
    plain.welcomeEmailId !== null && plain.verificationEmailId === null && (await kinds(plain.userId)) === "WELCOME", await kinds(plain.userId));

  // A NEW account opened with verification ON — the real signup transaction.
  const cEmail = `aet-app-c-${Date.now()}@lab.invalid`;
  const C = await createAccount({
    email: cEmail, passwordHash: await bcrypt.hash(OLD_PW, 10), name: "דנה C",
    businessName: "aet-app-C", now: new Date(), sendVerification: true,
  });
  ok("signup, verification ON: ONLY the verification email is recorded — no WELCOME yet",
    C.verificationEmailId !== null && C.welcomeEmailId === null && (await kinds(C.userId)) === "EMAIL_VERIFY", await kinds(C.userId));
  ok("…one user for the address (no duplicates)",
    Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM "User" WHERE lower("email") = lower($1)`, cEmail)) as { c: number }[])[0].c) === 1);
  ok("the new account reads PENDING (the banner shows)", (await readVerificationState(C.userId)) === "PENDING");
  const firstRow = C.verificationEmailId !== null ? await emailRow(C.verificationEmailId) : undefined;
  const firstToken = firstRow ? tokenFrom("EMAIL_VERIFY", firstRow.payload) : "";

  const v = await requestEmailVerification(C.userId, new Date());
  ok("'send again' for the new account issues a fresh link", v.status === "SENT");
  const vRow = v.status === "SENT" ? await emailRow(v.link.emailId) : undefined;
  const vToken = vRow ? tokenFrom("EMAIL_VERIFY", vRow.payload) : "";
  ok("…the earlier link is superseded", (await consumeEmailVerification(firstToken)).status === "SUPERSEDED");
  ok("a verify link cannot reset a password", (await handleReset(post("/api/auth/password/reset", { token: vToken, password: NEW_PW }))).status === 400);
  const r2 = await requestPasswordReset(cEmail, new Date());
  const r2Row = r2 ? await emailRow(r2.emailId) : undefined;
  ok("a reset link cannot verify", (await consumeEmailVerification(r2Row ? tokenFrom("PASSWORD_RESET", r2Row.payload) : "")).status === "INVALID");

  const verified = await consumeEmailVerification(vToken);
  ok("the verify link verifies, and records the WELCOME in the same step",
    verified.status === "VERIFIED" && verified.welcomeEmailId !== null && verified.businessId === C.businessId, JSON.stringify(verified));
  const welcomeRows = (await rowsOf(C.userId)).filter((r) => r.kind === "WELCOME");
  ok("exactly ONE WELCOME, PENDING, to the account's own address, filed under its own business",
    welcomeRows.length === 1 && welcomeRows[0].toEmail === cEmail && Number(welcomeRows[0].businessId) === C.businessId && welcomeRows[0].status === "PENDING");
  const vReplay = await consumeEmailVerification(vToken);
  ok("replaying the link → USED, and no second WELCOME",
    vReplay.status === "USED" && (await rowsOf(C.userId)).filter((r) => r.kind === "WELCOME").length === 1);
  ok("C reads VERIFIED; B (existing) still NOT_REQUIRED and untouched",
    (await readVerificationState(C.userId)) === "VERIFIED" && (await readEmailVerified(C.userId)) === true &&
      (await readVerificationState(B.userId)) === "NOT_REQUIRED" && (await rowsOf(B.userId)).length === bRowsBefore);
  ok("resend now answers 'already verified'", (await requestEmailVerification(C.userId, new Date())).status === "ALREADY_VERIFIED");

  // An account that already has its WELCOME (opened with verification OFF) and later verifies through a
  // link never gets a second one.
  const plainLink = await owner.$transaction((tx) =>
    issueAccountLink(tx, { userId: plain.userId, purpose: "EMAIL_VERIFY", name: "נועה פלאן", now: new Date() }));
  const plainRow = plainLink ? await emailRow(plainLink.emailId) : undefined;
  const plainVerified = await consumeEmailVerification(plainRow ? tokenFrom("EMAIL_VERIFY", plainRow.payload) : "");
  ok("verifying an account that already has a WELCOME records none (still exactly one WELCOME)",
    plainVerified.status === "VERIFIED" && plainVerified.welcomeEmailId === null &&
      (await rowsOf(plain.userId)).filter((r) => r.kind === "WELCOME").length === 1, JSON.stringify(plainVerified));

  console.log("\n— 5. login: 4 failures / rolling 15 minutes / 15-minute lock —");
  // Every request from a NEW IP: nothing below can be the per-IP limit.
  let ipN = 0;
  const freshIp = () => `198.18.${Math.floor(++ipN / 250)}.${ipN % 250}`;
  const signIn = async (email: string, password: string, cookie?: string) => {
    const r = new Request("http://lab/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), "user-agent": "aet-app-battery", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ email, password }),
    });
    const res = await login(r);
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after"), setCookie: res.headers.get("set-cookie") ?? "" };
  };
  const shape = (x: { status: number; body: Record<string, unknown> }) =>
    JSON.stringify({ s: x.status, code: x.body.code, error: x.body.error, warning: x.body.warning ?? null, left: x.body.attemptsLeft ?? null });

  const E = await account("E");
  const seq = [];
  for (let i = 1; i <= 4; i++) seq.push(await signIn(E.email, `wrong-${i}`));
  ok("failures 1–2: the ordinary Hebrew error, no warning",
    seq[0].status === 401 && seq[1].status === 401 && !seq[0].body.warning && !seq[1].body.warning && seq[0].body.error === "האימייל או הסיסמה שגויים");
  ok("failure 3: the error PLUS the owner-approved warning (one attempt left)",
    seq[2].status === 401 && seq[2].body.warning === "שים לב, נותר לך ניסיון התחברות אחד לפני חסימה זמנית ל־15 דקות." && seq[2].body.attemptsLeft === 1);
  ok("failure 4: a 15-minute lock — 429 LOGIN_LOCKED, Retry-After 900, the Hebrew time left",
    seq[3].status === 429 && seq[3].body.code === "LOGIN_LOCKED" && seq[3].body.retryAfterSeconds === 900 && seq[3].retryAfter === "900" &&
      String(seq[3].body.error).includes("בעוד 15 דקות"), JSON.stringify(seq[3]));
  const right = await signIn(E.email, OLD_PW);
  ok("while locked — even the RIGHT password, from a new IP — is refused with the time left",
    right.status === 429 && right.body.code === "LOGIN_LOCKED" && Number(right.body.retryAfterSeconds) > 850 && Number(right.body.retryAfterSeconds) <= 900);
  const upper = await signIn(E.email.toUpperCase(), OLD_PW);
  ok("…and a case variant of the address is the same lock", upper.status === 429 && upper.body.code === "LOGIN_LOCKED");
  ok("the lock message names no account and no address", !String(right.body.error).includes("@") && !/חשבון/.test(String(right.body.error)));
  const other = await signIn(B.email, OLD_PW);
  ok("another account signs in normally meanwhile", other.status === 200);

  // No enumeration: an address with NO account walks exactly the same sequence.
  const ghost = `nobody-${Date.now()}@lab.invalid`;
  const gseq = [];
  for (let i = 1; i <= 5; i++) gseq.push(await signIn(ghost, `wrong-${i}`));
  ok("an address with NO account gets the identical 1–2 / warning / lock / locked sequence",
    gseq.map(shape).slice(0, 4).join("|") === seq.map(shape).join("|") && gseq[4].status === 429 && gseq[4].body.code === "LOGIN_LOCKED",
    `${gseq.map(shape).join("|")} vs ${seq.map(shape).join("|")}`);

  // A parallel burst: at most four comparisons, whatever the IPs.
  const G = await account("G");
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => signIn(G.email, `burst-${i}`)));
  const s401 = burst.filter((b) => b.status === 401).length;
  const s429 = burst.filter((b) => b.status === 429).length;
  ok("a parallel burst of 10 from 10 IPs: only 4 compared (3 × 401 + the 4th locks) — 7 × 429", s401 === 3 && s429 === 7, `401=${s401} 429=${s429}`);
  const gRight = await signIn(G.email, OLD_PW);
  ok("…and the address is locked afterwards", gRight.status === 429 && gRight.body.code === "LOGIN_LOCKED");

  // A success is not a failure — and clears the ones before it.
  const H = await account("H");
  for (let i = 1; i <= 3; i++) await signIn(H.email, `wrong-${i}`);
  const hOk = await signIn(H.email, OLD_PW);
  ok("three failures then the right password: signed in (200)", hOk.status === 200);
  const after1 = await signIn(H.email, "wrong-again-1");
  const after3 = [after1, await signIn(H.email, "wrong-again-2"), await signIn(H.email, "wrong-again-3")];
  ok("…the ledger restarted: the next failures are 1, 2, then the warning — not a lock",
    after3.every((x) => x.status === 401) && !after3[0].body.warning && after3[2].body.warning !== undefined);

  // The owner's known device keeps its own ledger: a stranger cannot lock the owner out of it.
  const K = await account("K");
  const known = await signIn(K.email, OLD_PW);
  const deviceCookie = (/dubiz_ld=[^;]+/.exec(known.setCookie) ?? [""])[0];
  ok("a successful sign-in sets the known-device cookie (httpOnly, only for /api/auth/login)",
    deviceCookie.length > 10 && /HttpOnly/i.test(known.setCookie) && /Path=\/api\/auth\/login/i.test(known.setCookie));
  for (let i = 1; i <= 4; i++) await signIn(K.email, `attacker-${i}`);
  const strangerNow = await signIn(K.email, OLD_PW);
  ok("an attacker's 4 failures lock the address for any browser WITHOUT the cookie", strangerNow.status === 429);
  const ownerDevice = await signIn(K.email, OLD_PW, deviceCookie);
  ok("…but the owner's known device still signs in (its own ledger)", ownerDevice.status === 200);
  const Kb = await account("Kb");
  const kbCookie = (/dubiz_ld=[^;]+/.exec((await signIn(Kb.email, OLD_PW)).setCookie) ?? [""])[0];
  const borrowed = await signIn(K.email, OLD_PW, kbCookie);
  ok("another account's device cookie does not open this address's lock", borrowed.status === 429);
  const forged = await signIn(K.email, OLD_PW, deviceCookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")));
  ok("a tampered device cookie does not open it either", forged.status === 429);

  // The per-IP limit is still in force (10 a minute from one IP), whatever the addresses.
  const sameIp = "203.0.113.77";
  const ipStatuses: number[] = [];
  for (let i = 0; i < 11; i++) {
    const r = new Request("http://lab/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": sameIp },
      body: JSON.stringify({ email: `ip-${i}-${Date.now()}@lab.invalid`, password: "x" }),
    });
    ipStatuses.push((await login(r)).status);
  }
  ok("the per-IP limit still applies: the 11th request from one IP in a minute is 429", ipStatuses[10] === 429 && ipStatuses.slice(0, 10).every((s) => s === 401), ipStatuses.join(","));

  console.log(`\n[aet-app-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); setTimeout(() => process.exit(), 200); });
