/**
 * PERSISTENT LOGIN — the refresh state machine, on a real PostgreSQL 17 under
 * the shipped privilege contract.
 *
 *   OWNER_URL=postgresql://... npx tsx .authfix/refresh-state-machine-battery.ts
 *
 * This runs the ACTUAL engine from `lib/auth/refresh-session.ts` against the
 * actual grants. Unit tests with a fake client would prove the branches; they
 * would not prove that the rotation is atomic, that the compare-and-swap really
 * serialises two callers, or that a failed history insert really takes the swap
 * with it — and those are the three things that decide whether a lost response
 * means "sign in again" or "carry on".
 *
 * Time is a parameter, not a wait: the engine takes `now`, so a 120-second grace
 * window and a 90-day ceiling are both reachable in a millisecond.
 *
 * Synthetic CI-only credentials. Zero secrets, zero Neon, zero network, zero
 * Production.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  ABSOLUTE_MS,
  GRACE_MS,
  IDLE_MS,
  REVOKED_REASON,
  issueRefreshSession,
  parseCredential,
  refreshSession,
  revokeAllSessionsForUser,
} from "../lib/auth/refresh-session";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OWNER_URL = process.env.OWNER_URL;
if (!OWNER_URL) {
  console.error("OWNER_URL is required (owner connection to the throwaway lab database).");
  process.exit(2);
}

const ROLE = "app_auth_refresh_battery";
const PW = "refresh_ci_synthetic_pw";
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

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
const T0 = new Date("2026-03-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL, log: ["error"] });

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
  ok("lab built from the shipped DDL and the shipped privilege contract", true);

  const business = await owner.business.create({ data: { name: "Refresh Lab" }, select: { id: true } });
  let seq = 0;
  const newUser = async () => {
    seq += 1;
    return owner.user.create({
      data: { email: `refresh-${Date.now()}-${seq}@lab.invalid`, password: "x", name: "u", businessId: business.id },
      select: { id: true, tokenVersion: true },
    });
  };

  const auth = new PrismaClient({ datasourceUrl: AUTH_URL, log: [] });
  const issue = async (now = T0) => {
    const user = await newUser();
    const s = await issueRefreshSession(auth, { userId: user.id, tokenVersion: user.tokenVersion, now });
    return { user, ...s };
  };

  // ── 1. issuance and normal rotation ──────────────────────────────────────
  {
    const s = await issue();
    const parsed = parseCredential(s.credential);
    ok("issuance produces a parseable credential", parsed !== null);
    ok(
      "the absolute ceiling is 90 days from issuance",
      s.absoluteExpiresAt.getTime() === T0.getTime() + ABSOLUTE_MS
    );

    const r = await refreshSession(auth, { credential: s.credential, now: at(1000) });
    ok("NORMAL ROTATION rotates", r.kind === "rotated");
    ok("rotation returns a different credential", r.kind === "rotated" && r.credential !== s.credential);

    const row = await owner.authSession.findUnique({
      where: { id: parsed!.sessionId },
      select: { secretHash: true, lastUsedAt: true, idleExpiresAt: true, absoluteExpiresAt: true },
    });
    const newSecret = parseCredential((r as { credential: string }).credential)!.secret;
    ok("the row now holds the hash of the NEW secret", row?.secretHash === sha256(newSecret));
    ok("lastUsedAt advanced", row?.lastUsedAt.getTime() === at(1000).getTime());
    ok(
      "idle advanced by 30 days",
      row?.idleExpiresAt.getTime() === at(1000).getTime() + IDLE_MS
    );
    ok(
      "ABSOLUTE EXPIRY NEVER MOVES",
      row?.absoluteExpiresAt.getTime() === T0.getTime() + ABSOLUTE_MS
    );

    const history = await owner.authSessionSecret.findMany({
      where: { sessionId: parsed!.sessionId },
      select: { secretHash: true, graceUntil: true },
    });
    ok("the old secret was recorded exactly once", history.length === 1);
    ok("history holds the OLD hash", history[0]?.secretHash === sha256(parsed!.secret));
    ok(
      "the grace window is fixed at 120s from the rotation",
      history[0]?.graceUntil.getTime() === at(1000).getTime() + GRACE_MS
    );
  }

  // ── 2. lost response, recovered inside grace ─────────────────────────────
  {
    const s = await issue();
    const first = await refreshSession(auth, { credential: s.credential, now: at(1000) });
    ok("setup rotated", first.kind === "rotated");

    // The response carrying the new secret never arrived. The browser still has
    // the original. This is the case the whole grace window exists for.
    const recovered = await refreshSession(auth, { credential: s.credential, now: at(1000 + 30_000) });
    ok("LOST-RESPONSE RECOVERY inside grace rotates rather than refusing", recovered.kind === "rotated");

    const rc = (recovered as { credential: string }).credential;
    ok(
      "recovery hands back a credential the caller did not already have",
      rc !== s.credential && rc !== (first as { credential: string }).credential
    );

    // And the point of it: the recovered credential must still work AFTER the
    // original's grace window has closed. Returning only an access token would
    // have left the caller holding something that dies in 120 seconds.
    const later = await refreshSession(auth, { credential: rc, now: at(1000 + 10 * 60_000) });
    ok("the recovered credential outlives the grace window", later.kind === "rotated");
  }

  // ── 3. two concurrent refreshes ──────────────────────────────────────────
  {
    const s = await issue();
    const [a, b] = await Promise.all([
      refreshSession(auth, { credential: s.credential, now: at(1000) }),
      refreshSession(auth, { credential: s.credential, now: at(1000) }),
    ]);
    ok("CONCURRENT: both callers succeed", a.kind === "rotated" && b.kind === "rotated",
      `${a.kind}/${b.kind}`);
    const ca = (a as { credential: string }).credential;
    const cb = (b as { credential: string }).credential;
    ok("CONCURRENT: they receive different credentials", ca !== cb);

    // One is current, the other is in its own grace. Both must still work, or a
    // race would silently sign one tab out.
    const ra = await refreshSession(auth, { credential: ca, now: at(2000) });
    const rb = await refreshSession(auth, { credential: cb, now: at(2000) });
    ok("CONCURRENT: both credentials remain usable", ra.kind === "rotated" && rb.kind === "rotated",
      `${ra.kind}/${rb.kind}`);
  }

  // ── 4. the same old credential retried repeatedly ────────────────────────
  {
    const s = await issue();
    await refreshSession(auth, { credential: s.credential, now: at(1000) });
    const results = [];
    for (let i = 1; i <= 4; i++) {
      results.push(await refreshSession(auth, { credential: s.credential, now: at(1000 + i * 1000) }));
    }
    ok("REPEATED old-secret retries inside grace each recover", results.every((r) => r.kind === "rotated"));

    // Bounded, not unbounded: the window is fixed at the moment of rotation and
    // is never extended, so the retries stop being recoverable on their own.
    const afterGrace = await refreshSession(auth, {
      credential: s.credential,
      now: at(1000 + GRACE_MS + 1000),
    });
    ok("the retries stop the moment the fixed window closes", afterGrace.kind !== "rotated");
  }

  // ── 5. out-of-order responses ────────────────────────────────────────────
  {
    const s = await issue();
    const r1 = await refreshSession(auth, { credential: s.credential, now: at(1000) });
    const r2 = await refreshSession(auth, { credential: (r1 as { credential: string }).credential, now: at(2000) });
    // The browser stored the FIRST response after the second arrived.
    const stale = await refreshSession(auth, { credential: (r1 as { credential: string }).credential, now: at(3000) });
    ok("OUT-OF-ORDER: the superseded credential still recovers inside grace", stale.kind === "rotated");
    ok("setup sanity", r2.kind === "rotated");
  }

  // ── 6. grace expiry, with and without divergence ─────────────────────────
  {
    // No one else used the session: a lost response and a late return. Refuse,
    // but do NOT revoke — absence of evidence is not evidence.
    const s = await issue();
    await refreshSession(auth, { credential: s.credential, now: at(1000) });
    const late = await refreshSession(auth, { credential: s.credential, now: at(1000 + GRACE_MS + 5000) });
    ok("REPLAY AFTER GRACE with no divergence is refused", late.kind === "replay_unproven", late.kind);

    const sid = parseCredential(s.credential)!.sessionId;
    const row = await owner.authSession.findUnique({ where: { id: sid }, select: { revokedAt: true } });
    ok("...and the session is NOT revoked", row?.revokedAt === null);
  }

  {
    // Someone else refreshed successfully after this secret's grace closed.
    // That is positive evidence a second party holds a later credential.
    const s = await issue();
    const r1 = await refreshSession(auth, { credential: s.credential, now: at(1000) });
    await refreshSession(auth, {
      credential: (r1 as { credential: string }).credential,
      now: at(1000 + GRACE_MS + 60_000),
    });
    const replayed = await refreshSession(auth, {
      credential: s.credential,
      now: at(1000 + GRACE_MS + 120_000),
    });
    ok("PROVEN DIVERGENCE revokes the session", replayed.kind === "replay_revoked", replayed.kind);

    const sid = parseCredential(s.credential)!.sessionId;
    const row = await owner.authSession.findUnique({
      where: { id: sid },
      select: { revokedAt: true, revokedReason: true },
    });
    ok("...revokedAt is set", row?.revokedAt !== null);
    ok(
      "...with the mandated wording, never 'confirmed theft'",
      row?.revokedReason === REVOKED_REASON.SUSPECTED_REUSE
    );
  }

  // ── 7. the selector proves nothing ───────────────────────────────────────
  {
    const s = await issue();
    const sid = parseCredential(s.credential)!.sessionId;

    // An attacker who learned only the id invents a secret.
    const forged = `${sid}.${"a".repeat(64)}`;
    const r = await refreshSession(auth, { credential: forged, now: at(1000) });
    ok("SELECTOR-ONLY attacker is refused", r.kind === "unauthorized", r.kind);
    ok("...as an unknown secret", r.kind === "unauthorized" && r.reason === "unknown_secret");

    const row = await owner.authSession.findUnique({ where: { id: sid }, select: { revokedAt: true } });
    ok("...and the session is NOT revoked — the selector is not a kill switch", row?.revokedAt === null);

    const stillFine = await refreshSession(auth, { credential: s.credential, now: at(2000) });
    ok("...the real owner is unaffected", stillFine.kind === "rotated");
  }

  // ── 8. malformed and absent credentials ──────────────────────────────────
  {
    ok("no credential is refused", (await refreshSession(auth, { credential: null, now: T0 })).kind === "unauthorized");
    ok("malformed is refused", (await refreshSession(auth, { credential: "nonsense", now: T0 })).kind === "unauthorized");
    const r = await refreshSession(auth, {
      credential: `4a3b2c1d-0000-4000-8000-000000000000.${"b".repeat(64)}`,
      now: T0,
    });
    ok("an unknown session id is refused", r.kind === "unauthorized", r.kind);
  }

  // ── 9. lifecycle refusals ────────────────────────────────────────────────
  {
    const s = await issue();
    const r = await refreshSession(auth, { credential: s.credential, now: at(IDLE_MS + 1000) });
    ok("IDLE EXPIRY is refused", r.kind === "invalid" && r.reason === "idle_expired", r.kind);
  }
  {
    // The ceiling only bites for a session that is USED throughout. Left alone
    // it idles out at 30 days, so reaching day 90 means refreshing along the
    // way — which is also the realistic shape of a session that lives that long.
    const s = await issue();
    let credential = s.credential;
    const DAY = 86_400_000;
    for (let day = 20; day <= 85; day += 20) {
      const step = await refreshSession(auth, { credential, now: at(day * DAY) });
      if (step.kind !== "rotated") {
        ok(`kept alive to day ${day}`, false, step.kind);
        break;
      }
      credential = step.credential;
    }

    const alive = await refreshSession(auth, { credential, now: at(ABSOLUTE_MS - 60_000) });
    ok("a session refreshed throughout is still alive one minute before the ceiling",
      alive.kind === "rotated", alive.kind);

    const ceilingRow = await owner.authSession.findUnique({
      where: { id: parseCredential(s.credential)!.sessionId },
      select: { idleExpiresAt: true, absoluteExpiresAt: true },
    });
    ok(
      "idle is clamped to the ceiling rather than crossing it",
      ceilingRow !== null && ceilingRow.idleExpiresAt.getTime() === ceilingRow.absoluteExpiresAt.getTime()
    );

    const r = await refreshSession(auth, {
      credential: (alive as { credential: string }).credential,
      now: at(ABSOLUTE_MS + 1000),
    });
    ok("ABSOLUTE EXPIRY is refused", r.kind === "invalid", r.kind);
    ok("...with the absolute reason", r.kind === "invalid" && r.reason === "absolute_expired",
      r.kind === "invalid" ? r.reason : r.kind);
  }
  {
    const s = await issue();
    await revokeAllSessionsForUser(auth, { userId: s.user.id, now: at(500) });
    const r = await refreshSession(auth, { credential: s.credential, now: at(1000) });
    ok("a REVOKED session is refused", r.kind === "invalid" && r.reason === "revoked", r.kind);
  }
  {
    // Global logout increments the generation. A session issued under the old
    // one is a session logout already ended.
    const s = await issue();
    await owner.user.update({
      where: { id: s.user.id },
      data: { tokenVersion: { increment: 1 } },
      select: { id: true },
    });
    const r = await refreshSession(auth, { credential: s.credential, now: at(1000) });
    ok("TOKEN VERSION MISMATCH is refused", r.kind === "invalid" && r.reason === "token_version_mismatch", r.kind);
  }

  // ── 10. global logout revokes every live session ─────────────────────────
  {
    const user = await newUser();
    const a = await issueRefreshSession(auth, { userId: user.id, tokenVersion: user.tokenVersion, now: T0 });
    const b = await issueRefreshSession(auth, { userId: user.id, tokenVersion: user.tokenVersion, now: T0 });
    const count = await revokeAllSessionsForUser(auth, { userId: user.id, now: at(1000) });
    ok("LOGOUT revokes every device", count === 2, `${count}`);
    const ra = await refreshSession(auth, { credential: a.credential, now: at(2000) });
    const rb = await refreshSession(auth, { credential: b.credential, now: at(2000) });
    ok("...and neither credential works afterwards", ra.kind === "invalid" && rb.kind === "invalid");

    const rows = await owner.authSession.count({ where: { userId: user.id } });
    ok("...rows are REVOKED, never deleted", rows === 2, `${rows}`);
  }

  // ── 11. atomicity: a failed history insert takes the swap with it ────────
  {
    const s = await issue();
    const parsed = parseCredential(s.credential)!;

    // Poison the unique index (sessionId, secretHash) so the history insert that
    // pairs with the swap cannot succeed. If the two halves were not one
    // transaction, the row's secret would move and the old secret would be
    // stranded — every client holding it locked out with no way back.
    await owner.authSessionSecret.create({
      data: {
        sessionId: parsed.sessionId,
        secretHash: sha256(parsed.secret),
        rotatedAt: T0,
        graceUntil: at(GRACE_MS),
      },
      select: { id: true },
    });

    let threw = false;
    try {
      await refreshSession(auth, { credential: s.credential, now: at(5000) });
    } catch {
      threw = true;
    }
    ok("ROLLBACK: a failed history insert surfaces as an error", threw);

    const row = await owner.authSession.findUnique({
      where: { id: parsed.sessionId },
      select: { secretHash: true, lastUsedAt: true },
    });
    ok(
      "ROLLBACK: the current secret did NOT move",
      row?.secretHash === sha256(parsed.secret),
      "the swap survived a failed history insert"
    );
    ok("ROLLBACK: lastUsedAt did not move either", row?.lastUsedAt.getTime() === T0.getTime());

    // The decisive property: the caller's old credential still works.
    await owner.authSessionSecret.deleteMany({ where: { sessionId: parsed.sessionId } });
    const after = await refreshSession(auth, { credential: s.credential, now: at(6000) });
    ok("ROLLBACK: the old credential is still usable afterwards", after.kind === "rotated", after.kind);
  }

  await auth.$disconnect();
  await owner.$disconnect();
  console.log(`\n[refresh-state-machine-battery] PASS=${pass} FAIL=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("BATTERY ERROR:", e);
  process.exit(1);
});
