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
 *   4. verification: a verify link stamps emailVerifiedAt for that owner only; resend then says
 *      "already verified"; a reset link cannot verify and a verify link cannot reset.
 *   5. login: ten failed attempts on one account → even the RIGHT password is refused (429, Hebrew)
 *      until the window passes — and another account signs in normally meanwhile.
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
  readEmailVerified,
  requestEmailVerification,
  requestPasswordReset,
  consumeEmailVerification,
} from "@/lib/auth/email-tokens";
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
  const C = await account("C");
  const v = await requestEmailVerification(C.userId, new Date());
  ok("a verification link is issued for an unverified owner", v.status === "SENT");
  const vRow = v.status === "SENT" ? await emailRow(v.link.emailId) : undefined;
  const vToken = vRow ? tokenFrom("EMAIL_VERIFY", vRow.payload) : "";
  ok("a verify link cannot reset a password", (await handleReset(post("/api/auth/password/reset", { token: vToken, password: NEW_PW }))).status === 400);
  const r2 = await requestPasswordReset(C.email, new Date());
  const r2Row = r2 ? await emailRow(r2.emailId) : undefined;
  ok("a reset link cannot verify", (await consumeEmailVerification(r2Row ? tokenFrom("PASSWORD_RESET", r2Row.payload) : "")).status === "INVALID");
  ok("the verify link verifies", (await consumeEmailVerification(vToken)).status === "VERIFIED");
  ok("C reads as verified; B (never verified) does not", (await readEmailVerified(C.userId)) === true && (await readEmailVerified(B.userId)) === false);
  ok("resend now answers 'already verified'", (await requestEmailVerification(C.userId, new Date())).status === "ALREADY_VERIFIED");

  console.log("\n— 5. login: the per-account failure limit —");
  const E = await account("E");
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) statuses.push((await login(post("/api/auth/login", { email: E.email, password: `wrong-${i}` }, `198.51.100.${100 + i}`))).status);
  ok("ten wrong passwords from ten addresses: ten 401s", statuses.every((s) => s === 401), statuses.join(","));
  const blocked = await login(post("/api/auth/login", { email: E.email, password: OLD_PW }, "198.51.100.150"));
  const blockedBody = await blocked.json();
  ok("the 11th attempt — even with the RIGHT password — is 429 (Hebrew), before any compare",
    blocked.status === 429 && blockedBody.code === "RATE_LIMITED" && /[֐-׿]/.test(blockedBody.error));
  const other = await login(post("/api/auth/login", { email: B.email, password: OLD_PW }, "198.51.100.151"));
  ok("another account signs in normally meanwhile", other.status === 200);
  const F = await account("F");
  for (let i = 0; i < 12; i++) await login(post("/api/auth/login", { email: F.email, password: OLD_PW }, `198.51.101.${i}`));
  const stillOk = await login(post("/api/auth/login", { email: F.email, password: OLD_PW }, "198.51.101.99"));
  ok("successful logins spend nothing: the 13th correct login still succeeds", stillOk.status === 200);

  console.log(`\n[aet-app-battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); setTimeout(() => process.exit(), 200); });
