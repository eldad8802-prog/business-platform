/**
 * PR2 — persistent login: the privilege rehearsal.
 *
 * WHY THIS EXISTS, in one sentence: on 2026-09-08 Production login returned 500
 * on a correct password for two hours because a Prisma write with no `select`
 * appended `RETURNING` over columns the auth plane could not read, and the
 * privilege battery that existed at the time passed straight through it — every
 * statement it issued was one a human had chosen to write.
 *
 * So this battery does not ask "do the documented grants look right". It:
 *
 *   1. applies the SHIPPED privilege migrations, parsed from prisma/migrations
 *      rather than restated here, so the file cannot drift from Production;
 *   2. connects as a LOGIN role that is a member of `app_auth` and holds nothing
 *      directly, which is the topology Production actually runs;
 *   3. drives the REAL issue / refresh / logout service functions;
 *   4. CAPTURES the SQL Prisma actually emits and asserts every INSERT and
 *      UPDATE column set is inside the granted set — measured, not inferred;
 *   5. keeps the 2026-09-08 defect as a NEGATIVE CONTROL. If a write with no
 *      `select` ever stops being refused, this lab has stopped reproducing
 *      Production and every other result in the file is worthless.
 *
 * ZERO network, ZERO Neon, ZERO Production. Local lab only.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const AUTH_ROLE = "pr2_auth_login";
const AUTH_PW = "pr2_ci_synthetic_auth_pw";
const MARK = "pr2-";

const E4 = "prisma/migrations/20260908180000_d2_user_business_privilege_narrowing/migration.sql";
const SESSION_CONTRACT =
  "prisma/migrations/20260908200000_auth_session_privilege_contract/migration.sql";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ""): boolean {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
  return cond;
}

function pgCode(e: unknown): string | null {
  const text = String((e as Error)?.message ?? e);
  const m = text.match(/code:\s*"(\w+)"/) ?? text.match(/\b(42501)\b/);
  return m ? m[1] : null;
}

/**
 * Split a migration file into statements.
 *
 * Naive splitting on ";" fails these files twice over, and both failures are
 * silent-looking `42601`s rather than anything that names the cause: the long
 * explanatory headers contain prose semicolons, and the auth-session contract is
 * one `DO $do$ ... $do$` block whose body is full of them. So comments are
 * stripped first, and the scanner then tracks single quotes and dollar-quote
 * tags so a ";" inside either is not a boundary.
 */
