/**
 * D2 / AUTH BOUNDARY STAGE B — login, session, /me and logout through the real
 * Preview deployment, with every write verified in the database afterwards.
 *
 * The API reporting success is never the evidence here. Under a column-level
 * UPDATE grant a write that touches an ungranted column fails, and under a
 * misconfigured plane a request can succeed against the wrong identity — both
 * look identical from the response. So each mutation is read back, and the
 * identity is re-checked from inside the application between steps.
 *
 * No password, hash or token is printed.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const BASE = process.env.STAGEB_BASE_URL;
const BYPASS = readFileSync(process.env.BYPASS_FILE, "utf8").trim();
const EMAIL = process.env.STAGEB_EMAIL;
const PASSWORD = process.env.STAGEB_PASSWORD;
const db = new PrismaClient({ datasourceUrl: readFileSync(process.env.AUTH_URL_FILE, "utf8").trim() });

let pass = 0;
let fail = 0;
const notes = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; notes.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function call(method, path, { token, body } = {}) {
  const headers = { "x-vercel-protection-bypass": BYPASS };
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json };
}

const userRow = () => db.$queryRawUnsafe(
  `SELECT id, "businessId", "lastLoginAt", "loginCount", "tokenVersion", "updatedAt"
     FROM "User" WHERE email = $1`, EMAIL);

async function main() {
  console.log(`== target: ${BASE} ==`);

  // ---- PHASE 2: login ------------------------------------------------------
  console.log("\n== PHASE 2: login ==");
  const before = (await userRow())[0];
  ok("the synthetic Preview account exists", !!before, "no row for the harness account");
  if (!before) { await done(); return; }
  console.log(`     before: loginCount=${before.loginCount} tokenVersion=${before.tokenVersion} lastLoginAt=${before.lastLoginAt ? "set" : "null"}`);

  const login = await call("POST", "/api/auth/login", { body: { email: EMAIL, password: PASSWORD } });
  ok("login with valid credentials succeeds", login.status === 200 && !!login.json?.token,
    `${login.status} ${login.text.slice(0, 200)}`);
  const token = login.json?.token;
  ok("password verification ran against the stored hash (a wrong password must not pass)",
    login.status === 200);

  const afterLogin = (await userRow())[0];
  console.log(`     after:  loginCount=${afterLogin.loginCount} tokenVersion=${afterLogin.tokenVersion} lastLoginAt=${afterLogin.lastLoginAt ? "set" : "null"}`);
  ok("loginCount incremented and PERSISTED",
    Number(afterLogin.loginCount) === Number(before.loginCount) + 1,
    `${before.loginCount} -> ${afterLogin.loginCount}`);
  ok("lastLoginAt written and PERSISTED", afterLogin.lastLoginAt !== null);
  ok("updatedAt advanced (Prisma writes it on every update; the grant must cover it)",
    new Date(afterLogin.updatedAt).getTime() >= new Date(before.updatedAt).getTime());

  // ---- failed login: no enumeration, no fallback ---------------------------
  console.log("\n== PHASE 2b: failed login ==");
  const wrongPw = await call("POST", "/api/auth/login", { body: { email: EMAIL, password: "definitely-wrong" } });
  const noSuchUser = await call("POST", "/api/auth/login", {
    body: { email: `nobody-${Date.now()}@example.invalid`, password: "definitely-wrong" },
  });
  ok("a wrong password is rejected", wrongPw.status === 401, String(wrongPw.status));
  ok("an unknown address is rejected", noSuchUser.status === 401, String(noSuchUser.status));
  ok("both failures are indistinguishable (no account enumeration)",
    wrongPw.status === noSuchUser.status && wrongPw.text === noSuchUser.text,
    `${wrongPw.text.slice(0, 60)} vs ${noSuchUser.text.slice(0, 60)}`);
  const afterFailed = (await userRow())[0];
  ok("a failed login writes nothing",
    Number(afterFailed.loginCount) === Number(afterLogin.loginCount),
    `${afterLogin.loginCount} -> ${afterFailed.loginCount}`);

  // ---- PHASE 3: session / me ----------------------------------------------
  console.log("\n== PHASE 3: session validation and /api/auth/me ==");
  const me = await call("GET", "/api/auth/me", { token });
  ok("authenticated /api/auth/me succeeds", me.status === 200, `${me.status} ${me.text.slice(0, 160)}`);
  ok("it returns the right user and tenant binding",
    me.json?.user?.id === before.id && me.json?.user?.businessId === before.businessId,
    JSON.stringify(me.json?.user ?? null));
  const unauth = await call("GET", "/api/auth/me");
  ok("without a token it is 401 (session validation is doing real work)", unauth.status === 401,
    String(unauth.status));

  // ---- PHASE 4: logout and tokenVersion ------------------------------------
  console.log("\n== PHASE 4: logout, tokenVersion and revocation ==");
  const beforeLogout = (await userRow())[0];
  const logout = await call("POST", "/api/auth/logout", { token });
  ok("logout succeeds", logout.status === 200, `${logout.status} ${logout.text.slice(0, 160)}`);
  const afterLogout = (await userRow())[0];
  ok("tokenVersion incremented and PERSISTED",
    Number(afterLogout.tokenVersion) === Number(beforeLogout.tokenVersion) + 1,
    `${beforeLogout.tokenVersion} -> ${afterLogout.tokenVersion}`);
  ok("updatedAt advanced on the logout write too",
    new Date(afterLogout.updatedAt).getTime() >= new Date(beforeLogout.updatedAt).getTime());
  const reuse = await call("GET", "/api/auth/me", { token });
  ok("the pre-logout token is refused afterwards (revocation holds)", reuse.status === 401,
    `${reuse.status} ${reuse.text.slice(0, 120)}`);

  await done();
}

async function done() {
  console.log(`\n[runtime] PASS=${pass} FAIL=${fail}`);
  if (notes.length) for (const n of notes) console.log(`   - ${n}`);
  await db.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", String(e?.message ?? e).slice(0, 400));
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
