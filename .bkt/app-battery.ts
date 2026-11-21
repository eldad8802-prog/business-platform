/**
 * "מעבר לעוסק מורשה" — application battery: the REAL route handlers → the REAL service → the REAL database function,
 * on the lab built by .bkt/lab.sh <db> --with-bkt (Production role topology, the runtime NOBYPASSRLS).
 *
 * Real here: the session (an AuthSession row + a session-bound token, read by getAuthContext through the auth plane),
 * the password check (bcrypt + login's ledger / lock, memory backend), the proof cookie, the tenant transaction, the
 * definer function, the database locks. Stand-ins (stated, never presented as real): the clock for the "expired proof"
 * case, and Google itself — a GOOGLE proof is minted the way the callback mints it after Google answered (the callback
 * branch is covered by lib/auth/sensitive-reauth.test.ts; a real Google round-trip needs a real Google account).
 *
 *   A1  flag OFF → 404 on all five handlers (GET, preview, reauth password, reauth Google, confirm)
 *   A2  GET: eligible, PASSWORD for a password account, GOOGLE for a Google-only account, the identity on file
 *   A3  happy path: password → proof cookie → preview digest → confirm 200; the database shows AUTHORIZED_DEALER, the
 *       VAT number, the unchanged name / id number / confirmation, one history row (PASSWORD, both dates)
 *   A4  a second transition → refused (NOT_EXEMPT_DEALER); still one history row; GET shows the history
 *   A5  wrong password → 401, no proof; the 4th failure locks (429) as login does
 *   A6  another business's proof (cookie copied) → 401, nothing written
 *   A7  the same user, another session's proof → 401, nothing written
 *   A8  a proof older than 5 minutes → 401, nothing written
 *   A9  Google-only: password re-auth refused (USE_GOOGLE); a GOOGLE proof → 200, history says GOOGLE;
 *       a GOOGLE proof on a password account → 401
 *   A10 dates: future → 400 (preview and confirm), nothing written; an early date → recorded as declared
 *   A11 a different id number → 400; a VAT number other than the id → 400; nothing written
 *   A12 a stale digest (computed for another date) → 409 STATEMENT_STALE, nothing written
 *   A13 8 concurrent confirmations → exactly one 200, one history row
 *   A14 an issued exempt document (issuedSnapshot, number, status) is byte-identical after the transition
 *   A15 tenant isolation: business B's GET / confirm never touch A; B stays exempt
 *   A16 after the transition the legal name / id number still cannot be changed (DZL04)
 *   A17 several users → GET explains, confirm refused (NOT_SOLE_USER), nothing written
 *
 * env: OWNER_URL, DATABASE_URL (runtime), AUTH_DATABASE_URL, AUTH_TOKEN_SECRET, AUTH_PLANE_ENABLED=true,
 *      RATE_LIMIT_BACKEND=memory.   Synthetic only. ZERO network.
 */
import { createHash, randomBytes } from "node:crypto";

import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

import { signAuthToken } from "@/lib/auth-token";
import { issueReauthProof, REAUTH_ACTIONS } from "@/lib/auth/sensitive-reauth";
import { KIND_TRANSITION_ACKNOWLEDGEMENTS, kindTransitionStatementSha256, israelToday } from "@/lib/legal-identity/kind-transition";
import {
  defaultKindTransitionDeps,
  handleKindTransitionConfirm,
  handleKindTransitionGet,
  handleKindTransitionPreview,
  handleKindTransitionReauthGoogle,
  handleKindTransitionReauthPassword,
  type KindTransitionDeps,
} from "@/lib/services/legal-identity/kind-transition-handlers";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const PASSWORD = "Correct-Pass-1";
const ACTION = "BUSINESS_KIND_TRANSITION" as const;
const COOKIE = REAUTH_ACTIONS[ACTION].cookie;
const ACKS = KIND_TRANSITION_ACKNOWLEDGEMENTS.map((a) => a.id);
const TODAY = israelToday();
const addDays = (ymd: string, d: number) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const EARLY = addDays(TODAY, -25);
let seq = 0;
const LEGAL = "דנה כהן";

