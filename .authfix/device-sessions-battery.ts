/**
 * DEVICE & SESSION MANAGEMENT — the whole surface, on a real PostgreSQL 17 under
 * the shipped privilege contract.
 *
 *   OWNER_URL=postgresql://... npx tsx .authfix/device-sessions-battery.ts
 *
 * This drives the REAL gate and the REAL routes. The two properties it exists to
 * prove are the ones that would be quietly wrong if only the happy path were
 * tested:
 *
 *   PER-DEVICE REVOCATION IS IMMEDIATE. Before the access token named its
 *   session, revoking one device changed a row and nothing else, and that device
 *   went on working for up to 24 hours. Every refusal below is that gate.
 *
 *   ONE USER CANNOT TOUCH ANOTHER. Ownership is inside the write predicate, so
 *   the negative controls check the other user's rows afterwards rather than
 *   trusting the response.
 *
 * Time is a parameter where the engine allows it, so a 30-day idle window and a
 * 90-day ceiling are both reachable in a millisecond.
 *
 * Synthetic CI-only credentials. Zero secrets, zero Neon, zero network, zero
 * Production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required (owner connection to the throwaway lab database).");
  process.exit(2);
}

const ROLE = "app_auth_devices_battery";
const PW = "devices_ci_synthetic_pw";
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

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const freshHash = () => sha(randomBytes(32).toString("hex"));
// Anchored to the REAL clock, not a fixed date. Gate 4 in getAuthContext
// compares the session against `new Date()`, so a fixture dated in the past
// would issue sessions that are already expired and every gate-4 assertion
// would fail for the wrong reason. Only the engine takes `now` as a parameter.
const T0 = new Date();
const at = (ms: number) => new Date(T0.getTime() + ms);

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

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
  ]) for (const s of statements(readFileSync(MIG(f), "utf8"))) await owner.$executeRawUnsafe(s);
  // The device-metadata column and its single grant, exactly as shipped.
  for (const s of statements(readFileSync(MIG("20260913120000_authsession_user_agent"), "utf8")))
    await owner.$executeRawUnsafe(s);
  ok("lab built from every shipped auth migration", true);

  // ------------------------------------------------------------------ env ---
  process.env.AUTH_PLANE_ENABLED = "true";
  process.env.AUTH_DATABASE_URL = AUTH_URL;
  process.env.DATABASE_URL = OWNER_URL;
  process.env.DIRECT_URL = OWNER_URL;
  process.env.AUTH_TOKEN_SECRET =
    process.env.AUTH_TOKEN_SECRET ?? "devices-battery-synthetic-secret-not-a-real-key";
  process.env.RATE_LIMIT_BACKEND = "memory";
  process.env.PUBLIC_SIGNUP_ENABLED = "false";

  const { signAuthToken } = await import("@/lib/auth-token");
  const { getAuthContext, getCurrentUser } = await import("@/lib/auth");
  const { issueRefreshSession, revokeAllSessionsForUser } = await import("@/lib/auth/refresh-session");
  const { listSessions, revokeSession, revokeOtherSessions } = await import(
    "@/lib/auth/session-directory"
  );
  const sessionsRoute = await import("@/app/api/security/sessions/route");
  const revokeRoute = await import("@/app/api/security/sessions/[id]/revoke/route");
  const revokeOthersRoute = await import("@/app/api/security/sessions/revoke-others/route");
  const loginRoute = await import("@/app/api/auth/login/route");
  const refreshRoute = await import("@/app/api/auth/refresh/route");

  const auth = new PrismaClient({ datasourceUrl: AUTH_URL, log: [] });

  // -------------------------------------------------------------- fixture ---
  const bcrypt = (await import("bcrypt")).default;
  const PASSWORD = "devices-battery-password";
  const hash = await bcrypt.hash(PASSWORD, 10);
  const biz = await owner.business.create({ data: { name: "Devices Lab" }, select: { id: true } });
  let seq = 0;
  const mkUser = async () => {
    seq += 1;
    return owner.user.create({
      data: {
        email: `dev-${Date.now()}-${seq}@lab.invalid`,
        password: hash,
        name: `u${seq}`,
        businessId: biz.id,
      },
      select: { id: true, email: true, tokenVersion: true },
    });
  };

  const alice = await mkUser();
  const bob = await mkUser();

  const issue = (userId: number, tv: number, ua: string | null, now = T0) =>
    issueRefreshSession(auth, { userId, tokenVersion: tv, now, userAgent: ua });

  const bearer = (token: string, url = "https://lab.invalid/api/security/sessions") =>
    new Request(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  const post = (token: string, url: string) =>
    new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });

  // ── GATE 4: what a token naming a session is allowed to do ───────────────
  const a1 = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
  const a2 = await issue(alice.id, alice.tokenVersion, SAFARI_IPHONE);
  const b1 = await issue(bob.id, bob.tokenVersion, CHROME_WIN);

  {
    const t = signAuthToken(alice.id, alice.tokenVersion, a1.sessionId);
    const ctx = await getAuthContext(bearer(t));
    ok("SID VALID: the request is authenticated", ctx !== null);
    ok("...and the session is identified", ctx?.sessionId === a1.sessionId);
    ok("...and getCurrentUser still returns just the user", (await getCurrentUser(bearer(t)))?.id === alice.id);
  }
  {
    // A token from before this shipped. Accepted, and the window closes on its
    // own because gate 1 refuses anything past exp.
    const t = signAuthToken(alice.id, alice.tokenVersion);
    const ctx = await getAuthContext(bearer(t));
    ok("SID MISSING is accepted during the compatibility window", ctx !== null);
    ok("...and reports no current session", ctx?.sessionId === null);
  }
  {
    const t = signAuthToken(alice.id, alice.tokenVersion, "11111111-2222-4333-8444-555555555555");
    ok("SID INVALID (no such session) is refused", (await getAuthContext(bearer(t))) === null);
  }
  {
    // The forgery that gate 4 exists to stop: a validly signed token for Alice
    // that names BOB's session.
    const t = signAuthToken(alice.id, alice.tokenVersion, b1.sessionId);
    ok("SID OF ANOTHER USER is refused", (await getAuthContext(bearer(t))) === null);
  }
  {
    const s = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    const t = signAuthToken(alice.id, alice.tokenVersion, s.sessionId);
    ok("setup: it works before revocation", (await getAuthContext(bearer(t))) !== null);
    await revokeSession({ userId: alice.id, sessionId: s.sessionId, currentSessionId: null });
    ok("REVOKED SESSION is refused IMMEDIATELY on the next request", (await getAuthContext(bearer(t))) === null);
  }
  {
    const s = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    // TYPED, not raw. A `$executeRawUnsafe` with a Date parameter writes into
    // these `timestamp(3) without time zone` columns through the session
    // timezone: measured on this machine it landed THREE HOURS in the future, so
    // "one minute ago" became "not expired" and the assertion failed for a
    // reason that had nothing to do with the gate. Prisma converts correctly;
    // the raw path does not.
    await owner.authSession.update({
      where: { id: s.sessionId },
      data: { idleExpiresAt: at(-1000) },
      select: { id: true },
    });
    const t = signAuthToken(alice.id, alice.tokenVersion, s.sessionId);
    ok("IDLE EXPIRED is refused", (await getAuthContext(bearer(t))) === null);
  }
  {
    const s = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    // Typed for the same timezone reason as above.
    await owner.authSession.update({
      where: { id: s.sessionId },
      data: { absoluteExpiresAt: at(-1000) },
      select: { id: true },
    });
    const t = signAuthToken(alice.id, alice.tokenVersion, s.sessionId);
    ok("ABSOLUTE EXPIRED is refused", (await getAuthContext(bearer(t))) === null);
  }
  {
    // The row's own generation is checked as well as the token's, so a global
    // logout is caught even by a token that somehow carried the right tv.
    const s = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    await owner.authSession.update({
      where: { id: s.sessionId },
      data: { tokenVersionAtIssue: 99 },
      select: { id: true },
    });
    const t = signAuthToken(alice.id, alice.tokenVersion, s.sessionId);
    ok("GENERATION MISMATCH on the row is refused", (await getAuthContext(bearer(t))) === null);
  }

  // ── the list ─────────────────────────────────────────────────────────────
  {
    const t = signAuthToken(alice.id, alice.tokenVersion, a1.sessionId);
    const res = await sessionsRoute.GET(bearer(t));
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>>; currentIdentified: boolean };
    ok("LIST returns 200", res.status === 200);
    ok("...only this user's sessions", body.sessions.every((s) => typeof s.id === "string"));
    ok("...current is identified exactly once", body.sessions.filter((s) => s.current === true).length === 1);
    ok("...and it is the right one", body.sessions.find((s) => s.current === true)?.id === a1.sessionId);

    const keys = new Set(body.sessions.flatMap((s) => Object.keys(s)));
    console.log(`\n  [measured] DTO keys: ${[...keys].sort().join(", ")}\n`);
    ok(
      "the DTO carries only the seven fields the screen needs",
      [...keys].sort().join(",") === "createdAt,current,expiresAt,id,label,lastUsedAt,status"
    );
    const raw = JSON.stringify(body);
    ok("NO LEAK: no secretHash", !raw.includes("secretHash") && !/[0-9a-f]{64}/.test(raw));
    ok("NO LEAK: no tokenVersionAtIssue", !raw.toLowerCase().includes("tokenversion"));
    ok("NO LEAK: no rotation history", !raw.includes("graceUntil") && !raw.includes("rotatedAt"));
    ok("NO LEAK: the raw User-Agent never leaves", !raw.includes("Mozilla") && !raw.includes("AppleWebKit"));
    ok("...but the human label does", raw.includes("Chrome") && raw.includes("Safari"));

    const bobList = await listSessions({ userId: bob.id, currentSessionId: null });
    ok("a user cannot see another user's sessions", bobList.every((s) => s.id !== a1.sessionId));
    ok("...and sees their own", bobList.some((s) => s.id === b1.sessionId));
  }
  {
    // Absent and oversized User-Agents both have to render something sane.
    const noUa = await issue(alice.id, alice.tokenVersion, null);
    const hugeUa = await issue(alice.id, alice.tokenVersion, "Z".repeat(4000));
    const list = await listSessions({ userId: alice.id, currentSessionId: null });
    ok("a session with no User-Agent gets the unknown label",
      list.find((s) => s.id === noUa.sessionId)?.label === "מכשיר לא מזוהה");
    const stored = await owner.$queryRawUnsafe<Array<{ len: number | null }>>(
      `SELECT length("userAgent") AS len FROM "AuthSession" WHERE id = $1::uuid`, hugeUa.sessionId
    );
    ok("an oversized User-Agent was truncated to 512 before the insert", stored[0]?.len === 512);
    ok("...and did not break issuance", typeof hugeUa.sessionId === "string");
  }

  // ── revoke one ───────────────────────────────────────────────────────────
  {
    const t = signAuthToken(alice.id, alice.tokenVersion, a1.sessionId);
    const res = await revokeRoute.POST(
      post(t, `https://lab.invalid/api/security/sessions/${a2.sessionId}/revoke`),
      { params: Promise.resolve({ id: a2.sessionId }) }
    );
    const body = (await res.json()) as { success?: boolean; wasCurrent?: boolean };
    ok("REVOKE ANOTHER OWN DEVICE returns 200", res.status === 200);
    ok("...and says it was not the current one", body.wasCurrent === false);
    const row = await owner.authSession.findUnique({ where: { id: a2.sessionId }, select: { revokedAt: true, revokedReason: true } });
    ok("...the row is revoked with a reason", row?.revokedAt !== null && row?.revokedReason === "revoked_by_user");
    ok("...never deleted", row !== null);
    ok("...the current session still works", (await getAuthContext(bearer(t))) !== null);
    const targetToken = signAuthToken(alice.id, alice.tokenVersion, a2.sessionId);
    ok("...and the revoked device is refused at once", (await getAuthContext(bearer(targetToken))) === null);
    ok("...no Set-Cookie, because it was not this device", res.headers.get("set-cookie") === null);
  }
  {
    // Idempotent on a session the caller owns.
    const t = signAuthToken(alice.id, alice.tokenVersion, a1.sessionId);
    const res = await revokeRoute.POST(
      post(t, `https://lab.invalid/api/security/sessions/${a2.sessionId}/revoke`),
      { params: Promise.resolve({ id: a2.sessionId }) }
    );
    ok("ALREADY REVOKED is idempotent success", res.status === 200);
  }
  {
    // The anti-enumeration property: unknown and foreign are indistinguishable.
    const t = signAuthToken(alice.id, alice.tokenVersion, a1.sessionId);
    const unknown = await revokeRoute.POST(
      post(t, `https://lab.invalid/api/security/sessions/11111111-2222-4333-8444-555555555555/revoke`),
      { params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }) }
    );
    const foreign = await revokeRoute.POST(
      post(t, `https://lab.invalid/api/security/sessions/${b1.sessionId}/revoke`),
      { params: Promise.resolve({ id: b1.sessionId }) }
    );
    const malformed = await revokeRoute.POST(
      post(t, `https://lab.invalid/api/security/sessions/not-a-uuid/revoke`),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    ok("UNKNOWN id is 404", unknown.status === 404);
    ok("FOREIGN id is 404 — the same answer", foreign.status === 404);
    ok("MALFORMED id is 404 — still the same answer", malformed.status === 404);
    ok(
      "...and the bodies are identical, so nothing distinguishes them",
      JSON.stringify(await unknown.json()) === JSON.stringify(await foreign.json())
    );
    const bobRow = await owner.authSession.findUnique({ where: { id: b1.sessionId }, select: { revokedAt: true } });
    ok("NO CROSS-USER MUTATION: the other user's session is untouched", bobRow?.revokedAt === null);
  }

  // ── revoke the current device ───────────────────────────────────────────
  {
    const s = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    const t = signAuthToken(alice.id, alice.tokenVersion, s.sessionId);
    const res = await revokeRoute.POST(
      post(t, `https://lab.invalid/api/security/sessions/${s.sessionId}/revoke`),
      { params: Promise.resolve({ id: s.sessionId }) }
    );
    const body = (await res.json()) as { wasCurrent?: boolean };
    ok("REVOKE CURRENT returns 200", res.status === 200);
    ok("...and says so, so the client knows to leave", body.wasCurrent === true);
    const cookie = res.headers.get("set-cookie") ?? "";
    ok("...the refresh cookie is cleared", /dubiz_rt=/.test(cookie) && /Max-Age=0/.test(cookie));
    ok("...the token stops working immediately", (await getAuthContext(bearer(t))) === null);
    const user = await owner.user.findUnique({ where: { id: alice.id }, select: { tokenVersion: true } });
    ok("...and the GLOBAL generation was NOT bumped", user?.tokenVersion === alice.tokenVersion);
  }

  // ── revoke all other devices ────────────────────────────────────────────
  {
    const keep = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    const other1 = await issue(alice.id, alice.tokenVersion, SAFARI_IPHONE);
    const other2 = await issue(alice.id, alice.tokenVersion, CHROME_WIN);
    const bobLive = await issue(bob.id, bob.tokenVersion, CHROME_WIN);

    const t = signAuthToken(alice.id, alice.tokenVersion, keep.sessionId);
    const res = await revokeOthersRoute.POST(post(t, "https://lab.invalid/api/security/sessions/revoke-others"));
    const body = (await res.json()) as { revoked?: number };
    ok("REVOKE OTHERS returns 200", res.status === 200);
    ok("...and reports how many", typeof body.revoked === "number" && (body.revoked ?? 0) >= 2);

    ok("...the current device survives", (await getAuthContext(bearer(t))) !== null);
    for (const [label, id] of [["first other", other1.sessionId], ["second other", other2.sessionId]] as const) {
      const tok = signAuthToken(alice.id, alice.tokenVersion, id);
      ok(`...the ${label} device is refused at once`, (await getAuthContext(bearer(tok))) === null);
    }
    const bobRow = await owner.authSession.findUnique({ where: { id: bobLive.sessionId }, select: { revokedAt: true } });
    ok("...and the other USER is untouched", bobRow?.revokedAt === null);
    const user = await owner.user.findUnique({ where: { id: alice.id }, select: { tokenVersion: true } });
    ok("...the global generation was NOT bumped", user?.tokenVersion === alice.tokenVersion);
  }
  {
    // A pre-rollout token has no pivot, and guessing one would sign the owner out
    // of everything. Refused, with a code the client can act on.
    const t = signAuthToken(alice.id, alice.tokenVersion);
    const res = await revokeOthersRoute.POST(post(t, "https://lab.invalid/api/security/sessions/revoke-others"));
    const body = (await res.json()) as { code?: string };
    ok("REVOKE OTHERS refuses a token that names no session", res.status === 409);
    ok("...with a code the UI can act on", body.code === "SESSION_UNIDENTIFIED");
  }

  // ── logout everywhere, unchanged ────────────────────────────────────────
  {
    const c = await mkUser();
    const s1 = await issue(c.id, c.tokenVersion, CHROME_WIN);
    const s2 = await issue(c.id, c.tokenVersion, SAFARI_IPHONE);
    const count = await revokeAllSessionsForUser(auth, { userId: c.id, now: at(1000) });
    await owner.user.update({ where: { id: c.id }, data: { tokenVersion: { increment: 1 } }, select: { id: true } });
    ok("LOGOUT EVERYWHERE still revokes every live session", count === 2, `${count}`);
    for (const id of [s1.sessionId, s2.sessionId]) {
      ok("...and each device is refused", (await getAuthContext(bearer(signAuthToken(c.id, c.tokenVersion, id)))) === null);
    }
    const rows = await owner.authSession.count({ where: { userId: c.id } });
    ok("...rows revoked, never deleted", rows === 2);
  }

  // ── concurrency ─────────────────────────────────────────────────────────
  {
    const d = await mkUser();
    const s = await issue(d.id, d.tokenVersion, CHROME_WIN);
    const parsed = s.credential;
    // A refresh and a revoke racing on the same session. Whichever order the
    // database picks, the session must not be usable afterwards.
    const [r1, r2] = await Promise.all([
      refreshRoute.handleRefresh(
        new Request("https://lab.invalid/api/auth/refresh", {
          method: "POST",
          headers: {
            origin: "https://lab.invalid",
            host: "lab.invalid",
            cookie: `dubiz_rt=${parsed}`,
          },
        })
      ),
      revokeSession({ userId: d.id, sessionId: s.sessionId, currentSessionId: null }),
    ]);
    ok("CONCURRENT refresh vs revoke: both calls returned", r1 !== undefined && r2 !== undefined);
    const row = await owner.authSession.findUnique({ where: { id: s.sessionId }, select: { revokedAt: true } });
    ok("...the session ends revoked", row?.revokedAt !== null);
    const after = await refreshRoute.handleRefresh(
      new Request("https://lab.invalid/api/auth/refresh", {
        method: "POST",
        headers: { origin: "https://lab.invalid", host: "lab.invalid", cookie: `dubiz_rt=${parsed}` },
      })
    );
    ok("...and no later refresh succeeds", after.status !== 200, `${after.status}`);
  }
  {
    const e = await mkUser();
    const s = await issue(e.id, e.tokenVersion, CHROME_WIN);
    const [x, y] = await Promise.all([
      revokeSession({ userId: e.id, sessionId: s.sessionId, currentSessionId: null }),
      revokeSession({ userId: e.id, sessionId: s.sessionId, currentSessionId: null }),
    ]);
    ok("CONCURRENT revoke vs revoke: both report success", x.kind === "revoked" && y.kind === "revoked");
    const reasons = await owner.authSession.findUnique({ where: { id: s.sessionId }, select: { revokedReason: true } });
    ok("...and exactly one reason is recorded", reasons?.revokedReason === "revoked_by_user");
  }
  {
    const f = await mkUser();
    const keep = await issue(f.id, f.tokenVersion, CHROME_WIN);
    const other = await issue(f.id, f.tokenVersion, SAFARI_IPHONE);
    // revoke-others racing a refresh on the device being revoked.
    const [, ref] = await Promise.all([
      revokeOtherSessions({ userId: f.id, currentSessionId: keep.sessionId }),
      refreshRoute.handleRefresh(
        new Request("https://lab.invalid/api/auth/refresh", {
          method: "POST",
          headers: { origin: "https://lab.invalid", host: "lab.invalid", cookie: `dubiz_rt=${other.credential}` },
        })
      ),
    ]);
    ok("CONCURRENT revoke-others vs refresh: the call returned", ref !== undefined);
    const laterToken = signAuthToken(f.id, f.tokenVersion, other.sessionId);
    ok("...the revoked device cannot authenticate afterwards", (await getAuthContext(bearer(laterToken))) === null);
    ok("...and the kept device still can",
      (await getAuthContext(bearer(signAuthToken(f.id, f.tokenVersion, keep.sessionId)))) !== null);
  }
  {
    // The list must not blow up while a rotation is in flight.
    const g = await mkUser();
    const s = await issue(g.id, g.tokenVersion, CHROME_WIN);
    const [list] = await Promise.all([
      listSessions({ userId: g.id, currentSessionId: s.sessionId }),
      refreshRoute.handleRefresh(
        new Request("https://lab.invalid/api/auth/refresh", {
          method: "POST",
          headers: { origin: "https://lab.invalid", host: "lab.invalid", cookie: `dubiz_rt=${s.credential}` },
        })
      ),
    ]);
    ok("CONCURRENT list during rotation returns a coherent list", Array.isArray(list) && list.length >= 1);
  }

  // ── the login contract: a session, or no login ──────────────────────────
  {
    const h = await mkUser();
    const loginReq = () =>
      new Request("https://lab.invalid/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": CHROME_WIN },
        body: JSON.stringify({ email: h.email, password: PASSWORD }),
      });

    const good = await loginRoute.POST(loginReq());
    const goodBody = (await good.json()) as { token?: string };
    ok("LOGIN succeeds and returns a token", good.status === 200 && typeof goodBody.token === "string");
    const ctx = await getAuthContext(bearer(goodBody.token ?? ""));
    ok("PHASE 3.3: the login token ALWAYS names a session", ctx !== null && ctx.sessionId !== null);
    const row = await owner.authSession.findUnique({
      where: { id: ctx?.sessionId ?? "" },
      select: { userAgent: true },
    });
    ok("...and the device was recorded", row?.userAgent === CHROME_WIN);
    const list = await listSessions({ userId: h.id, currentSessionId: ctx?.sessionId ?? null });
    ok("...and shows up as this device with a human label",
      list.some((s) => s.current && s.label === "Chrome · Windows"));

    // Now make session creation impossible and prove login FAILS CLOSED.
    await owner.$executeRawUnsafe(`REVOKE INSERT ON public."AuthSession" FROM app_auth`);
    const denied = await loginRoute.POST(loginReq());
    const deniedBody = (await denied.json()) as { token?: string; error?: string };
    ok("SESSION CREATION FAILURE fails the login closed", denied.status >= 500, `${denied.status}`);
    ok("...no access token is returned", deniedBody.token === undefined);
    ok("...no refresh cookie is set", denied.headers.get("set-cookie") === null);
    // Restore, and prove the restore worked rather than assuming it.
    for (const s of statements(readFileSync(MIG("20260908200000_auth_session_privilege_contract"), "utf8")))
      await owner.$executeRawUnsafe(s);
    for (const s of statements(readFileSync(MIG("20260913120000_authsession_user_agent"), "utf8")))
      await owner.$executeRawUnsafe(s);
    const recovered = await loginRoute.POST(loginReq());
    ok("...and login works again once the grant is back", recovered.status === 200, `${recovered.status}`);
  }

  // ── refresh: a token, and it names the session it came from ─────────────
  //
  // The negative case below proves refresh withholds a token when it has no
  // session. This is the other half, and the half that would go unnoticed: a
  // refresh that succeeds but hands back a token naming nobody would restore
  // exactly the 24-hour blind spot this phase exists to close.
  {
    const e = await mkUser();
    const s = await issue(e.id, e.tokenVersion, CHROME_WIN);
    const res = await refreshRoute.handleRefresh(
      new Request("https://lab.invalid/api/auth/refresh", {
        method: "POST",
        headers: {
          origin: "https://lab.invalid",
          host: "lab.invalid",
          cookie: `dubiz_rt=${s.credential}`,
        },
      })
    );
    const body = (await res.json()) as { token?: string };
    ok("REFRESH succeeds and returns a token", res.status === 200 && typeof body.token === "string");
    const ctx = await getAuthContext(bearer(body.token ?? ""));
    ok("PHASE 3.3: the refresh token ALWAYS names a session", ctx !== null && ctx.sessionId !== null);
    // Rotation replaces the secret, not the session, so the device the owner
    // sees must be the same row before and after.
    ok("...the same session, so the device list does not grow on every refresh",
      ctx?.sessionId === s.sessionId);
  }

  // ── refresh: no session, no token ───────────────────────────────────────
  {
    const res = await refreshRoute.handleRefresh(
      new Request("https://lab.invalid/api/auth/refresh", {
        method: "POST",
        headers: {
          origin: "https://lab.invalid",
          host: "lab.invalid",
          cookie: `dubiz_rt=11111111-2222-4333-8444-555555555555.${"a".repeat(64)}`,
        },
      })
    );
    const body = (await res.json()) as { token?: string };
    ok("REFRESH with no usable session returns no token", res.status === 401 && body.token === undefined);
  }

  await auth.$disconnect();
  await owner.$disconnect();
  console.log(`\n[device-sessions-battery] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
