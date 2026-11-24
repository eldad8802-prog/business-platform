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
 *   A18 (wired lab, 20261225090000) a business with a live issuer declaration: GET eligible; password → preview →
 *       confirm 200; declaration v2 STATUS_CHANGE with the history row's digest / method / instant; v1 and an issued
 *       receipt byte-identical; the proof is spent
 *   A19 (wired) the declaration writer's refusals through the real route: not yet effective → 409 "בעוד כמה דקות";
 *       the sole user is not the declaration's authorized user → 409; nothing written, the proof kept
 *   A20 (unwired lab: the application deployed before the migration) a declared business: GET eligible, confirm →
 *       409 ISSUER_DECLARATION_ACTIVE with a Hebrew text, nothing written
 *
 *   4a T4 — the interim documents (contract .billing-4a/T4-INTERIM-DOCUMENTS-CONTRACT.md §3), through the real route
 *   handlers (theirs: GET interim-documents; ours: confirm) and the real database function + count in one transaction:
 *   T1  the window: issued TAX_INVOICE / TAX_INVOICE_RECEIPT / RECEIPT / CREDIT_NOTE from the chosen date that froze
 *       EXEMPT_DEALER; not a QUOTE, a DRAFT, a document before the date, or another business's document (isolation)
 *   T2  the date changes → the route's count changes; the confirm with the number for that date → 200
 *   T3  zero documents → 0, confirm with 0 → 200; many documents (120) → the count, the list pages (50+50+20) to the end
 *   T4  a stale number → 409 { error: INTERIM_DOCUMENTS_CHANGED, count }; profile, history and declarations byte-identical;
 *       the proof kept; the same proof with the new number → 200
 *   T5  (wired) a declared business with a stale number → 409 and the declaration v2 rolled back with everything else;
 *       the right number → 200, v2 written
 *   T6  an issuance holding the business's key (shared) while the owner confirms: the transition waits, then counts
 *       the new document inside its own transaction → 409, nothing written; confirm again with the new number → 200
 *   T7  the real issuance racing the real confirm (both orders possible): 200 → the number sent equals the documents
 *       counted for the window afterwards; 409 → nothing written, and the new number then succeeds
 *   T8  after the transition, the route answers from the history row (TRANSITION_RECORD; a date sent is ignored) with
 *       the number the owner confirmed
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
/** interimDocumentCount: the number the owner saw (4a T4); 0 unless a case seeds documents in the window. */
const input = (b: Biz, over: Record<string, unknown> = {}) => ({ confirmTaxId: b.taxId, vatNumber: b.taxId, statusEffectiveDate: EARLY, acknowledged: ACKS, interimDocumentCount: 0, ...over });
const shaFor = (b: Biz, date = EARLY, vat = b.taxId) => kindTransitionStatementSha256({ businessId: b.businessId, actorUserId: b.userId, legalName: LEGAL, taxId: b.taxId, vatNumber: vat, statusEffectiveDate: date });
async function passwordProof(b: Biz): Promise<string> {
  const r = await handleKindTransitionReauthPassword(req(b, "/reauth/password", { password: PASSWORD }), deps());
  const c = proofCookieOf(r);
  if (!c) throw new Error(`no proof cookie (status ${r.status})`);
  return c;
}
const profile = async (businessId: number) => ((await owner.$queryRawUnsafe(`SELECT * FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0];
const history = async (businessId: number) => (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1`, businessId)) as Rows;
const declarations = async (businessId: number) =>
  (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1 ORDER BY "version"`, businessId)) as Rows;
const snap = async (businessId: number) => JSON.stringify({ p: await profile(businessId), h: await history(businessId), d: await declarations(businessId) });
/** An exempt declaration v1 as the emailed-link flow records it (INITIAL, SOLE_USER_VERIFIED, EMAIL_LINK). */
async function declare(b: Biz, effectiveFrom = "now() - interval '1 day'") {
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber",
       "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
       "statementVersion","statementSha256","reauthMethod","reauthAt")
     VALUES ($1, 1, 'INITIAL', 'EXEMPT_DEALER', 'INDIVIDUAL', 'EXEMPT', $2, 'ISRAELI_ID', $3, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid',
       ${effectiveFrom}, $4, 'SOLE_USER_VERIFIED', $4, 'דנה כהן', 'בעלים', 'issuer-statement-v1', $5, 'EMAIL_LINK', now() - interval '1 day')`,
    b.businessId, LEGAL, b.taxId, b.userId, "c".repeat(64));
}

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
    // Warm the connection pool first: a cold pool on a slow local machine can miss Prisma 2 s "start a
    // transaction" window (P2028, a 500 "nothing written": safe, but not the point of this check).
    await Promise.all(Array.from({ length: 10 }, () => handleKindTransitionGet(req(b, ""), deps())));
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      handleKindTransitionConfirm(req(b, "", { ...input(b), statementSha256: shaFor(b) }, cookie), deps()).then((r) => r.status)));
    ok("A13 exactly one 200 of 8; the other 7 a clean 409 (already moved)", results.filter((s) => s === 200).length === 1 && results.filter((s) => s === 409).length === 7, results.join(","));
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
    const r = await handleKindTransitionConfirm(req(b, "", { ...input(b, { interimDocumentCount: 1 }), statementSha256: shaFor(b) }, cookie), deps());
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

  const WIRED = ((await owner.$queryRawUnsafe(
    `SELECT position('issuer_declaration_status_change' IN pg_get_functiondef(p.oid)) > 0 AS w FROM pg_proc p WHERE p.proname = 'business_kind_transition_to_authorized'`)) as Rows)[0]?.w === true;
  console.log(`lab: ${WIRED ? "WIRED (20261225090000 applied)" : "20261221090000 only (not wired)"}`);
  const cleared = (res: Response) => (res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith(`${COOKIE}=`) && /Max-Age=0/i.test(c));
  const anyProofCookie = (res: Response) => (res.headers.getSetCookie?.() ?? []).some((c) => c.startsWith(`${COOKIE}=`));
  if (WIRED) {
    console.log("A18 a declared business, end to end");
    {
      const d = await business();
      await declare(d);
      const v1 = JSON.stringify((await declarations(d.businessId))[0]);
      const doc = (await owner.$queryRawUnsafe(
        `INSERT INTO "BillingDocument" ("businessId","documentType","status","documentNumber","issuedAt","issuedSnapshot","legalSnapshotHash","updatedAt")
         VALUES ($1,'RECEIPT','ISSUED',77, now() - interval '3 days', $2::jsonb, $3, now() - interval '3 days') RETURNING id`,
        d.businessId, JSON.stringify({ issuer: { legalName: LEGAL, taxId: d.taxId }, extensions: { billingBusinessKind: "EXEMPT_DEALER" } }), "b".repeat(64))) as Rows;
      const docOf = async () => JSON.stringify(((await owner.$queryRawUnsafe(`SELECT * FROM "BillingDocument" WHERE id = $1`, Number(doc[0].id))) as Rows)[0]);
      const docBefore = await docOf();
      const g = await read(await handleKindTransitionGet(req(d, ""), deps()));
      ok("A18 GET: eligible with a live declaration", (g.body.eligibility as { eligible: boolean }).eligible === true, JSON.stringify(g.body.eligibility));
      const cookie = await passwordProof(d);
      const pv = await read(await handleKindTransitionPreview(req(d, "/preview", input(d)), deps()));
      ok("A18 preview digest = the server's statement", pv.status === 200 && pv.body.statementSha256 === shaFor(d), JSON.stringify(pv.body));
      const res = await handleKindTransitionConfirm(req(d, "", { ...input(d, { interimDocumentCount: 1 }), statementSha256: pv.body.statementSha256 }, cookie), deps());
      const r = await read(res.clone());
      const ds = await declarations(d.businessId);
      const h = (await history(d.businessId))[0] ?? {};
      const p = await profile(d.businessId);
      ok("A18 confirm 200 TRANSITIONED", r.status === 200 && r.body.code === "TRANSITIONED", JSON.stringify(r.body));
      ok("A18 declaration v2 STATUS_CHANGE, authorized, VAT = id; v1 byte-identical",
        ds.length === 2 && ds[1].kind === "STATUS_CHANGE" && ds[1].vatStatus === "AUTHORIZED" && ds[1].vatRegistrationNumber === d.taxId && JSON.stringify(ds[0]) === v1);
      ok("A18 v2 and history: one digest (the one the owner previewed), PASSWORD, one instant; effectiveFrom = confirmedAt",
        ds[1]?.statementSha256 === shaFor(d) && h.statementSha256 === shaFor(d) && ds[1]?.reauthMethod === "PASSWORD" && h.reauthMethod === "PASSWORD"
          && new Date(String(ds[1]?.reauthAt)).getTime() === new Date(String(h.reauthAt)).getTime()
          && new Date(String(ds[1]?.effectiveFrom)).getTime() === new Date(String(h.confirmedAt)).getTime());
      ok("A18 profile AUTHORIZED_DEALER; name and id number unchanged", p.billingBusinessKind === "AUTHORIZED_DEALER" && p.billingLegalName === LEGAL && p.billingTaxId === d.taxId);
      ok("A18 the issued receipt is byte-identical", (await docOf()) === docBefore);
      ok("A18 the proof is spent (cleared on success)", cleared(res));
    }
    console.log("A19 the declaration writer's refusals through the route");
    {
      const f = await business();
      await declare(f, "now() + interval '4 minutes'");
      const cookie = await passwordProof(f);
      const before = await snap(f.businessId);
      const res = await handleKindTransitionConfirm(req(f, "", { ...input(f), statementSha256: shaFor(f) }, cookie), deps());
      const r = await read(res.clone());
      ok("A19 not yet effective → 409 ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE, 'בעוד כמה דקות', nothing written, proof kept",
        r.status === 409 && r.body.code === "ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE" && /בעוד כמה דקות/.test(String(r.body.error))
          && (await snap(f.businessId)) === before && !anyProofCookie(res), JSON.stringify(r.body));
      // The declared owner left; another person is now the only user. Same name and id on the file — the writer refuses.
      const m = await business();
      await declare(m);
      const other = await business();
      const hash = await bcrypt.hash(PASSWORD, 4);
      const nu = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'בני',$3, now()) RETURNING id`,
        `bkt-app-${Date.now()}-a19@lab.invalid`, hash, m.businessId)) as Rows;
      await owner.$executeRawUnsafe(`UPDATE "User" SET "businessId" = $1 WHERE id = $2`, other.businessId, m.userId);
      const s2 = await session(Number(nu[0].id));
      const mb: Biz = { ...m, userId: Number(nu[0].id), token: s2.token, sessionId: s2.sessionId, userIds: [Number(nu[0].id)] };
      const c2 = await passwordProof(mb);
      const before2 = await snap(m.businessId);
      const r2 = await read(await handleKindTransitionConfirm(req(mb, "", { ...input(mb), statementSha256: shaFor(mb) }, c2), deps()));
      ok("A19 sole user ≠ the declaration's authorized user → 409 ISSUER_DECLARATION_NOT_AUTHORIZED_USER, nothing written",
        r2.status === 409 && r2.body.code === "ISSUER_DECLARATION_NOT_AUTHORIZED_USER" && /לא נשמר שום שינוי/.test(String(r2.body.error)) && (await snap(m.businessId)) === before2, JSON.stringify(r2.body));
    }
  } else {
    console.log("A20 application before the migration: a declared business");
    {
      const d = await business();
      await declare(d);
      const g = await read(await handleKindTransitionGet(req(d, ""), deps()));
      const cookie = await passwordProof(d);
      const before = await snap(d.businessId);
      const r = await read(await handleKindTransitionConfirm(req(d, "", { ...input(d), statementSha256: shaFor(d) }, cookie), deps()));
      ok("A20 GET eligible; confirm → 409 ISSUER_DECLARATION_ACTIVE with a Hebrew text, nothing written",
        (g.body.eligibility as { eligible: boolean }).eligible === true && r.status === 409 && r.body.code === "ISSUER_DECLARATION_ACTIVE"
          && /לא נשמר שום שינוי/.test(String(r.body.error)) && (await snap(d.businessId)) === before, JSON.stringify(r.body));
    }
  }

  // ================================================================== 4a T4: interim documents
  const { handleInterimDocumentsGet, defaultInterimDocumentsDeps } = await import("@/lib/services/billing/kind-transition/interim-documents-handler");
  const docNo: Record<string, number> = {};
  /** An issued (or other status) billing document, as issuance freezes it: the kind in issuedSnapshot.extensions. */
  async function seedDoc(b: Biz, type: string, issuedAtSql: string, opts: { kind?: string | null; status?: string; total?: string } = {}) {
    const status = opts.status ?? "ISSUED";
    const key = `${b.businessId}:${type}`;
    const n = status === "ISSUED" ? (docNo[key] = (docNo[key] ?? 0) + 1) : null;
    const kindFrozen = opts.kind === undefined ? "EXEMPT_DEALER" : opts.kind;
    const snapshot = kindFrozen === null ? null : JSON.stringify({ issuer: { legalName: LEGAL, taxId: b.taxId }, extensions: { billingBusinessKind: kindFrozen } });
    const r = (await owner.$queryRawUnsafe(
      `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","documentNumber","documentNumberFormatted","subtotalAmount","totalAmount","currency","issuedSnapshot","updatedAt")
       VALUES ($1, $2::"BillingDocumentType", $3::"BillingDocumentStatus", ${issuedAtSql}, $4, $5, $6::numeric, $6::numeric, 'ILS', $7::jsonb, now()) RETURNING id`,
      b.businessId, type, status, n, n === null ? null : String(n).padStart(6, "0"), opts.total ?? "100.00", snapshot)) as Rows;
    return Number(r[0].id);
  }
  /** issuedAt = a calendar day in Israel at noon, stored as UTC wall clock (as the column holds it). */
  const onDay = (ymd: string) => `(('${ymd} 12:00'::timestamp AT TIME ZONE 'Asia/Jerusalem') AT TIME ZONE 'UTC')`;
  const interimDeps = (b: Biz) => ({ ...defaultInterimDocumentsDeps, enabled: () => true, context: async () => ({ user: { id: b.userId, businessId: b.businessId } }) });
  const interim = async (b: Biz, q: string) => read(await handleInterimDocumentsGet(new Request(`http://lab.invalid/api/billing/kind-transition/interim-documents${q}`), interimDeps(b)));
  const confirmWith = async (b: Biz, cookie: string, count: number, over: Record<string, unknown> = {}) => {
    const date = String(over.statusEffectiveDate ?? EARLY);
    const res = await handleKindTransitionConfirm(req(b, "", { ...input(b, { ...over, interimDocumentCount: count }), statementSha256: shaFor(b, date) }, cookie), deps());
    return { res, r: await read(res.clone()) };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  console.log("T1 the window");
  const t1 = await business();
  const other = await business();
  {
    await seedDoc(t1, "RECEIPT", onDay(addDays(EARLY, -1)));                       // before the date → out
    await seedDoc(t1, "RECEIPT", onDay(EARLY));                                    // on the date → in
    await seedDoc(t1, "TAX_INVOICE", onDay(addDays(EARLY, 3)));                    // in (kind exempt as frozen)
    await seedDoc(t1, "CREDIT_NOTE", onDay(addDays(EARLY, 4)));                    // in
    await seedDoc(t1, "QUOTE", onDay(addDays(EARLY, 5)));                          // never
    await seedDoc(t1, "RECEIPT", "NULL", { status: "DRAFT" });                     // never
    await seedDoc(other, "RECEIPT", onDay(addDays(EARLY, 6)));                     // another business → never
    await seedDoc(other, "TAX_INVOICE_RECEIPT", onDay(addDays(EARLY, 7)));
    const r = await interim(t1, `?from=${EARLY}&list=1`);
    const types = ((r.body.items ?? []) as { documentType: string }[]).map((i) => i.documentType).sort();
    ok("T1 the route counts 3 (RECEIPT on the date, TAX_INVOICE, CREDIT_NOTE): not the day before, a QUOTE, a DRAFT, another business",
      r.status === 200 && r.body.count === 3 && JSON.stringify(types) === JSON.stringify(["CREDIT_NOTE", "RECEIPT", "TAX_INVOICE"]), JSON.stringify(r.body).slice(0, 300));
    const ro = await interim(other, `?from=${EARLY}`);
    ok("T1 isolation: the other business sees only its own 2", ro.status === 200 && ro.body.count === 2, JSON.stringify(ro.body));
  }

  console.log("T2 the date changes");
  {
    const later = addDays(EARLY, 2);
    const a2 = await interim(t1, `?from=${EARLY}`);
    const b2 = await interim(t1, `?from=${later}`);
    ok("T2 from the date → 3; two days later → 2 (the receipt on the first date drops out)", a2.body.count === 3 && b2.body.count === 2, `${a2.body.count}/${b2.body.count}`);
    const cookie = await passwordProof(t1);
    const before = await snap(t1.businessId);
    const wrong = await confirmWith(t1, cookie, 3, { statusEffectiveDate: later });
    ok("T2 the number for the old date with the new date → 409 count 2, nothing written", wrong.r.status === 409 && wrong.r.body.count === 2 && (await snap(t1.businessId)) === before, JSON.stringify(wrong.r.body));
    const good = await confirmWith(t1, cookie, 2, { statusEffectiveDate: later });
    const h = await history(t1.businessId);
    ok("T2 the number for the new date → 200; the history row has the new date", good.r.status === 200 && h.length === 1
      && (h[0].statusEffectiveDate as Date).toISOString().slice(0, 10) === later, JSON.stringify(good.r.body));
    const other2 = await interim(other, `?from=${EARLY}`);
    ok("T2 the other business is untouched (still exempt, still 2)", other2.body.count === 2 && (await profile(other.businessId)).billingBusinessKind === "EXEMPT_DEALER");
  }

  console.log("T3 zero and many");
  {
    const z = await business();
    const rz = await interim(z, `?from=${EARLY}&list=1`);
    const cz = await confirmWith(z, await passwordProof(z), 0);
    ok("T3 zero documents → count 0, an empty list; confirm with 0 → 200", rz.body.count === 0 && (rz.body.items as unknown[]).length === 0 && rz.body.nextCursor === null && cz.r.status === 200, JSON.stringify(cz.r.body));
    const many = await business();
    for (let i = 0; i < 120; i++) await seedDoc(many, i % 2 ? "RECEIPT" : "TAX_INVOICE", onDay(addDays(EARLY, 1 + (i % 20))));
    const seen = new Set<number>();
    let cursor: string | null = null;
    let pages = 0;
    const sizes: number[] = [];
    do {
      const pg = await interim(many, `?from=${EARLY}&list=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const items = (pg.body.items ?? []) as { id: number }[];
      sizes.push(items.length);
      for (const it of items) seen.add(it.id);
      cursor = (pg.body.nextCursor as string | null) ?? null;
      pages++;
    } while (cursor && pages < 10);
    ok("T3 120 documents → count 120; pages 50 + 50 + 20, every document once", seen.size === 120 && sizes.join("+") === "50+50+20", sizes.join("+"));
    const cm = await confirmWith(many, await passwordProof(many), 120);
    ok("T3 confirm with 120 → 200", cm.r.status === 200, JSON.stringify(cm.r.body));
  }

  console.log("T4 a stale number");
  {
    const b = await business();
    await seedDoc(b, "RECEIPT", onDay(addDays(EARLY, 1)));
    await seedDoc(b, "RECEIPT", onDay(addDays(EARLY, 2)));
    const cookie = await passwordProof(b);
    const before = await snap(b.businessId);
    const stale = await confirmWith(b, cookie, 1);
    ok("T4 409 { error: INTERIM_DOCUMENTS_CHANGED, count: 2 }", stale.r.status === 409 && stale.r.body.error === "INTERIM_DOCUMENTS_CHANGED" && stale.r.body.count === 2, JSON.stringify(stale.r.body));
    ok("T4 profile, history and declarations byte-identical (atomic rollback)", (await snap(b.businessId)) === before);
    ok("T4 the proof is kept (no cookie change)", !anyProofCookie(stale.res));
    const again = await confirmWith(b, cookie, 2);
    ok("T4 the same proof with the new number → 200, one history row", again.r.status === 200 && (await history(b.businessId)).length === 1, JSON.stringify(again.r.body));
  }

  if (WIRED) {
    console.log("T5 a declared business with a stale number (wired)");
    const d = await business();
    await declare(d);
    await seedDoc(d, "RECEIPT", onDay(addDays(EARLY, 1)));
    const cookie = await passwordProof(d);
    const before = await snap(d.businessId);
    const stale = await confirmWith(d, cookie, 0);
    ok("T5 409 INTERIM_DOCUMENTS_CHANGED count 1; declaration v2 rolled back with the profile and the history (byte-identical)",
      stale.r.status === 409 && stale.r.body.count === 1 && (await snap(d.businessId)) === before && (await declarations(d.businessId)).length === 1, JSON.stringify(stale.r.body));
    const good = await confirmWith(d, cookie, 1);
    const ds = await declarations(d.businessId);
    ok("T5 the right number → 200; v2 STATUS_CHANGE written with the history row", good.r.status === 200 && ds.length === 2 && ds[1].kind === "STATUS_CHANGE" && (await history(d.businessId)).length === 1, JSON.stringify(good.r.body));
  }

  console.log("T6 an issuance holding the key while the owner confirms");
  {
    const b = await business();
    await seedDoc(b, "RECEIPT", onDay(addDays(EARLY, 1)));
    const cookie = await passwordProof(b);
    const shown = Number((await interim(b, `?from=${EARLY}`)).body.count);
    const before = await snap(b.businessId);
    let committedAt = 0;
    // As issueBillingDocumentTx: the key shared, then the document, then commit (after 2 s).
    const issuing = owner.$transaction(async (t) => {
      await t.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(hashtextextended('legal_identity:' || $1::int, 0))`, b.businessId);
      await t.$executeRawUnsafe(
        `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","documentNumber","documentNumberFormatted","subtotalAmount","totalAmount","currency","issuedSnapshot","updatedAt")
         VALUES ($1,'RECEIPT','ISSUED', now() AT TIME ZONE 'UTC', 900, '000900', 50, 50, 'ILS', $2::jsonb, now())`,
        b.businessId, JSON.stringify({ extensions: { billingBusinessKind: "EXEMPT_DEALER" } }));
      await sleep(2000);
      committedAt = Date.now();
    }, { timeout: 30_000, maxWait: 30_000 });
    await sleep(300);
    const t0 = Date.now();
    const raced = await confirmWith(b, cookie, shown);
    const doneAt = Date.now();
    await issuing;
    ok("T6 the transition waited for the issuance (finished after it committed)", committedAt > 0 && doneAt >= committedAt, `waited ${doneAt - t0} ms`);
    ok("T6 → 409 with the new number (shown + 1), nothing written", raced.r.status === 409 && raced.r.body.count === shown + 1 && (await snap(b.businessId)) === before, JSON.stringify(raced.r.body));
    const again = await confirmWith(b, cookie, shown + 1);
    ok("T6 confirm again with the new number → 200", again.r.status === 200, JSON.stringify(again.r.body));
  }

  console.log("T7 the real issuance racing the real confirm");
  {
    process.env.BILLING_AUTHORITY_RUNTIME_ENVIRONMENT ??= "PRODUCTION";
    const { issueBillingDocument } = await import("@/lib/services/billing/billing-issue.service");
    const { createReceiptDraft } = await import("@/lib/services/billing/receipt/billing-receipt-draft.service");
    const issueDeps = { executeApproval: async () => ({ outcome: "completed_approved", billingDocumentId: 0, submissionId: -1, allocationNumber: null, safeToRetry: false }) } as never;
    const outcomes: string[] = [];
    let consistent = true;
    for (let round = 0; round < 4; round++) {
      const b = await business();
      const customer = await owner.customer.create({ data: { businessId: b.businessId, name: "לקוח פרטי" } });
      const draft = (await createReceiptDraft({ businessId: b.businessId, actorUserId: b.userId, documentType: "RECEIPT", customerId: customer.id, currency: "ILS",
        paymentLines: [{ method: "CASH", amount: "10.00", paymentDate: new Date().toISOString() }] } as never)).id;
      const cookie = await passwordProof(b);
      const before = await snap(b.businessId);
      const [iss, conf] = await Promise.allSettled([
        round % 2 ? sleep(5).then(() => issueBillingDocument({ businessId: b.businessId, billingDocumentId: draft, actorUserId: b.userId }, issueDeps)) : issueBillingDocument({ businessId: b.businessId, billingDocumentId: draft, actorUserId: b.userId }, issueDeps),
        confirmWith(b, cookie, 0),
      ]);
      const c = conf.status === "fulfilled" ? conf.value.r : { status: -1, body: { error: String(conf.reason) } };
      const frozen = ((await owner.$queryRawUnsafe(`SELECT "issuedSnapshot"->'extensions'->>'billingBusinessKind' k FROM "BillingDocument" WHERE id = $1 AND status = 'ISSUED'`, draft)) as Rows)[0]?.k ?? "not issued";
      outcomes.push(`${iss.status === "fulfilled" ? "issued" : "issue-failed"}:${String(frozen)}/${c.status}`);
      if (c.status === 200) {
        // the transition went first: the receipt froze AUTHORIZED and is outside the window; the record says 0
        const after = await interim(b, "");
        if (!(after.body.count === 0 && frozen !== "EXEMPT_DEALER")) consistent = false;
      } else if (c.status === 409) {
        // the receipt went first (froze EXEMPT): nothing written; the new number succeeds
        if (!(c.body.count === 1 && frozen === "EXEMPT_DEALER" && (await snap(b.businessId)) === before)) consistent = false;
        const again = await confirmWith(b, cookie, 1);
        if (again.r.status !== 200) consistent = false;
      } else consistent = false;
    }
    console.log(`  [OBSERVED] T7 rounds (issuance:frozen kind/confirm): ${outcomes.join(" | ")}`);
    ok("T7 every round consistent: 200 ⇒ the receipt froze AUTHORIZED and the record counts 0; 409 ⇒ froze EXEMPT, nothing written, the new number → 200", consistent);
  }

  console.log("T8 after the transition: the route answers from the history row");
  {
    const r = await interim(t1, `?from=${EARLY}`);
    const range = r.body.range as { source: string; fromDate: string };
    ok("T8 TRANSITION_RECORD, the confirmed date (not the one sent), the number confirmed (2)", r.status === 200 && range.source === "TRANSITION_RECORD" && range.fromDate === addDays(EARLY, 2) && r.body.count === 2, JSON.stringify(r.body).slice(0, 240));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
