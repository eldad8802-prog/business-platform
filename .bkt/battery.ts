/**
 * Business kind transition battery — migration 20261221090000_business_kind_transition against the Production role
 * topology (.bkt/lab.sh): BusinessProfile under FORCE RLS with the runtime's real grants and the signup lock (DZL04),
 * a non-superuser BYPASSRLS owner, the runtime as a NOBYPASSRLS LOGIN member of app_runtime.
 *
 *   OWNER_URL    lab_owner (fixtures and read-back only)
 *   AUTH_URL     te_auth_login, a LOGIN member of app_auth
 *   RUNTIME_URL  app_runtime_prod, a LOGIN member of app_runtime — every tenant request
 *
 *   K1  happy path: TRANSITIONED; profile kind AUTHORIZED_DEALER + VAT number; legal name, id number and the
 *       confirmation state untouched; one history row with both dates, the actor, the re-auth and the digest
 *   K2  the SQL canonical statement is byte-identical to the application's (Hebrew included); the digest vector
 *   K3  every refusal writes NOTHING (profile and history unchanged): not exempt, invalid / different VAT number,
 *       future / missing / pre-2000 effective date, stale / future / unknown re-auth, stale statement, incomplete
 *       identity, no tenant context, a user of another business, a business being deleted, several users,
 *       a live issuer declaration (20261221090000 alone); wired (20261225090000): the writer's refusal
 *       (declaration not yet effective), and the transition's own refusals before the writer (several users, stale)
 *   K4  an anonymised (erased) issuer declaration does not block; the status start date may be earlier than today;
 *       wired: a live declaration → TRANSITIONED with declaration v2 (STATUS_CHANGE) carrying the same digest
 *   K5  a second transition → NOT_EXEMPT_DEALER (one per business; the reverse has no path)
 *   K6  after the transition the signup lock still holds: kind back to exempt, legal name, id number → DZL04
 *   K7  the runtime cannot write the history table (no INSERT / UPDATE / DELETE); app_auth executes nothing;
 *       the runtime executes the transition only
 *   K8  append-only: even the owner cannot UPDATE a history row (DZL06)
 *   K9  tenant isolation: business B's context reads none of A's history; A's context with B's user → NOT_ALLOWED
 *   K10 ten concurrent transitions of one business → exactly one TRANSITIONED, one history row
 *   K11 an unconfirmed (pilot) exempt business can transition too; nothing about its lock state changes
 *
 * Synthetic only. ZERO secrets. ZERO network.
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .bkt/battery.ts
 */
import { createHash } from "node:crypto";

import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string, n: number) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=${n}&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!, 12) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
const TX = { timeout: 60_000, maxWait: 60_000 };
const DENIED = /permission denied|42501/i;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function fails(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return msg(e); }
}

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const TAX_A = withCheckDigit("51234567");
const TAX_B = withCheckDigit("03141592");
const INVALID = TAX_A.slice(0, 8) + String((Number(TAX_A[8]) + 1) % 10);