function splitSqlStatements(raw: string): string[] {
  const sql = raw.replace(/^\s*--.*$/gm, "");
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inSingle = false;
  let tag: string | null = null;

  while (i < sql.length) {
    if (tag) {
      if (sql.startsWith(tag, i)) {
        buf += tag;
        i += tag.length;
        tag = null;
        continue;
      }
    } else if (inSingle) {
      if (sql[i] === "'") inSingle = false;
    } else {
      const dollar = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (dollar) {
        tag = dollar[0];
        buf += tag;
        i += tag.length;
        continue;
      }
      if (sql[i] === "'") inSingle = true;
      else if (sql[i] === ";") {
        const stmt = buf.trim();
        if (stmt) out.push(stmt);
        buf = "";
        i += 1;
        continue;
      }
    }
    buf += sql[i];
    i += 1;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

function roleUrl(base: string, user: string, pw: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = pw;
  return u.toString();
}

/** Granted column set for one verb on one table, parsed from a shipped migration. */
function grantedColumns(file: string, verb: "INSERT" | "UPDATE", table: string): Set<string> {
  const sql = readFileSync(file, "utf8").replace(/--.*$/gm, "");
  const re = new RegExp(
    `GRANT\\s+${verb}\\s*\\(([^)]*)\\)\\s*\\n?\\s*ON\\s+public\\."${table}"\\s+TO\\s+app_auth\\s*;`,
    "i"
  );
  const m = sql.match(re);
  return new Set([...(m?.[1] ?? "").matchAll(/"(\w+)"/g)].map((x) => x[1]));
}

/** Does the migration grant this verb at TABLE level (no column list)? */
function grantsTableLevel(file: string, verb: string, table: string): boolean {
  const sql = readFileSync(file, "utf8").replace(/--.*$/gm, "");
  return new RegExp(`GRANT\\s+${verb}\\s+ON\\s+public\\."${table}"\\s+TO\\s+app_auth\\s*;`, "i").test(
    sql
  );
}

function columnsOf(sql: string, kind: "INSERT" | "UPDATE"): string[] {
  if (kind === "INSERT") {
    const m = sql.match(/INSERT INTO[^(]*\(([^)]*)\)/i);
    return [...(m?.[1] ?? "").matchAll(/"(\w+)"/g)].map((x) => x[1]);
  }
  const m = sql.match(/UPDATE\s+"?\w+"?\."?\w+"?\s+SET\s+([\s\S]*?)\s+WHERE/i);
  return [...(m?.[1] ?? "").matchAll(/"(\w+)"\s*=/g)].map((x) => x[1]);
}

async function main() {
  const OWNER_URL = process.env.DIRECT_URL;
  if (!OWNER_URL) throw new Error("DIRECT_URL missing");
  if (!/localhost|127\.0\.0\.1/.test(OWNER_URL)) {
    throw new Error("DENY: this battery runs only against a local lab");
  }
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  console.log("[battery] PR2 — persistent login privilege rehearsal");

  // ── phase 1: the Production role topology ─────────────────────────────────
  console.log("--- phase 1: roles and the shipped contract ---");
  for (const stmt of [
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_auth') THEN CREATE ROLE app_auth NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime NOLOGIN; END IF; END $$`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${AUTH_ROLE}') THEN CREATE ROLE ${AUTH_ROLE} LOGIN PASSWORD '${AUTH_PW}' IN ROLE app_auth; END IF; END $$`,
    `GRANT USAGE ON SCHEMA public TO app_auth, app_runtime`,
    // The pre-state Production actually had: the default ACL hands the tenant
    // runtime everything, and the auth plane starts from a broad grant. Both
    // shipped migrations then narrow from here, exactly as they did live.
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business", public."AuthSession", public."AuthSessionSecret" TO app_auth`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON public."User", public."Business", public."AuthSession", public."AuthSessionSecret" TO app_runtime`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_auth, app_runtime`,
  ]) {
    await owner.$executeRawUnsafe(stmt);
  }

  // Apply the SHIPPED migrations verbatim.
  for (const file of [E4, SESSION_CONTRACT]) {
    for (const stmt of splitSqlStatements(readFileSync(file, "utf8"))) {
      await owner.$executeRawUnsafe(stmt);
    }
    ok(`shipped migration applied: ${file.split("/")[2]}`, true);
  }

  const posture = (await owner.$queryRawUnsafe<
    { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
  >(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='${AUTH_ROLE}'`))[0];
  ok(
    "lab auth role: LOGIN, NOSUPERUSER, NOBYPASSRLS, inherits app_auth",
    posture.rolcanlogin && !posture.rolsuper && !posture.rolbypassrls,
    JSON.stringify(posture)
  );

  const AUTH_URL = roleUrl(OWNER_URL, AUTH_ROLE, AUTH_PW);
  process.env.AUTH_DATABASE_URL = AUTH_URL;
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.DATABASE_URL = AUTH_URL;

  // The tenant plane must hold NOTHING on these two tables. This is the property
  // that makes the flag-loss fallback loud rather than silent.
  for (const t of ["AuthSession", "AuthSessionSecret"]) {
    const r = (await owner.$queryRawUnsafe<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>(
      `SELECT has_table_privilege('app_runtime','public."${t}"','SELECT') AS s,
              has_table_privilege('app_runtime','public."${t}"','INSERT') AS i,
              has_table_privilege('app_runtime','public."${t}"','UPDATE') AS u,
              has_table_privilege('app_runtime','public."${t}"','DELETE') AS d`
    ))[0];
    ok(`tenant plane holds ZERO on ${t}`, !r.s && !r.i && !r.u && !r.d, JSON.stringify(r));
  }

  // ── phase 2: real modules, on the restricted identity ─────────────────────
  const { issueRefreshSession, refreshAccessToken, endRefreshSession } = await import(
    "@/lib/auth/refresh-session.service"
  );
  const { parseRefreshCookie, sha256Hex } = await import("@/lib/auth/refresh-session");

  console.log("--- phase 2: fixtures ---");
  const cleanup = async () => {
    await owner.$executeRawUnsafe(
      `DELETE FROM "AuthSession" WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE '%@pr2.test')`
    );
    await owner.$executeRawUnsafe(`DELETE FROM "User" WHERE email LIKE '%@pr2.test'`);
    await owner.$executeRawUnsafe(`DELETE FROM "Business" WHERE name LIKE '${MARK}%'`);
  };
  await cleanup();

  const biz = await owner.business.create({ data: { name: `${MARK}A` }, select: { id: true } });
  const user = await owner.user.create({
    data: { email: `a@pr2.test`, password: "x", businessId: biz.id, tokenVersion: 2 },
    select: { id: true, tokenVersion: true },
  });

  // ── phase 3: the SQL the REAL store emits ─────────────────────────────────
  //
  // NOT a repeat of .authfix/auth-session-orm-battery.ts. That one proves the
  // ORM's behaviour with statements written by hand — that an explicit `select`
  // narrows RETURNING, that an INSERT names only granted columns, that no
  // `updatedAt` is smuggled in. Those are properties of the MODELS.
  //
  // This asks the question one layer up, and it is the question the 2026-09-08
  // outage turned out to hinge on: what does the SHIPPING CODE actually send?
  // Every statement below comes from calling the real store functions, so a
  // `select` dropped from a real call site is caught here even though the model
  // is unchanged and the ORM battery still passes.
  console.log("--- phase 3: SQL emitted by the real store ---");
  const captured: string[] = [];
  const probe = new PrismaClient({
    datasourceUrl: AUTH_URL,
    log: [{ emit: "event", level: "query" }],
  });
  // @ts-expect-error the event overload is not in the generated union
  probe.$on("query", (e: { query: string }) => captured.push(e.query));

  {
    // The real store, driven with a capturing client. Every function the refresh
    // and logout paths reach is exercised.
    const store = await import("@/lib/auth/refresh-session.store");
    const t0 = new Date();
    const s = await store.createSession(
      {
        userId: user.id,
        secretHash: sha256Hex("phase3-current"),
        tokenVersionAtIssue: user.tokenVersion,
        createdAt: t0,
        lastUsedAt: t0,
        idleExpiresAt: new Date(t0.getTime() + 60_000),
        absoluteExpiresAt: new Date(t0.getTime() + 120_000),
      },
      probe
    );
    await store.loadSessionBySelector(s.id, probe);
    await store.loadUserForRefresh(user.id, probe);
    await store.loadRotatedSecret(s.id, sha256Hex("nothing"), probe);
    await store.rotateSession({
      sessionId: s.id,
      outgoingSecretHash: sha256Hex("phase3-current"),
      newSecretHash: sha256Hex("phase3-next"),
      now: t0,
      graceUntil: new Date(t0.getTime() + 120_000),
      idleExpiresAt: new Date(t0.getTime() + 60_000),
    }, probe);
    await store.evictHistoryOverCap(s.id, probe);
    await store.revokeSession(s.id, "phase3", t0, probe);
    await store.sweepExpiredSessions(user.id, new Date(t0.getTime() + 300_000), probe);
    await store.deleteSession(s.id, probe);
  }
  await probe.$disconnect();

  const sessionInsert = captured.find((s) => /INSERT INTO[^(]*"AuthSession"/i.test(s)) ?? "";
  const secretInsert = captured.find((s) => /INSERT INTO[^(]*"AuthSessionSecret"/i.test(s)) ?? "";
  const rotateUpdate = captured.find((s) => /UPDATE[^;]*"AuthSession"[\s\S]*"secretHash"\s*=/i.test(s)) ?? "";
  const revokeUpdate = captured.find((s) => /UPDATE[^;]*"AuthSession"[\s\S]*"revokedAt"\s*=/i.test(s)) ?? "";
  const deletes = captured.filter((s) => /^DELETE FROM/i.test(s.trim()));
  ok(
    "captured every write the real store issues",
    Boolean(sessionInsert && secretInsert && rotateUpdate && revokeUpdate) && deletes.length >= 2,
    `insert=${!!sessionInsert} secret=${!!secretInsert} rotate=${!!rotateUpdate} revoke=${!!revokeUpdate} deletes=${deletes.length}`
  );

  const insSession = grantedColumns(SESSION_CONTRACT, "INSERT", "AuthSession");
  const insSecret = grantedColumns(SESSION_CONTRACT, "INSERT", "AuthSessionSecret");
  const updSession = grantedColumns(SESSION_CONTRACT, "UPDATE", "AuthSession");

  const shortfall = (emitted: string[], granted: Set<string>) =>
    emitted.filter((c) => !granted.has(c)).sort();

  ok(
    "AUTHSESSION INSERT: the real create names only granted columns",
    shortfall(columnsOf(sessionInsert, "INSERT"), insSession).length === 0,
    `ungranted: ${shortfall(columnsOf(sessionInsert, "INSERT"), insSession).join(", ")} | emitted: ${columnsOf(sessionInsert, "INSERT").join(",")}`
  );
  ok(
    "AUTHSESSIONSECRET OPERATIONS: the real rotation record names only granted columns",
    shortfall(columnsOf(secretInsert, "INSERT"), insSecret).length === 0,
    `ungranted: ${shortfall(columnsOf(secretInsert, "INSERT"), insSecret).join(", ")}`
  );
  ok(
    "AUTHSESSION UPDATE: the real rotation writes only granted columns",
    shortfall(columnsOf(rotateUpdate, "UPDATE"), updSession).length === 0,
    `ungranted: ${shortfall(columnsOf(rotateUpdate, "UPDATE"), updSession).join(", ")}`
  );
  ok(
    "AUTHSESSION REVOCATION: the real revoke writes only granted columns",
    shortfall(columnsOf(revokeUpdate, "UPDATE"), updSession).length === 0,
    `ungranted: ${shortfall(columnsOf(revokeUpdate, "UPDATE"), updSession).join(", ")}`
  );

  // No write anywhere in the real store may reach a withheld column. Checked
  // across EVERY captured UPDATE rather than the two named above, so a third
  // update added later cannot slip past by not being on the list.
  const everyUpdatedColumn = new Set(
    captured.filter((s) => /^UPDATE/i.test(s.trim())).flatMap((s) => columnsOf(s, "UPDATE"))
  );
  for (const withheld of ["absoluteExpiresAt", "tokenVersionAtIssue", "userId"]) {
    ok(
      `WITHHELD COLUMN: nothing in the real store writes ${withheld}`,
      !everyUpdatedColumn.has(withheld) && !updSession.has(withheld)
    );
  }
  ok(
    "no UPDATE is granted on AuthSessionSecret at any level",
    grantedColumns(SESSION_CONTRACT, "UPDATE", "AuthSessionSecret").size === 0 &&
      !grantsTableLevel(SESSION_CONTRACT, "UPDATE", "AuthSessionSecret")
  );
  ok(
    "UNEXPECTED BROAD READ/WRITE: the store touches only the two session tables and User",
    captured
      .filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.trim()))
      .every((s) => /"(AuthSession|AuthSessionSecret)"/.test(s)),
    captured.filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.trim())).find((s) => !/"(AuthSession|AuthSessionSecret)"/.test(s)) ?? ""
  );
  await owner.authSession.deleteMany({ where: { userId: user.id } });

  // ── phase 4: the REAL service, end to end, on the restricted identity ─────
  console.log("--- phase 4: real issue / refresh / logout ---");
  const issued = await issueRefreshSession(user.id, user.tokenVersion);
  ok("issueRefreshSession succeeds under the shipped grants", issued !== null);
  const cookie = issued!.cookieValue;
  const first = parseRefreshCookie(cookie)!;

  const r1 = await refreshAccessToken(cookie);
  ok("a current secret refreshes and mints a token", r1.ok && r1.token.length > 0, JSON.stringify(r1));
  const rotatedCookie = r1.ok ? r1.cookieValue : "";
  ok(
    "rotation issues a DIFFERENT secret on the SAME selector",
    rotatedCookie !== cookie && parseRefreshCookie(rotatedCookie)?.sessionId === first.sessionId
  );

  // Grace: the ORIGINAL cookie is now an outgoing secret, still inside 120s.
  const r2 = await refreshAccessToken(cookie);
  ok("the outgoing secret is accepted inside its grace window", r2.ok, JSON.stringify(r2));

  // Unknown secret: same selector, a secret nobody issued. MUST NOT revoke.
  const forged = `${first.sessionId}.${"z".repeat(43)}`;
  const r3 = await refreshAccessToken(forged);
  ok("an unknown secret is refused", !r3.ok && r3.reason === "unknown_secret", JSON.stringify(r3));
  const stillAlive = await owner.authSession.findUnique({
    where: { id: first.sessionId },
    select: { revokedAt: true },
  });
  ok(
    "an unknown secret did NOT revoke the session (selector is not a kill switch)",
    stillAlive?.revokedAt === null,
    `revokedAt=${stillAlive?.revokedAt}`
  );

  // Divergence: force an outgoing secret past its grace, with later use.
  const past = new Date(Date.now() - 10 * 60_000);
  await owner.authSessionSecret.updateMany({
    where: { sessionId: first.sessionId },
    data: { graceUntil: past },
  });
  await owner.authSession.updateMany({
    where: { id: first.sessionId },
    data: { lastUsedAt: new Date() },
  });
  const r4 = await refreshAccessToken(cookie);
  ok(
    "a rotated secret past grace, on a session used since, is chain divergence",
    !r4.ok && r4.reason === "refresh_chain_divergence",
    JSON.stringify(r4)
  );
  const revoked = await owner.authSession.findUnique({
    where: { id: first.sessionId },
    select: { revokedAt: true, revokedReason: true },
  });
  ok(
    "the divergent session is revoked, with the mandated wording",
    revoked?.revokedAt !== null && revoked?.revokedReason === "refresh_chain_divergence",
    JSON.stringify(revoked)
  );
  const r5 = await refreshAccessToken(rotatedCookie);
  ok("a revoked session cannot refresh again", !r5.ok, JSON.stringify(r5));

  // Global logout reaches a session it never saw.
  const s2 = await issueRefreshSession(user.id, user.tokenVersion);
  await owner.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } }, select: { id: true } });
  const r6 = await refreshAccessToken(s2!.cookieValue);
  ok(
    "a tokenVersion bump invalidates an existing session",
    !r6.ok && r6.reason === "token_version_stale",
    JSON.stringify(r6)
  );

  // The account-deletion quarantine.
  const u2 = await owner.user.findUnique({ where: { id: user.id }, select: { tokenVersion: true } });
  const s3 = await issueRefreshSession(user.id, u2!.tokenVersion);
  await owner.business.update({
    where: { id: biz.id },
    data: { deletionRequestedAt: new Date() },
    select: { id: true },
  });
  const r7 = await refreshAccessToken(s3!.cookieValue);
  ok(
    "a quarantined business cannot mint a new access token",
    !r7.ok && r7.reason === "account_quarantined",
    JSON.stringify(r7)
  );
  await owner.business.update({
    where: { id: biz.id },
    data: { deletionRequestedAt: null },
    select: { id: true },
  });

  // Expiry.
  const u3 = await owner.user.findUnique({ where: { id: user.id }, select: { tokenVersion: true } });
  const s4 = await issueRefreshSession(user.id, u3!.tokenVersion);
  const sel4 = parseRefreshCookie(s4!.cookieValue)!;
  await owner.authSession.updateMany({
    where: { id: sel4.sessionId },
    data: { idleExpiresAt: new Date(Date.now() - 1000) },
  });
  const r8 = await refreshAccessToken(s4!.cookieValue);
  ok("an idle-expired session is refused", !r8.ok && r8.reason === "idle_expired", JSON.stringify(r8));

  // Logout removes the row.
  const u4 = await owner.user.findUnique({ where: { id: user.id }, select: { tokenVersion: true } });
  const s5 = await issueRefreshSession(user.id, u4!.tokenVersion);
  const sel5 = parseRefreshCookie(s5!.cookieValue)!;
  await endRefreshSession(s5!.cookieValue);
  ok(
    "logout deletes the session row",
    (await owner.authSession.count({ where: { id: sel5.sessionId } })) === 0
  );

  // ── phase 5: NEGATIVE CONTROLS ────────────────────────────────────────────
  console.log("--- phase 5: negative controls ---");
  const auth = new PrismaClient({ datasourceUrl: AUTH_URL });

  // 1. The 2026-09-08 defect itself, on a table it still applies to.
  let code: string | null = null;
  try {
    await auth.user.update({ where: { id: user.id }, data: { loginCount: { increment: 1 } } });
  } catch (e) {
    code = pgCode(e);
  }
  ok(
    "NEGATIVE CONTROL: a User update with no select is still refused (42501)",
    code === "42501",
    `got ${code ?? "no error"} — if this passes, the lab no longer reproduces Production`
  );

  // 2. The withheld columns are refused in practice, not merely absent on paper.
  const s6 = await issueRefreshSession(user.id, u4!.tokenVersion);
  const sel6 = parseRefreshCookie(s6!.cookieValue)!;
  for (const [label, data] of [
    ["absoluteExpiresAt", { absoluteExpiresAt: new Date(Date.now() + 9e10) }],
    ["tokenVersionAtIssue", { tokenVersionAtIssue: 0 }],
    ["userId", { userId: user.id }],
  ] as const) {
    let c: string | null = null;
    try {
      await auth.authSession.updateMany({ where: { id: sel6.sessionId }, data });
    } catch (e) {
      c = pgCode(e);
    }
    ok(`NEGATIVE CONTROL: the auth plane cannot UPDATE ${label} (42501)`, c === "42501", `got ${c}`);
  }

  // 3. A rotation record's deadline cannot be widened after the fact.
  let c3: string | null = null;
  try {
    await auth.authSessionSecret.updateMany({ where: { sessionId: sel6.sessionId }, data: { graceUntil: new Date(Date.now() + 9e10) } });
  } catch (e) {
    c3 = pgCode(e);
  }
  ok("NEGATIVE CONTROL: graceUntil is unforgeable after the fact (42501)", c3 === "42501", `got ${c3}`);
  await auth.$disconnect();

  // ── residue ───────────────────────────────────────────────────────────────
  await cleanup();
  const residue = Number(
    (await owner.$queryRawUnsafe<{ c: number }[]>(
      `SELECT (SELECT count(*)::int FROM "Business" WHERE name LIKE '${MARK}%')
            + (SELECT count(*)::int FROM "User" WHERE email LIKE '%@pr2.test') AS c`
    ))[0].c
  );
  ok("synthetic residue = 0", residue === 0, `found ${residue}`);

  await owner.$disconnect();
  console.log(`\n[battery] PR2 PASS=${pass} FAIL=${fail}`);
  if (fail > 0) {
    console.log("FAILURES:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ALL CHECKS PASS");
}

main().catch((e) => {
  console.error("[battery] FATAL:", e);
  process.exit(1);
});