type Biz = { businessId: number; userId: number; taxId: string; token: string; sessionId: string; userIds: number[] };

async function session(userId: number): Promise<{ sessionId: string; token: string }> {
  const rows = (await owner.$queryRawUnsafe(
    `INSERT INTO "AuthSession" ("userId","secretHash","tokenVersionAtIssue","createdAt","lastUsedAt","idleExpiresAt","absoluteExpiresAt")
     VALUES ($1,$2,0,now(),now(),now() + interval '1 day',now() + interval '30 days') RETURNING id`,
    userId, createHash("sha256").update(randomBytes(32)).digest("hex"))) as Rows;
  const sessionId = String(rows[0].id);
  return { sessionId, token: signAuthToken(userId, 0, sessionId) };
}

async function business(opts: { kind?: string; password?: string | null; users?: number } = {}): Promise<Biz> {
  const n = ++seq;
  const taxId = withCheckDigit(String(30000000 + n * 7919).slice(0, 8));
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `bkt-app-${n}`)) as Rows;
  const businessId = Number(b[0].id);
  const hash = opts.password === null ? null : await bcrypt.hash(opts.password ?? PASSWORD, 4);
  const userIds: number[] = [];
  for (let i = 0; i < (opts.users ?? 1); i++) {
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `bkt-app-${Date.now()}-${n}-${i}@lab.invalid`, hash, businessId)) as Rows;
    userIds.push(Number(u[0].id));
  }
  await owner.$queryRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingAddress","billingPhone",
       "billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
     VALUES ($1,$2,$3,$4,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`,
    businessId, opts.kind ?? "EXEMPT_DEALER", LEGAL, taxId);
  const s = await session(userIds[0]);
  return { businessId, userId: userIds[0], taxId, token: s.token, sessionId: s.sessionId, userIds };
}

const deps = (over: Partial<KindTransitionDeps> = {}): KindTransitionDeps => ({ ...defaultKindTransitionDeps, enabled: () => true, ...over });
const req = (b: Biz, path: string, body?: unknown, cookie?: string) => new Request(`http://lab.invalid/api/business/legal-identity/kind-transition${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${b.token}`, "content-type": "application/json", "x-forwarded-for": `10.9.${seq}.${Math.floor(Math.random() * 250)}`, ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const read = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> });
function proofCookieOf(res: Response): string | null {
  const all = res.headers.getSetCookie?.() ?? [];
  const c = all.find((x) => x.startsWith(`${COOKIE}=`) && !/Max-Age=0/i.test(x));
  return c ? c.split(";")[0] : null;
}
const input = (b: Biz, over: Record<string, unknown> = {}) => ({ confirmTaxId: b.taxId, vatNumber: b.taxId, statusEffectiveDate: EARLY, acknowledged: ACKS, ...over });
const shaFor = (b: Biz, date = EARLY, vat = b.taxId) => kindTransitionStatementSha256({ businessId: b.businessId, actorUserId: b.userId, legalName: LEGAL, taxId: b.taxId, vatNumber: vat, statusEffectiveDate: date });
async function passwordProof(b: Biz): Promise<string> {
  const r = await handleKindTransitionReauthPassword(req(b, "/reauth/password", { password: PASSWORD }), deps());
  const c = proofCookieOf(r);
  if (!c) throw new Error(`no proof cookie (status ${r.status})`);
  return c;
}
const profile = async (businessId: number) => ((await owner.$queryRawUnsafe(`SELECT * FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0];
const history = async (businessId: number) => (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1`, businessId)) as Rows;
const snap = async (businessId: number) => JSON.stringify({ p: await profile(businessId), h: await history(businessId) });

async function main() {
  console.log("A1 flag OFF");
  {
    const b = await business();
    const off = deps({ enabled: () => false });
    const codes = [
      (await handleKindTransitionGet(req(b, ""), off)).status,
      (await handleKindTransitionPreview(req(b, "/preview", input(b)), off)).status,
      (await handleKindTransitionReauthPassword(req(b, "/reauth/password", { password: PASSWORD }), off)).status,
      (await handleKindTransitionReauthGoogle(req(b, "/reauth/google", {}), off)).status,
      (await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, await passwordProof(b)), off)).status,
    ];
    ok("A1 every handler answers 404 while the flag is off", codes.every((c) => c === 404), codes.join(","));
    ok("A1 nothing written", (await history(b.businessId)).length === 0);
  }

  console.log("A2 GET");
  const a = await business();
  {
    const g = await read(await handleKindTransitionGet(req(a, ""), deps()));
    const elig = g.body.eligibility as { eligible: boolean };
    const identity = g.body.identity as { legalName: string; taxId: string };
    ok("A2 eligible, PASSWORD, the identity on file", g.status === 200 && elig.eligible === true && g.body.reauthMethod === "PASSWORD"
       && identity.legalName === LEGAL && identity.taxId === a.taxId, JSON.stringify(g.body).slice(0, 200));
  }

  console.log("A3 happy path");
  const before = await profile(a.businessId);
  {
    const cookie = await passwordProof(a);
    const p = await read(await handleKindTransitionPreview(req(a, "/preview", input(a)), deps()));
    ok("A3 preview answers the digest the app computes", p.status === 200 && p.body.statementSha256 === shaFor(a), JSON.stringify(p.body));
    const c = await handleKindTransitionConfirm(req(a, "", { ...input(a), statementSha256: String(p.body.statementSha256) }, cookie), deps());
    ok("A3 confirm 200", c.status === 200, String(c.status));
    ok("A3 the proof cookie is cleared on success", (c.headers.getSetCookie?.() ?? []).some((x) => x.startsWith(`${COOKIE}=`) && /Max-Age=0/i.test(x)));
    const after = await profile(a.businessId);
    const h = await history(a.businessId);
    ok("A3 profile: AUTHORIZED_DEALER + VAT number", after.billingBusinessKind === "AUTHORIZED_DEALER" && after.billingVatNumber === a.taxId);
    ok("A3 name, id number, confirmation unchanged", after.billingLegalName === before.billingLegalName && after.billingTaxId === before.billingTaxId
       && String(after.legalIdentityConfirmedAt) === String(before.legalIdentityConfirmedAt) && after.legalIdentitySource === before.legalIdentitySource);
    ok("A3 one history row: PASSWORD, the declared date, the actor, the digest", h.length === 1 && h[0].reauthMethod === "PASSWORD"
       && (h[0].statusEffectiveDate as Date).toISOString().slice(0, 10) === EARLY && Number(h[0].confirmedByUserId) === a.userId && h[0].statementSha256 === shaFor(a));
  }

  console.log("A4 no second transition");
  {
    const cookie = await passwordProof(a);
    const r = await read(await handleKindTransitionConfirm(req(a, "", { ...input(a), statementSha256: shaFor(a) }, cookie), deps()));
    ok("A4 refused (NOT_EXEMPT_DEALER)", r.status === 409 && r.body.code === "NOT_EXEMPT_DEALER", JSON.stringify(r.body));
    ok("A4 still one history row", (await history(a.businessId)).length === 1);
    const g = await read(await handleKindTransitionGet(req(a, ""), deps()));
    ok("A4 GET shows the history", (g.body.history as { toKind?: string } | null)?.toKind === "AUTHORIZED_DEALER");
  }

  console.log("A5 wrong password");
  {
    const b = await business();
    const statuses: number[] = [];
    let anyCookie = false;
    for (let i = 0; i < 5; i++) {
      const r = await handleKindTransitionReauthPassword(req(b, "/reauth/password", { password: "wrong-" + i }), deps());
      statuses.push(r.status);
      if (proofCookieOf(r)) anyCookie = true;
    }
    ok("A5 wrong password → 401 ×3, the 4th locks and says so (429), the 5th stays locked", statuses.slice(0, 3).every((s) => s === 401) && statuses.slice(3).every((s) => s === 429), statuses.join(","));
    ok("A5 no proof ever issued", !anyCookie);
  }

  console.log("A6–A8 proofs that do not belong");
  {
    const b = await business();
    const other = await business();
    const foreign = await passwordProof(other);
    const before6 = await snap(b.businessId);
    const r6 = await read(await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, foreign), deps()));
    ok("A6 another business's proof → 401, nothing written", r6.status === 401 && (await snap(b.businessId)) === before6, JSON.stringify(r6.body));

    const second = await session(b.userId);
    const otherSession = `${COOKIE}=${encodeURIComponent(issueReauthProof({ userId: b.userId, sessionId: second.sessionId, action: ACTION, method: "PASSWORD" }))}`;
    const r7 = await read(await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, otherSession), deps()));
    ok("A7 the same user, another session's proof → 401, nothing written", r7.status === 401 && (await snap(b.businessId)) === before6);

    const fresh = await passwordProof(b);
    const r8 = await read(await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, fresh), deps({ now: () => new Date(Date.now() + 6 * 60_000) })));
    ok("A8 a proof older than 5 minutes → 401, nothing written", r8.status === 401 && r8.body.code === "REAUTH_REQUIRED" && (await snap(b.businessId)) === before6);
  }

  console.log("A9 Google-only account");
  {
    const g = await business({ password: null });
    const info = await read(await handleKindTransitionGet(req(g, ""), deps()));
    ok("A9 GET says GOOGLE", info.body.reauthMethod === "GOOGLE");
    const pw = await read(await handleKindTransitionReauthPassword(req(g, "/reauth/password", { password: "x" }), deps()));
    ok("A9 password re-auth refused (USE_GOOGLE)", pw.status === 409 && pw.body.code === "USE_GOOGLE");
    const googleProof = `${COOKIE}=${encodeURIComponent(issueReauthProof({ userId: g.userId, sessionId: g.sessionId, action: ACTION, method: "GOOGLE" }))}`;
    const r = await read(await handleKindTransitionConfirm(req(g, "", { ...input(g), statementSha256: shaFor(g) }, googleProof), deps()));
    ok("A9 GOOGLE proof → 200, history says GOOGLE", r.status === 200 && (await history(g.businessId))[0]?.reauthMethod === "GOOGLE", JSON.stringify(r.body));
    const p = await business();
    const wrongMethod = `${COOKIE}=${encodeURIComponent(issueReauthProof({ userId: p.userId, sessionId: p.sessionId, action: ACTION, method: "GOOGLE" }))}`;
    const before9 = await snap(p.businessId);
    const r2 = await read(await handleKindTransitionConfirm(req(p, "", { ...input(p), statementSha256: shaFor(p) }, wrongMethod), deps()));
    ok("A9 a GOOGLE proof on a password account → 401, nothing written", r2.status === 401 && (await snap(p.businessId)) === before9);
  }

  console.log("A10–A12 input");
  {
    const b = await business();
    const cookie = await passwordProof(b);
    const before10 = await snap(b.businessId);
    const fut = addDays(TODAY, 1);
    const p = await read(await handleKindTransitionPreview(req(b, "/preview", input(b, { statusEffectiveDate: fut })), deps()));
    const c = await read(await handleKindTransitionConfirm(req(b, "", { ...input(b, { statusEffectiveDate: fut }), statementSha256: shaFor(b, fut) }, cookie), deps()));
    ok("A10 future date → 400 on preview and confirm, nothing written", p.status === 400 && c.status === 400 && (await snap(b.businessId)) === before10);
    const wrongTax = await read(await handleKindTransitionPreview(req(b, "/preview", input(b, { confirmTaxId: withCheckDigit("12121212") })), deps()));
    const wrongVat = await read(await handleKindTransitionPreview(req(b, "/preview", input(b, { vatNumber: withCheckDigit("12121212") })), deps()));
    ok("A11 another id number / another VAT number → 400", wrongTax.status === 400 && wrongVat.status === 400);
    const stale = await read(await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b, addDays(EARLY, 1)) }, cookie), deps()));
    ok("A12 a digest for another date → 409 STATEMENT_STALE, nothing written", stale.status === 409 && stale.body.code === "STATEMENT_STALE" && (await snap(b.businessId)) === before10);
    const good = await read(await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, cookie), deps()));
    ok("A10 the early date is recorded as declared", good.status === 200 && (await history(b.businessId))[0] && ((await history(b.businessId))[0].statusEffectiveDate as Date).toISOString().slice(0, 10) === EARLY);
  }

  console.log("A13 concurrency");
  {
    const b = await business();
    const cookie = await passwordProof(b);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, cookie), deps()).then((r) => r.status)));
    ok("A13 exactly one 200 of 8", results.filter((s) => s === 200).length === 1, results.join(","));
    ok("A13 one history row", (await history(b.businessId)).length === 1);
  }

  console.log("A14 issued documents untouched");
  {
    const b = await business();
    const snapshot = { issuer: { legalName: LEGAL, taxId: b.taxId }, extensions: { billingBusinessKind: "EXEMPT_DEALER" } };
    const d = (await owner.$queryRawUnsafe(
      `INSERT INTO "BillingDocument" ("businessId","documentType","status","documentNumber","issuedAt","issuedSnapshot","legalSnapshotHash","updatedAt")
       VALUES ($1,'RECEIPT','ISSUED',141, now() - interval '3 days', $2::jsonb, $3, now()) RETURNING id`,
      b.businessId, JSON.stringify(snapshot), "a".repeat(64))) as Rows;
    const docId = Number(d[0].id);
    const docBefore = JSON.stringify(((await owner.$queryRawUnsafe(`SELECT * FROM "BillingDocument" WHERE id = $1`, docId)) as Rows)[0]);
    const cookie = await passwordProof(b);
    const r = await handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, cookie), deps());
    const docAfter = JSON.stringify(((await owner.$queryRawUnsafe(`SELECT * FROM "BillingDocument" WHERE id = $1`, docId)) as Rows)[0]);
    ok("A14 transition 200 and the issued receipt is byte-identical (kind EXEMPT in its snapshot)", r.status === 200 && docAfter === docBefore && docAfter.includes("EXEMPT_DEALER"));
  }

  console.log("A15 tenant isolation");
  {
    const x = await business();
    const y = await business();
    const cookieY = await passwordProof(y);
    const beforeX = await snap(x.businessId);
    const gy = await read(await handleKindTransitionGet(req(y, ""), deps()));
    ok("A15 B's GET shows B's own identity", (gy.body.identity as { taxId: string }).taxId === y.taxId);
    const ry = await handleKindTransitionConfirm(req(y, "", { ...input(y), statementSha256: shaFor(y) }, cookieY), deps());
    ok("A15 B's transition leaves A untouched", ry.status === 200 && (await snap(x.businessId)) === beforeX && (await profile(x.businessId)).billingBusinessKind === "EXEMPT_DEALER");
  }

  console.log("A16 lock still holds");
  {
    const runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
    const tryUpdate = async (set: string, v: string) => {
      try {
        await runtime.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(a.businessId));
          await tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET ${set} = $2, "updatedAt" = now() WHERE "businessId" = $1`, a.businessId, v);
        });
        return null;
      } catch (e) { return e instanceof Error ? e.message : String(e); }
    };
    const n = await tryUpdate(`"billingLegalName"`, "דנה כהנ");
    const t = await tryUpdate(`"billingTaxId"`, withCheckDigit("12121212"));
    const k = await tryUpdate(`"billingBusinessKind"`, "EXEMPT_DEALER");
    ok("A16 name / id number / back to exempt → DZL04", [n, t, k].every((e) => !!e && /DZL04|LEGAL_IDENTITY_LOCKED/.test(e)), [n, t, k].map((e) => (e ?? "none").slice(0, 60)).join(" | "));
    await runtime.$disconnect();
  }

  console.log("A17 several users");
  {
    const m = await business({ users: 2 });
    const g = await read(await handleKindTransitionGet(req(m, ""), deps()));
    const elig = g.body.eligibility as { eligible: boolean; block?: string };
    ok("A17 GET explains (NOT_SOLE_USER)", elig.eligible === false && elig.block === "NOT_SOLE_USER");
    const cookie = await passwordProof(m);
    const before17 = await snap(m.businessId);
    const r = await read(await handleKindTransitionConfirm(req(m, "", { ...input(m), statementSha256: shaFor(m) }, cookie), deps()));
    ok("A17 confirm refused, nothing written", r.status === 409 && (await snap(m.businessId)) === before17, JSON.stringify(r.body));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