// The application's canonical statement (lib/legal-identity/kind-transition.ts), restated so the lab does not import
// application code (migration-first: this PR carries no lib/). K2 proves both sides agree on a fixed vector.
const ACKS = ["registered_with_vat_authority", "same_legal_entity", "issued_documents_unchanged", "new_documents_as_authorized", "not_reversible_in_dubiz"];
function statement(f: { businessId: number; actorUserId: number; legalName: string; taxId: string; vatNumber: string; date: string }) {
  return [
    "statement=kind-transition-exempt-to-authorized-v1", `business=${f.businessId}`, `actor=${f.actorUserId}`,
    "from=EXEMPT_DEALER", "to=AUTHORIZED_DEALER", `legalName=${f.legalName}`, `taxId=${f.taxId}`, `vatNumber=${f.vatNumber}`,
    `statusEffectiveDate=${f.date}`, ...ACKS.map((a) => `ack=${a}`),
  ].join("\n");
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const israelToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const addDays = (ymd: string, d: number) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

let seq = 0;
const LEGAL_NAME = "דנה כהן";
async function business(opts: { kind?: string | null; taxId?: string | null; confirmed?: boolean; users?: number; deleting?: boolean; profile?: boolean } = {}) {
  const kind = opts.kind === undefined ? "EXEMPT_DEALER" : opts.kind;
  const taxId = opts.taxId === undefined ? TAX_A : opts.taxId;
  const b = (await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `bkt-${++seq}`, opts.deleting ? new Date() : null)) as Rows;
  const businessId = Number(b[0].id);
  const userIds: number[] = [];
  for (let i = 0; i < (opts.users ?? 1); i++) {
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `bkt-${Date.now()}-${++seq}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
    userIds.push(Number(u[0].id));
  }
  if (opts.profile !== false) {
    // The owner writes fixtures (it passes the lock triggers); a confirmed profile = what signup leaves behind.
    await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,$3,$4,'הרצל 1, תל אביב','0501234567','biz@lab.invalid',$5,$6, now())`,
      businessId, kind, LEGAL_NAME, taxId, opts.confirmed === false ? null : new Date(), opts.confirmed === false ? null : "SIGNUP");
  }
  return { businessId, userId: userIds[0], userIds };
}
async function asTenant<T>(businessId: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runtime.$transaction(async (tx) => {
    if (businessId !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businessId));
    return fn(tx);
  }, TX);
}
type Call = { vat?: string | null; date?: string | null; method?: string | null; reauthAt?: Date | null; sha?: string | null; userId?: number; ctx?: number | null };
async function transition(b: { businessId: number; userId: number }, c: Call = {}) {
  const userId = c.userId ?? b.userId;
  const vat = c.vat === undefined ? TAX_A : c.vat;
  const date = c.date === undefined ? israelToday() : c.date;
  const digest = c.sha === undefined
    ? sha(statement({ businessId: b.businessId, actorUserId: userId, legalName: LEGAL_NAME, taxId: TAX_A, vatNumber: vat ?? "", date: date ?? "" }))
    : c.sha;
  const ctx = c.ctx === undefined ? b.businessId : c.ctx;
  return asTenant(ctx, async (tx) => ((await tx.$queryRawUnsafe(
    `SELECT public.business_kind_transition_to_authorized($1::int, $2, $3::date, $4, $5::timestamptz, $6) AS r`,
    userId, vat, date, c.method === undefined ? "PASSWORD" : c.method, c.reauthAt === undefined ? new Date() : c.reauthAt, digest)) as Rows)[0].r as string);
}
const profileOf = async (businessId: number) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0];
const historyOf = async (businessId: number) =>
  (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1 ORDER BY id`, businessId)) as Rows;
const declarationsOf = async (businessId: number) =>
  (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1 ORDER BY "version"`, businessId)) as Rows;
const snap = async (businessId: number) =>
  JSON.stringify({ p: await profileOf(businessId), h: await historyOf(businessId), d: await declarationsOf(businessId) });

/** An exempt declaration v1 as the emailed-link flow records it. effectiveFrom: an SQL expression (default now()). */
async function declaration(businessId: number, userId: number, anonymised: boolean, effectiveFrom = "now()") {
  await owner.$executeRawUnsafe(
    `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber",
       "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
       "statementVersion","statementSha256","reauthMethod","reauthAt","anonymisedAt")
     VALUES ($1, 1, 'INITIAL', 'EXEMPT_DEALER', 'INDIVIDUAL', 'EXEMPT', $2, 'ISRAELI_ID', $3, 'הרצל 1', '0501234567', 'biz@lab.invalid',
       ${effectiveFrom}, $4, 'SOLE_USER_VERIFIED', $4, 'דנה', 'בעלים', 'issuer-statement-v1', $5, 'EMAIL_LINK', now(), $6)`,
    businessId, LEGAL_NAME, TAX_A, userId, "a".repeat(64), anonymised ? new Date() : null);
}

let WIRED = false;
async function main() {
  // 20261221090000 alone, or wired to the 4a T1 writer by 20261225090000 (.bkt/lab.sh --with-wiring)?
  WIRED = ((await owner.$queryRawUnsafe(
    `SELECT position('issuer_declaration_status_change' IN pg_get_functiondef(p.oid)) > 0 AS w FROM pg_proc p WHERE p.proname = 'business_kind_transition_to_authorized'`)) as Rows)[0]?.w === true;
  console.log(`lab: ${WIRED ? "WIRED (20261225090000 applied)" : "20261221090000 only (not wired)"}`);
  // ------------------------------------------------------------ K1
  console.log("K1 happy path");
  const today = israelToday();
  const k1 = await business();
  const before1 = await profileOf(k1.businessId);
  const r1 = await transition(k1, { date: addDays(today, -30) });
  const p1 = await profileOf(k1.businessId);
  const h1 = await historyOf(k1.businessId);
  ok("K1 TRANSITIONED", r1 === "TRANSITIONED", r1);
  ok("K1 profile is AUTHORIZED_DEALER with the VAT number", p1.billingBusinessKind === "AUTHORIZED_DEALER" && p1.billingVatNumber === TAX_A);
  ok("K1 legal name, id number and confirmation state untouched",
     p1.billingLegalName === before1.billingLegalName && p1.billingTaxId === before1.billingTaxId
     && String(p1.legalIdentityConfirmedAt) === String(before1.legalIdentityConfirmedAt) && p1.legalIdentitySource === before1.legalIdentitySource);
  const expectSha = sha(statement({ businessId: k1.businessId, actorUserId: k1.userId, legalName: LEGAL_NAME, taxId: TAX_A, vatNumber: TAX_A, date: addDays(today, -30) }));
  const row = h1[0] ?? {};
  ok("K1 one history row: kinds, actor, re-auth, digest", h1.length === 1 && row.fromKind === "EXEMPT_DEALER" && row.toKind === "AUTHORIZED_DEALER"
     && Number(row.confirmedByUserId) === k1.userId && row.reauthMethod === "PASSWORD" && row.statementSha256 === expectSha
     && row.statementVersion === "kind-transition-exempt-to-authorized-v1");
  ok("K1 both dates kept: status start (declared) and confirmation (now)",
     (row.statusEffectiveDate as Date).toISOString().slice(0, 10) === addDays(today, -30)
     && Math.abs((row.confirmedAt as Date).getTime() - Date.now()) < 120_000);

  // ------------------------------------------------------------ K2
  console.log("K2 canonical statement");
  const vec = { businessId: 7, actorUserId: 11, legalName: "ישראל ישראלי", taxId: "123456782", vatNumber: "123456782", date: "2026-11-01" };
  const sqlText = ((await owner.$queryRawUnsafe(
    `SELECT public.business_kind_transition_statement(7, 11, 'ישראל ישראלי', '123456782', '123456782', DATE '2026-11-01') AS s`)) as Rows)[0].s as string;
  ok("K2 SQL statement byte-identical to the application's", sqlText === statement(vec));
  const sqlSha = ((await owner.$queryRawUnsafe(
    `SELECT encode(sha256(convert_to(public.business_kind_transition_statement(7, 11, 'ישראל ישראלי', '123456782', '123456782', DATE '2026-11-01'), 'UTF8')), 'hex') AS h`)) as Rows)[0].h as string;
  ok("K2 digest vector agrees", sqlSha === sha(statement(vec)), sqlSha);
  console.log(`  vector sha256 = ${sqlSha}`);

  // ------------------------------------------------------------ K3
  console.log("K3 every refusal writes nothing");
  const refusals: [string, () => Promise<{ businessId: number; userId: number; userIds: number[] }>, Call, string][] = [
    ["authorized dealer", () => business({ kind: "AUTHORIZED_DEALER" }), {}, "NOT_EXEMPT_DEALER"],
    ["company", () => business({ kind: "LTD_COMPANY" }), {}, "NOT_EXEMPT_DEALER"],
    ["no kind", () => business({ kind: null }), {}, "NOT_EXEMPT_DEALER"],
    ["VAT check digit", () => business(), { vat: INVALID }, "VAT_NUMBER_INVALID"],
    ["VAT missing", () => business(), { vat: null }, "VAT_NUMBER_INVALID"],
    ["VAT is another valid number", () => business(), { vat: TAX_B }, "VAT_NUMBER_DIFFERS_FROM_TAX_ID"],
    ["effective date tomorrow", () => business(), { date: addDays(today, 1) }, "EFFECTIVE_DATE_INVALID"],
    ["effective date missing", () => business(), { date: null }, "EFFECTIVE_DATE_INVALID"],
    ["effective date before 2000", () => business(), { date: "1999-12-31" }, "EFFECTIVE_DATE_INVALID"],
    ["re-auth 11 minutes old", () => business(), { reauthAt: new Date(Date.now() - 11 * 60_000) }, "REAUTH_REQUIRED"],
    ["re-auth in the future", () => business(), { reauthAt: new Date(Date.now() + 5 * 60_000) }, "REAUTH_REQUIRED"],
    ["re-auth method unknown", () => business(), { method: "RECENT_SIGN_IN" }, "REAUTH_REQUIRED"],
    ["re-auth missing", () => business(), { method: null }, "REAUTH_REQUIRED"],
    ["statement digest wrong", () => business(), { sha: "0".repeat(64) }, "STATEMENT_STALE"],
    ["statement digest missing", () => business(), { sha: null }, "STATEMENT_STALE"],
    ["id number invalid on file", () => business({ taxId: INVALID }), { vat: INVALID }, "IDENTITY_INCOMPLETE"],
    ["no profile", () => business({ profile: false }), {}, "IDENTITY_INCOMPLETE"],
    ["no tenant context", () => business(), { ctx: null }, "NOT_ALLOWED"],
    ["business being deleted", () => business({ deleting: true }), {}, "NOT_ALLOWED"],
    ["two users in the business", () => business({ users: 2 }), {}, "NOT_SOLE_USER"],
  ];
  for (const [label, make, call, expected] of refusals) {
    const b = await make();
    const before = await snap(b.businessId);
    const r = await transition(b, call);
    ok(`K3 ${label} → ${expected}, nothing written`, r === expected && (await snap(b.businessId)) === before, r);
  }
  if (!WIRED) {
    // 20261221090000 alone: a live declaration is refused before anything else is written.
    const b = await business();
    await declaration(b.businessId, b.userId, false);
    const before = await snap(b.businessId);
    const r = await transition(b);
    ok("K3 live issuer declaration → ISSUER_DECLARATION_ACTIVE, nothing written", r === "ISSUER_DECLARATION_ACTIVE" && (await snap(b.businessId)) === before, r);
  } else {
    // Wired (20261225090000): a live declaration is no longer a refusal by itself; the 4a writer decides. Its refusals
    // are returned as ISSUER_DECLARATION_<status> and write nothing — not v2, not the history row, not the profile.
    const b = await business();
    await declaration(b.businessId, b.userId, false, "now() + interval '10 minutes'");
    const before = await snap(b.businessId);
    const r = await transition(b);
    ok("K3 live declaration not yet effective → ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE, nothing written",
      r === "ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE" && (await snap(b.businessId)) === before, r);
    const two = await business({ users: 2 });
    await declaration(two.businessId, two.userId, false);
    const twoBefore = await snap(two.businessId);
    const r2 = await transition(two);
    ok("K3 live declaration + two users → NOT_SOLE_USER (the transition's own check first), nothing written",
      r2 === "NOT_SOLE_USER" && (await snap(two.businessId)) === twoBefore, r2);
    const stale = await business();
    await declaration(stale.businessId, stale.userId, false);
    const staleBefore = await snap(stale.businessId);
    const r3 = await transition(stale, { sha: "0".repeat(64) });
    ok("K3 live declaration + stale digest → STATEMENT_STALE before the writer, nothing written",
      r3 === "STATEMENT_STALE" && (await snap(stale.businessId)) === staleBefore, r3);
  }
  {
    // A statement computed for another date (the owner saw one thing, sends another).
    const b = await business();
    const other = sha(statement({ businessId: b.businessId, actorUserId: b.userId, legalName: LEGAL_NAME, taxId: TAX_A, vatNumber: TAX_A, date: addDays(today, -1) }));
    const r = await transition(b, { sha: other });
    ok("K3 digest of a different date → STATEMENT_STALE", r === "STATEMENT_STALE", r);
  }

  // ------------------------------------------------------------ K4
  console.log("K4 erased declaration; past start date");
  {
    const b = await business();
    await declaration(b.businessId, b.userId, true);
    ok("K4 an anonymised declaration does not block", (await transition(b, { date: "2020-01-01" })) === "TRANSITIONED");
    const g = await business();
    ok("K4 start date = today is accepted", (await transition(g, { date: today, method: "GOOGLE" })) === "TRANSITIONED");
    ok("K4 GOOGLE re-auth recorded", (await historyOf(g.businessId))[0]?.reauthMethod === "GOOGLE");
    if (WIRED) {
      const w = await business();
      await declaration(w.businessId, w.userId, false);
      const v1 = JSON.stringify((await declarationsOf(w.businessId))[0]);
      const r = await transition(w, { date: "2026-01-01" });
      const ds = await declarationsOf(w.businessId);
      const h = (await historyOf(w.businessId))[0] ?? {};
      ok("K4 wired: a live declaration → TRANSITIONED; v2 STATUS_CHANGE authorized, v1 byte-identical",
        r === "TRANSITIONED" && ds.length === 2 && ds[1].kind === "STATUS_CHANGE" && ds[1].vatStatus === "AUTHORIZED"
          && ds[1].vatRegistrationNumber === TAX_A && JSON.stringify(ds[0]) === v1, r);
      ok("K4 wired: v2 carries the transition's own digest and re-auth; effectiveFrom = confirmedAt",
        ds[1]?.statementSha256 === h.statementSha256 && ds[1]?.statementVersion === "kind-transition-exempt-to-authorized-v1"
          && ds[1]?.reauthMethod === h.reauthMethod && String(ds[1]?.effectiveFrom) === String(h.confirmedAt));
    }
  }

  // ------------------------------------------------------------ K5
  console.log("K5 once per business");
  ok("K5 a second transition → NOT_EXEMPT_DEALER", (await transition(k1)) === "NOT_EXEMPT_DEALER");
  ok("K5 still one history row", (await historyOf(k1.businessId)).length === 1);

  // ------------------------------------------------------------ K6
  console.log("K6 the signup lock still holds after the transition");
  const upd = (set: string, ...a: unknown[]) => fails(() => asTenant(k1.businessId, (tx) =>
    tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET ${set}, "updatedAt" = now() WHERE "businessId" = $1`, k1.businessId, ...a)));
  for (const [label, set, val] of [
    ["kind back to exempt", `"billingBusinessKind" = $2`, "EXEMPT_DEALER"],
    ["legal name", `"billingLegalName" = $2`, "דנה כהנ"],
    ["id number", `"billingTaxId" = $2`, TAX_B],
  ] as const) {
    const e = await upd(set, val);
    ok(`K6 ${label} → DZL04`, !!e && /DZL04|LEGAL_IDENTITY_LOCKED/.test(e), e ?? "no error");
  }
  const addr = await upd(`"billingAddress" = $2`, "הגפן 3, חיפה");
  ok("K6 address still editable", addr === null, addr ?? "");

  // ------------------------------------------------------------ K7
  console.log("K7 privileges");
  for (const [label, sql] of [
    ["INSERT", `INSERT INTO "BusinessKindTransition" ("businessId","fromKind","toKind","statusEffectiveDate","confirmedByUserId","reauthMethod","reauthAt","statementVersion","statementSha256") VALUES ($1,'EXEMPT_DEALER','AUTHORIZED_DEALER',current_date,1,'PASSWORD',now(),'kind-transition-exempt-to-authorized-v1','${"a".repeat(64)}')`],
    ["UPDATE", `UPDATE "BusinessKindTransition" SET "reauthMethod" = 'GOOGLE' WHERE "businessId" = $1`],
    ["DELETE", `DELETE FROM "BusinessKindTransition" WHERE "businessId" = $1`],
  ] as const) {
    const e = await fails(() => asTenant(k1.businessId, (tx) => tx.$executeRawUnsafe(sql, k1.businessId)));
    ok(`K7 runtime cannot ${label} the history`, !!e && DENIED.test(e), e ?? "no error");
  }
  const readOwn = await asTenant(k1.businessId, async (tx) => (await tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessKindTransition"`)) as Rows);
  ok("K7 runtime reads its own history", Number(readOwn[0].n) === 1);
  const authX = await fails(() => auth.$queryRawUnsafe(`SELECT public.business_kind_transition_to_authorized(1, '${TAX_A}', current_date, 'PASSWORD', now(), '${"a".repeat(64)}')`));
  ok("K7 app_auth cannot execute the transition", !!authX && DENIED.test(authX), authX ?? "no error");
  const stmtX = await fails(() => asTenant(k1.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.business_kind_transition_statement(1,1,'a','b','c',current_date)`)));
  ok("K7 runtime cannot execute the statement helper directly", !!stmtX && DENIED.test(stmtX), stmtX ?? "no error");
  const pub = (await owner.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_proc p WHERE p.proname LIKE 'business_kind_transition%' AND has_function_privilege('app_auth', p.oid, 'EXECUTE')`)) as Rows;
  ok("K7 PUBLIC / app_auth execute none of the three (app_auth inherits PUBLIC)", Number(pub[0].n) === 0, String(pub[0].n));

  // ------------------------------------------------------------ K8
  console.log("K8 append-only");
  const ownUpd = await fails(() => owner.$executeRawUnsafe(`UPDATE "BusinessKindTransition" SET "reauthMethod" = 'GOOGLE' WHERE "businessId" = $1`, k1.businessId));
  ok("K8 owner UPDATE → DZL06", !!ownUpd && /DZL06|APPEND_ONLY/.test(ownUpd), ownUpd ?? "no error");

  // ------------------------------------------------------------ K9
  console.log("K9 tenant isolation");
  const other = await business();
  const seen = await asTenant(other.businessId, async (tx) => (await tx.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "BusinessKindTransition" WHERE "businessId" = $1`, k1.businessId)) as Rows);
  ok("K9 B's context reads none of A's history", Number(seen[0].n) === 0);
  const beforeX = await snap(other.businessId);
  const cross = await transition(other, { userId: k1.userId });
  ok("K9 A's user in B's context → NOT_ALLOWED, nothing written", cross === "NOT_ALLOWED" && (await snap(other.businessId)) === beforeX, cross);

  // ------------------------------------------------------------ K10
  console.log("K10 concurrency");
  const c = await business();
  const results = await Promise.all(Array.from({ length: 10 }, () => transition(c).catch((e) => `ERR ${msg(e)}`)));
  const won = results.filter((r) => r === "TRANSITIONED").length;
  ok("K10 exactly one TRANSITIONED, the rest NOT_EXEMPT_DEALER", won === 1 && results.filter((r) => r === "NOT_EXEMPT_DEALER").length === 9, results.join(","));
  ok("K10 one history row", (await historyOf(c.businessId)).length === 1);

  // ------------------------------------------------------------ K11
  console.log("K11 unconfirmed pilot business");
  const u = await business({ confirmed: false });
  ok("K11 TRANSITIONED", (await transition(u)) === "TRANSITIONED");
  const pu = await profileOf(u.businessId);
  ok("K11 still unconfirmed (no lock imposed by the transition)", pu.legalIdentityConfirmedAt === null && pu.legalIdentitySource === null);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log("FAILED:\n  " + failures.join("\n  ")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await Promise.all([owner.$disconnect(), auth.$disconnect(), runtime.$disconnect()]);
});
