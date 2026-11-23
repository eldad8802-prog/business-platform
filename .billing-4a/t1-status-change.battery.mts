/**
 * 4a T1 / T1a — the issuer declaration STATUS_CHANGE writer, against the Production role topology (.billing-4a/lab.sh
 * <db> --with-t1 | --with-t1-wiring). Lab proof only: no Production, synthetic data, zero network.
 *
 *   OWNER_URL     lab_owner (table owner, BYPASSRLS, not superuser) — fixtures, read-back, and the definer's own
 *                 context for the component checks (the writer runs as the owner whoever calls it)
 *   DATABASE_URL  app_runtime_prod (NOBYPASSRLS LOGIN member of app_runtime) — the application's own transition
 *                 service, and every "the runtime cannot" check
 *
 * Sections (the report keeps them apart):
 *   P  posture + objects (both labs)
 *   C  T1 COMPONENT — the writer on its own (both labs). Each call runs in a transaction that is rolled back unless
 *      the check is about what stays committed; nothing here depends on the transition calling the writer.
 *   R  REAL TRANSITION, NOT WIRED (lab --with-t1): the migrations alone change nothing for the transition.
 *   W  PRE-INTEGRATION, SIMULATED WIRING (lab --with-t1-wiring): the transition calls the writer through
 *      .billing-4a/t1-wiring.proposed.sql. Evidence for the contract — NOT the integrated test, which needs the real
 *      legal identity follow-up migration.
 *   X  businesses that do not transition are untouched (both labs)
 *
 *   OWNER_URL=… DATABASE_URL=… DIRECT_URL=… AUTH_TOKEN_SECRET=<synthetic> npx tsx .billing-4a/t1-status-change.battery.mts
 */
import { PrismaClient } from "@prisma/client";

let networkAttempts = 0;
globalThis.fetch = (async () => {
  networkAttempts++;
  throw new Error("network disabled in this lab");
}) as typeof fetch;

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
let pass = 0;
const failures: string[] = [];
const notes: string[] = [];
const sectionCounts: Record<string, { pass: number; fail: number }> = {};
let section = "P";
function ok(name: string, cond: boolean, detail: unknown = "") {
  sectionCounts[section] ??= { pass: 0, fail: 0 };
  if (cond) { pass++; sectionCounts[section].pass++; console.log(`  [PASS] ${name}`); }
  else {
    failures.push(name); sectionCounts[section].fail++;
    console.log(`  [FAIL] ${name}${detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
  }
}
function observed(name: string, value: unknown) {
  const line = `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  notes.push(line);
  console.log(`  [OBSERVED] ${line}`);
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 300);
async function refusal(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return msg(e); }
}
type Row = Record<string, unknown>;
const ROLLBACK = new Error("deliberate rollback");
const STMT_V = "kind-transition-exempt-to-authorized-v1";

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
/** Raw timestamps come back as Date: String(Date) drops the milliseconds, so compare instants. */
const ms = (x: unknown) => (x instanceof Date ? x : new Date(String(x))).getTime();
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function main() {
  const { performKindTransition } = await import("@/lib/services/legal-identity/kind-transition.service");
  const { kindTransitionStatementSha256, israelToday } = await import("@/lib/legal-identity/kind-transition");
  const { prisma: runtime } = await import("@/lib/prisma");

  // ================================================================== P posture
  console.log("— P posture and objects");
  const [who] = (await runtime.$queryRawUnsafe(
    `SELECT current_user::text AS who, r.rolsuper, r.rolbypassrls, pg_has_role(current_user, 'app_runtime', 'member') AS member
       FROM pg_roles r WHERE r.rolname = current_user`)) as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean; member: boolean }>;
  ok("P0 the application runs as a NOBYPASSRLS, non-superuser member of app_runtime", !who.rolsuper && !who.rolbypassrls && who.member, who);
  const [o] = (await owner.$queryRawUnsafe(`
    SELECT
      (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'IssuerReauthMethod') AS reauth_enum,
      (SELECT p.prosecdef FROM pg_proc p WHERE p.proname = 'issuer_declaration_status_change') AS writer_definer,
      (SELECT pg_get_userbyid(p.proowner) = pg_get_userbyid(c.relowner) FROM pg_proc p, pg_class c
        WHERE p.proname = 'issuer_declaration_status_change' AND c.relname = 'BusinessIssuerDeclaration') AS writer_owned_by_table_owner,
      (SELECT has_function_privilege('app_runtime', 'public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)', 'EXECUTE')) AS runtime_exec,
      (SELECT has_function_privilege('app_runtime_prod', 'public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)', 'EXECUTE')) AS runtime_prod_exec,
      (SELECT has_function_privilege('app_auth', 'public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)', 'EXECUTE')) AS auth_exec,
      (SELECT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x WHERE p.proname = 'issuer_declaration_status_change' AND x.grantee = 0)) AS public_exec,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'BusinessIssuerDeclaration' AND t.tgname = 'BusinessIssuerDeclaration_status_change_origin') AS origin_trigger,
      (SELECT position('issuer_declaration_status_change' IN pg_get_functiondef(p.oid)) > 0 FROM pg_proc p
        WHERE p.proname = 'business_kind_transition_to_authorized') AS wired,
      (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'BusinessIssuerDeclaration') AS decl_force_rls,
      (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'BusinessProfile') AS profile_force_rls`)) as Row[];
  observed("P1 objects", o);
  const WIRED = o.wired === true;
  console.log(`  lab mode: ${WIRED ? "SIMULATED WIRING (t1-wiring.proposed.sql applied)" : "T1 migrations only (real transition, not wired)"}`);
  ok("P1 T1a: IssuerReauthMethod has GOOGLE (and keeps PASSWORD, EMAIL_LINK, PLATFORM_ADMIN_ELEVATION in order)",
    json(o.reauth_enum) === json(["PASSWORD", "EMAIL_LINK", "PLATFORM_ADMIN_ELEVATION", "GOOGLE"]), o.reauth_enum);
  ok("P1 the writer is SECURITY DEFINER, owned by the declaration table's owner", o.writer_definer === true && o.writer_owned_by_table_owner === true, o);
  ok("P1 nobody else may EXECUTE the writer (app_runtime, app_runtime_prod, app_auth, PUBLIC)",
    o.runtime_exec === false && o.runtime_prod_exec === false && o.auth_exec === false && o.public_exec === false, o);
  ok("P1 the STATUS_CHANGE origin guard is on the declaration table", o.origin_trigger === 1, o.origin_trigger);
  ok("P1 FORCE RLS on BusinessIssuerDeclaration and BusinessProfile", o.decl_force_rls === true && o.profile_force_rls === true, o);

  // ------------------------------------------------------------------ fixtures (owner)
  const stamp = Date.now();
  let n = 0;
  const LEGAL_NAME = "דנה כהן";
  const taxFor = (k: number) => withCheckDigit(String(40_000_000 + ((stamp + k * 7919) % 9_000_000)).slice(0, 8));
  async function business(opts: { kind?: "EXEMPT_DEALER" | "AUTHORIZED_DEALER"; password?: boolean } = {}) {
    const kind = opts.kind ?? "EXEMPT_DEALER";
    const taxId = taxFor(++n);
    const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt") VALUES ($1, now()) RETURNING id`, `t1-${stamp}-${n}`)) as Row[];
    const businessId = Number(b[0].id);
    const u = (await owner.$queryRawUnsafe(
      `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `t1-${stamp}-${n}@lab.invalid`, opts.password === false ? null : "$2b$10$" + "A".repeat(53), businessId)) as Row[];
    await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`,
      businessId, kind, LEGAL_NAME, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
    return { businessId, userId: Number(u[0].id), taxId };
  }
  type Biz = Awaited<ReturnType<typeof business>>;
  /** What the emailed-link flow records (issuer-declaration.service): v1 INITIAL, SOLE_USER_VERIFIED, EMAIL_LINK. */
  async function declare(b: Biz, opts: { kind?: "EXEMPT_DEALER" | "AUTHORIZED_DEALER"; effectiveFrom?: string } = {}) {
    const exempt = (opts.kind ?? "EXEMPT_DEALER") === "EXEMPT_DEALER";
    const r = (await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber",
         "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
         "statementVersion","statementSha256","reauthMethod","reauthAt")
       VALUES ($1, 1, 'INITIAL', $2::"IssuerTrack", 'INDIVIDUAL', $3::"IssuerVatStatus", $4, 'ISRAELI_ID', $5, $6, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid',
         ${opts.effectiveFrom ?? "now()"}, $7, 'SOLE_USER_VERIFIED', $7, 'דנה כהן', 'בעלים', 'issuer-statement-v1', $8, 'EMAIL_LINK', now()) RETURNING id`,
      b.businessId, exempt ? "EXEMPT_DEALER" : "AUTHORIZED_DEALER_INDIVIDUAL", exempt ? "EXEMPT" : "AUTHORIZED",
      LEGAL_NAME, b.taxId, exempt ? null : b.taxId, b.userId, "c".repeat(64))) as Row[];
    return Number(r[0].id);
  }
  const decls = async (businessId: number) =>
    (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1 ORDER BY "version"`, businessId)) as Row[];
  const profile = async (businessId: number) =>
    ((await owner.$queryRawUnsafe(`SELECT "billingBusinessKind" k, "billingLegalName" name, "billingTaxId" tax, "billingVatNumber" vat,
       "legalIdentityConfirmedAt" confirmed, "legalIdentitySource" src FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Row[])[0];
  const transitions = async (businessId: number) =>
    (await owner.$queryRawUnsafe(`SELECT * FROM "BusinessKindTransition" WHERE "businessId" = $1`, businessId)) as Row[];
  const snap = async (businessId: number) => json({ p: await profile(businessId), d: await decls(businessId), t: await transitions(businessId) });

  /** The writer in the definer's context (owner, tenant set). Rolled back unless keep. */
  async function writer(businessId: number | null, a: { user: number; vat: string; method?: string; at?: string; version?: string; sha?: string }, keep = false) {
    let out: { r: string; rows: Row[] } | null = null;
    try {
      await owner.$transaction(async (tx) => {
        if (businessId !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businessId));
        const r = (await tx.$queryRawUnsafe(
          `SELECT public.issuer_declaration_status_change($1::int, $2, $3, $4::timestamptz, $5, $6) AS r`,
          a.user, a.vat, a.method ?? "PASSWORD", a.at ?? new Date().toISOString(), a.version ?? STMT_V, a.sha ?? "a".repeat(64))) as Row[];
        const rows = businessId === null ? [] : ((await tx.$queryRawUnsafe(`SELECT * FROM "BusinessIssuerDeclaration" WHERE "businessId" = $1 ORDER BY "version"`, businessId)) as Row[]);
        out = { r: String(r[0].r), rows };
        if (!keep) throw ROLLBACK;
      }, { maxWait: 30_000, timeout: 60_000 });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    return out!;
  }
  const transition = async (b: Biz, opts: { user?: number; method?: "PASSWORD" | "GOOGLE"; at?: Date } = {}) => {
    const date = israelToday();
    const actor = opts.user ?? b.userId;
    const sha = kindTransitionStatementSha256({ businessId: b.businessId, actorUserId: actor, legalName: LEGAL_NAME, taxId: b.taxId, vatNumber: b.taxId, statusEffectiveDate: date });
    const r = await performKindTransition(b.businessId, actor, { vatNumber: b.taxId, statusEffectiveDate: date, reauthMethod: opts.method ?? "PASSWORD", reauthAt: opts.at ?? new Date(), statementSha256: sha });
    return { r, sha };
  };

  // Controls created FIRST, snapshotted before anything else runs (X).
  const CTRL_EXEMPT_DECLARED = await business(); await declare(CTRL_EXEMPT_DECLARED);
  const CTRL_EXEMPT_PLAIN = await business();
  const CTRL_AUTH_DECLARED = await business({ kind: "AUTHORIZED_DEALER" }); await declare(CTRL_AUTH_DECLARED, { kind: "AUTHORIZED_DEALER" });
  const controls = [CTRL_EXEMPT_DECLARED, CTRL_EXEMPT_PLAIN, CTRL_AUTH_DECLARED];
  const controlBefore = await Promise.all(controls.map((c) => snap(c.businessId)));

  // ================================================================== C component
  section = "C";
  console.log("\n— C T1 component: the writer on its own (definer context, rolled back)");
  {
    const b = await business();
    const v1Id = await declare(b);
    const v1Before = json(await decls(b.businessId));
    const at = new Date().toISOString();
    const sha = "d".repeat(64);
    const w = await writer(b.businessId, { user: b.userId, vat: b.taxId, at, sha });
    ok("C1 exempt-declared business → DECLARED", w.r === "DECLARED", w.r);
    const [v1, v2] = w.rows;
    ok("C1 v2: version 2, supersedes v1, kind STATUS_CHANGE", w.rows.length === 2 && Number(v2.version) === 2 && Number(v2.supersedesId) === v1Id && v2.kind === "STATUS_CHANGE", v2);
    ok("C1 v2: track AUTHORIZED_DEALER_INDIVIDUAL, vatStatus AUTHORIZED, VAT number = id number",
      v2.track === "AUTHORIZED_DEALER_INDIVIDUAL" && v2.vatStatus === "AUTHORIZED" && v2.vatRegistrationNumber === b.taxId, v2);
    ok("C1 v2: same legal name, legal form, id type, id number as v1",
      v2.legalName === v1.legalName && v2.legalForm === v1.legalForm && v2.idType === v1.idType && v2.idNumber === v1.idNumber && v2.idNumber === b.taxId, v2);
    ok("C1 v2: contact details and declarant copied from v1 (a status change changes nothing else)",
      v2.address === v1.address && v2.phone === v1.phone && v2.email === v1.email && v2.tradeName === v1.tradeName
        && v2.declarantName === v1.declarantName && v2.declarantCapacity === v1.declarantCapacity);
    ok("C1 v2: filed by the current authorized user, basis CURRENT_AUTHORIZED_USER",
      Number(v2.declaredByUserId) === b.userId && Number(v2.authorizedUserId) === b.userId && v2.authorityBasis === "CURRENT_AUTHORIZED_USER", v2);
    ok("C1 v2: statement = the transition statement (version + digest), re-auth = the caller's (PASSWORD, same instant)",
      v2.statementVersion === STMT_V && String(v2.statementSha256) === sha && v2.reauthMethod === "PASSWORD"
        && ms(v2.reauthAt) === new Date(at).getTime(), v2);
    ok("C1 v2: effectiveFrom = now (not the declared start date), not before v1",
      ms(v2.effectiveFrom) >= ms(v1.effectiveFrom)
        && Math.abs(ms(v2.effectiveFrom) - Date.now()) < 120_000, v2.effectiveFrom);
    ok("C1 v1 untouched inside the same transaction", json(v1) === json(JSON.parse(v1Before)[0]));
    ok("C1 rolled back: still only v1 on file", json(await decls(b.businessId)) === v1Before);

    const g = await writer(b.businessId, { user: b.userId, vat: b.taxId, method: "GOOGLE" });
    ok("C2 T1a: a GOOGLE re-authentication is recorded as GOOGLE", g.r === "DECLARED" && g.rows[1]?.reauthMethod === "GOOGLE", g.rows[1]?.reauthMethod);

    // refusals: each returns a status and writes nothing
    const before = await snap(b.businessId);
    const other = await business();
    const cases: Array<[string, Promise<{ r: string; rows: Row[] }>, string]> = [
      ["no tenant in context", writer(null, { user: b.userId, vat: b.taxId }), "NOT_ALLOWED"],
      ["a user of another business", writer(b.businessId, { user: other.userId, vat: b.taxId }), "NOT_ALLOWED"],
      ["re-auth 11 minutes old", writer(b.businessId, { user: b.userId, vat: b.taxId, at: new Date(Date.now() - 11 * 60_000).toISOString() }), "REAUTH_REQUIRED"],
      ["re-auth in the future", writer(b.businessId, { user: b.userId, vat: b.taxId, at: new Date(Date.now() + 5 * 60_000).toISOString() }), "REAUTH_REQUIRED"],
      ["re-auth method EMAIL_LINK (not a step-up of this action)", writer(b.businessId, { user: b.userId, vat: b.taxId, method: "EMAIL_LINK" }), "REAUTH_REQUIRED"],
      ["re-auth method PLATFORM_ADMIN_ELEVATION", writer(b.businessId, { user: b.userId, vat: b.taxId, method: "PLATFORM_ADMIN_ELEVATION" }), "REAUTH_REQUIRED"],
      ["another statement version", writer(b.businessId, { user: b.userId, vat: b.taxId, version: "issuer-statement-v1" }), "STATEMENT_INVALID"],
      ["a malformed digest", writer(b.businessId, { user: b.userId, vat: b.taxId, sha: "XYZ" }), "STATEMENT_INVALID"],
      ["VAT number ≠ id number", writer(b.businessId, { user: b.userId, vat: other.taxId }), "VAT_NUMBER_INVALID"],
      ["VAT number with a bad check digit", writer(b.businessId, { user: b.userId, vat: b.taxId.slice(0, 8) + String((Number(b.taxId[8]) + 1) % 10) }), "VAT_NUMBER_INVALID"],
    ];
    for (const [name, p, want] of cases) {
      const r = await p;
      ok(`C3 ${name} → ${want}, nothing written`, r.r === want && r.rows.length <= 1, r.r);
    }
    ok("C3 after every refusal the business is exactly as before", (await snap(b.businessId)) === before);

    const nodecl = await business();
    ok("C4 no declaration → NO_LIVE_DECLARATION", (await writer(nodecl.businessId, { user: nodecl.userId, vat: nodecl.taxId })).r === "NO_LIVE_DECLARATION");
    const anon = await business(); await declare(anon);
    await owner.$executeRawUnsafe(
      `UPDATE "BusinessIssuerDeclaration" SET "legalName"='—',"tradeName"=NULL,"idNumber"='000000000',"address"='—',"phone"='—',"email"='erased@invalid',
         "declarantName"='—',"declarantCapacity"='—',"anonymisedAt"=now() WHERE "businessId" = $1`, anon.businessId);
    ok("C4 anonymised declaration → NO_LIVE_DECLARATION", (await writer(anon.businessId, { user: anon.userId, vat: anon.taxId })).r === "NO_LIVE_DECLARATION");
    const auth = await business({ kind: "AUTHORIZED_DEALER" }); await declare(auth, { kind: "AUTHORIZED_DEALER" });
    ok("C4 already authorized (declaration) → DECLARATION_NOT_EXEMPT", (await writer(auth.businessId, { user: auth.userId, vat: auth.taxId })).r === "DECLARATION_NOT_EXEMPT");

    // not the authorized user: the declaration names user A; B (same business) tries
    const two = await business(); await declare(two);
    const ub = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'בני',$3, now()) RETURNING id`,
      `t1-${stamp}-b@lab.invalid`, "$2b$10$" + "A".repeat(53), two.businessId)) as Row[];
    ok("C5 a user of the business who is not the declaration's authorized user → NOT_AUTHORIZED_USER",
      (await writer(two.businessId, { user: Number(ub[0].id), vat: two.taxId })).r === "NOT_AUTHORIZED_USER");

    // identity on the profile differs from the declaration (only the owner can make that happen — a lab fixture)
    const mis = await business(); await declare(mis);
    await owner.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingLegalName" = 'שם אחר' WHERE "businessId" = $1`, mis.businessId);
    ok("C5 profile legal name differs from the declaration → IDENTITY_MISMATCH", (await writer(mis.businessId, { user: mis.userId, vat: mis.taxId })).r === "IDENTITY_MISMATCH");
    const kindDrift = await business(); await declare(kindDrift);
    await owner.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingBusinessKind" = 'AUTHORIZED_DEALER', "billingVatNumber" = "billingTaxId" WHERE "businessId" = $1`, kindDrift.businessId);
    ok("C5 profile already authorized while the declaration is exempt → IDENTITY_MISMATCH", (await writer(kindDrift.businessId, { user: kindDrift.userId, vat: kindDrift.taxId })).r === "IDENTITY_MISMATCH");

    const future = await business(); await declare(future, { effectiveFrom: "now() + interval '4 minutes'" });
    ok("C6 current record effective in the (near) future → DECLARATION_NOT_YET_EFFECTIVE, no chain-guard exception",
      (await writer(future.businessId, { user: future.userId, vat: future.taxId })).r === "DECLARATION_NOT_YET_EFFECTIVE");

    // duplicates
    const dup = await business(); await declare(dup);
    let twice: string[] = [];
    try {
      await owner.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(dup.businessId));
        for (let i = 0; i < 2; i++) {
          const r = (await tx.$queryRawUnsafe(`SELECT public.issuer_declaration_status_change($1::int, $2, 'PASSWORD', now(), $3, $4) AS r`, dup.userId, dup.taxId, STMT_V, "e".repeat(64))) as Row[];
          twice.push(String(r[0].r));
        }
        throw ROLLBACK;
      });
    } catch (e) { if (e !== ROLLBACK) throw e; }
    ok("C7 called twice in one transaction → DECLARED then DECLARATION_NOT_EXEMPT", json(twice) === json(["DECLARED", "DECLARATION_NOT_EXEMPT"]), twice);
    const par = await business(); await declare(par);
    const results = await Promise.all(Array.from({ length: 6 }, () => writer(par.businessId, { user: par.userId, vat: par.taxId }, true).then((x) => x.r)));
    const parRows = await decls(par.businessId);
    observed("C7 six parallel committed writers", results);
    ok("C7 six parallel writers (committed) → exactly one DECLARED, the rest DECLARATION_NOT_EXEMPT; one v2 on file",
      results.filter((r) => r === "DECLARED").length === 1 && results.filter((r) => r === "DECLARATION_NOT_EXEMPT").length === 5
        && parRows.length === 2 && parRows.filter((r) => r.kind === "STATUS_CHANGE").length === 1, { results, versions: parRows.map((r) => r.version) });

    // the runtime cannot reach the writer, nor file a STATUS_CHANGE by itself
    const rt = await business(); await declare(rt);
    const rtBefore = await snap(rt.businessId);
    const call = await refusal(() => runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(rt.businessId));
      await tx.$queryRawUnsafe(`SELECT public.issuer_declaration_status_change($1::int, $2, 'PASSWORD', now(), $3, $4)`, rt.userId, rt.taxId, STMT_V, "f".repeat(64));
    }));
    ok("C8 app_runtime_prod calling the writer → permission denied", call !== null && /permission denied/i.test(call), call ?? "allowed");
    const rtV1 = (await decls(rt.businessId))[0];
    const direct = await refusal(() => runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(rt.businessId));
      await tx.$executeRawUnsafe(
        `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","supersedesId","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber",
           "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
           "statementVersion","statementSha256","reauthMethod","reauthAt")
         VALUES ($1, 2, $2, 'STATUS_CHANGE', 'AUTHORIZED_DEALER_INDIVIDUAL', 'INDIVIDUAL', 'AUTHORIZED', $3, 'ISRAELI_ID', $4, $4, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid',
           now(), $5, 'CURRENT_AUTHORIZED_USER', $5, 'דנה כהן', 'בעלים', $6, $7, 'PASSWORD', now())`,
        rt.businessId, Number(rtV1.id), LEGAL_NAME, rt.taxId, rt.userId, STMT_V, "f".repeat(64));
    }));
    ok("C8 the runtime inserting a well-formed STATUS_CHANGE directly → refused by the origin guard (DZD33)",
      direct !== null && /ISSUER_STATUS_CHANGE_ONLY_BY_TRANSITION/.test(direct), direct ?? "inserted");
    ok("C8 nothing written by either attempt", (await snap(rt.businessId)) === rtBefore);
    // the emailed-link flow is unchanged: the runtime still files an INITIAL record (origin guard is STATUS_CHANGE only)
    const fresh = await business();
    const initial = await refusal(() => runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(fresh.businessId));
      await tx.$executeRawUnsafe(
        `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber",
           "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
           "statementVersion","statementSha256","reauthMethod","reauthAt")
         VALUES ($1, 1, 'INITIAL', 'EXEMPT_DEALER', 'INDIVIDUAL', 'EXEMPT', $2, 'ISRAELI_ID', $3, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid',
           now(), $4, 'SOLE_USER_VERIFIED', $4, 'דנה כהן', 'בעלים', 'issuer-statement-v1', $5, 'EMAIL_LINK', now())`,
        fresh.businessId, LEGAL_NAME, fresh.taxId, fresh.userId, "c".repeat(64));
    }));
    ok("C9 regression: the runtime still files an INITIAL declaration (emailed-link flow) under RLS", initial === null, initial);
    // the runtime still cannot edit a declared identity on the profile (DZD35 + signup lock unchanged)
    const lockEdit = await refusal(() => runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(fresh.businessId));
      await tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingBusinessKind" = 'AUTHORIZED_DEALER', "billingVatNumber" = "billingTaxId" WHERE "businessId" = $1`, fresh.businessId);
    }));
    ok("C9 regression: the runtime cannot switch a declared profile to authorized by itself (DZD35 / DZL04)", lockEdit !== null && /DZD35|DZL04|ISSUER_PROFILE_IDENTITY_LOCKED|LEGAL_IDENTITY/.test(lockEdit), lockEdit ?? "updated");
    observed("C9 the refusal the runtime gets", lockEdit);
  }

  if (!WIRED) {
    // ================================================================ R real transition, not wired
    section = "R";
    console.log("\n— R the real transition (20261221090000, NOT wired): unchanged by the T1 migrations");
    const d = await business(); await declare(d);
    const before = await snap(d.businessId);
    const r = await transition(d);
    ok("R1 exempt + live declaration → still ISSUER_DECLARATION_ACTIVE, nothing written", r.r === "ISSUER_DECLARATION_ACTIVE" && (await snap(d.businessId)) === before, r.r);
    const plain = await business();
    const p = await transition(plain);
    ok("R2 exempt without a declaration → TRANSITIONED as before; no declaration created", p.r === "TRANSITIONED" && (await decls(plain.businessId)).length === 0
      && (await profile(plain.businessId)).k === "AUTHORIZED_DEALER", p.r);
    const g = await business({ password: false });
    const gr = await transition(g, { method: "GOOGLE" });
    ok("R3 Google-only, no declaration → TRANSITIONED, history says GOOGLE", gr.r === "TRANSITIONED" && (await transitions(g.businessId))[0]?.reauthMethod === "GOOGLE", gr.r);
  } else {
    // ================================================================ W simulated wiring
    section = "W";
    console.log("\n— W PRE-INTEGRATION (simulated wiring: .billing-4a/t1-wiring.proposed.sql) — the application's transition service");
    const a = await business(); const v1Id = await declare(a);
    const v1Before = (await decls(a.businessId))[0];
    const r = await transition(a);
    const ds = await decls(a.businessId);
    const t = (await transitions(a.businessId))[0];
    const p = await profile(a.businessId);
    ok("W1 exempt + live declaration → TRANSITIONED", r.r === "TRANSITIONED", r.r);
    ok("W1 declaration v2 STATUS_CHANGE, version 2, supersedes v1", ds.length === 2 && ds[1].kind === "STATUS_CHANGE" && Number(ds[1].version) === 2 && Number(ds[1].supersedesId) === v1Id, ds.map((x) => [x.version, x.kind]));
    ok("W1 v1 byte-identical after the transition", json(ds[0]) === json(v1Before));
    ok("W1 profile AUTHORIZED_DEALER, VAT number = id number; name, id number, confirmation untouched",
      p.k === "AUTHORIZED_DEALER" && p.vat === a.taxId && p.name === LEGAL_NAME && p.tax === a.taxId && p.src === "SIGNUP" && p.confirmed !== null, p);
    ok("W1 v2 identity = profile identity (name, id number, VAT number) — DZD35's projection holds",
      ds[1].legalName === p.name && ds[1].idNumber === p.tax && ds[1].vatRegistrationNumber === p.vat && ds[1].track === "AUTHORIZED_DEALER_INDIVIDUAL");
    ok("W1 v2 and the history row carry the same statement digest, re-auth method and instant",
      t && String(ds[1].statementSha256) === String(t.statementSha256) && String(t.statementSha256) === r.sha
        && ds[1].reauthMethod === t.reauthMethod && ms(ds[1].reauthAt) === ms(t.reauthAt), { d: ds[1].statementSha256, t: t?.statementSha256 });
    ok("W1 v2 effectiveFrom = the history row's confirmedAt (one transaction, one instant)",
      t && ms(ds[1].effectiveFrom) === ms(t.confirmedAt), { e: ds[1].effectiveFrom, c: t?.confirmedAt });
    // DZD35 after the transaction: the runtime re-sends the identity unchanged (forms send every field back) → accepted
    const resend = await refusal(() => runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(a.businessId));
      await tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingBusinessKind" = 'AUTHORIZED_DEALER', "billingVatNumber" = $2, "billingAddress" = 'הרצל 2, תל אביב' WHERE "businessId" = $1`, a.businessId, a.taxId);
    }));
    ok("W2 DZD35 satisfied after the transition: the runtime re-sends the identity unchanged + edits the address → accepted", resend === null, resend);
    const back = await refusal(() => runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(a.businessId));
      await tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingBusinessKind" = 'EXEMPT_DEALER', "billingVatNumber" = NULL WHERE "businessId" = $1`, a.businessId);
    }));
    ok("W2 back to exempt by the runtime → refused (authorized → exempt has no path)", back !== null, back ?? "updated");
    const again = await transition(a);
    ok("W2 a second transition → NOT_EXEMPT_DEALER, nothing new", again.r === "NOT_EXEMPT_DEALER" && (await decls(a.businessId)).length === 2 && (await transitions(a.businessId)).length === 1, again.r);

    // T1a: Google-only owner of a declared business
    const g = await business({ password: false }); await declare(g);
    const gr = await transition(g, { method: "GOOGLE" });
    const gd = await decls(g.businessId);
    ok("W3 T1a: Google-only declared owner → TRANSITIONED; declaration v2 and history both say GOOGLE",
      gr.r === "TRANSITIONED" && gd[1]?.reauthMethod === "GOOGLE" && (await transitions(g.businessId))[0]?.reauthMethod === "GOOGLE", { r: gr.r, d: gd[1]?.reauthMethod });
    const gs = await business({ password: false }); await declare(gs);
    const gsBefore = await snap(gs.businessId);
    const stale = await transition(gs, { method: "GOOGLE", at: new Date(Date.now() - 11 * 60_000) });
    ok("W3 T1a: a GOOGLE re-auth older than 10 minutes → REAUTH_REQUIRED, nothing written", stale.r === "REAUTH_REQUIRED" && (await snap(gs.businessId)) === gsBefore, stale.r);

    // rollback: a failure AFTER the writer filed v2 rolls everything back (lab-only fault injection, removed after)
    for (const [where, table] of [["the history row", "BusinessKindTransition"], ["the profile update", "BusinessProfile"]] as const) {
      const f = await business(); await declare(f);
      const before = await snap(f.businessId);
      const fn = `lab_fault_${table.toLowerCase()}`;
      await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."businessId" = ${f.businessId} THEN RAISE EXCEPTION 'LAB_FAULT_INJECTED'; END IF; RETURN NEW; END $$`);
      await owner.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE ${table === "BusinessProfile" ? "UPDATE" : "INSERT"} ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
      let err: string | null = null;
      try { await transition(f); } catch (e) { err = msg(e); }
      await owner.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "${table}"`);
      await owner.$executeRawUnsafe(`DROP FUNCTION public.${fn}()`);
      ok(`W4 a failure at ${where} (after v2 was filed) → the call fails and NOTHING is left: no v2, profile exempt, no history`,
        err !== null && /LAB_FAULT_INJECTED/.test(err) && (await snap(f.businessId)) === before, err ?? "no error");
      const retry = await transition(f);
      ok(`W4 after the fault is removed the same business transitions normally (no half state blocked it)`, retry.r === "TRANSITIONED" && (await decls(f.businessId)).length === 2, retry.r);
    }
    // a refusal from the writer returns before anything is written
    const fut = await business(); await declare(fut, { effectiveFrom: "now() + interval '4 minutes'" });
    const futBefore = await snap(fut.businessId);
    const fr = await transition(fut);
    ok("W4 writer refusal (record not yet effective) → ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE, nothing written",
      fr.r === "ISSUER_DECLARATION_DECLARATION_NOT_YET_EFFECTIVE" && (await snap(fut.businessId)) === futBefore, fr.r);

    // who may act
    const two = await business(); await declare(two);
    await owner.$executeRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'בני',$3, now())`, `t1-${stamp}-w5@lab.invalid`, "$2b$10$" + "A".repeat(53), two.businessId);
    const twoBefore = await snap(two.businessId);
    ok("W5 a business with two users → NOT_SOLE_USER, nothing written", (await transition(two)).r === "NOT_SOLE_USER" && (await snap(two.businessId)) === twoBefore);
    // sole user who is not the declaration's authorized user: A declared, A moved out, B is now the only user
    const moved = await business(); await declare(moved);
    const other = await business();
    const nb = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'בני',$3, now()) RETURNING id`,
      `t1-${stamp}-w5b@lab.invalid`, "$2b$10$" + "A".repeat(53), moved.businessId)) as Row[];
    await owner.$executeRawUnsafe(`UPDATE "User" SET "businessId" = $1 WHERE id = $2`, other.businessId, moved.userId);
    const movedBefore = await snap(moved.businessId);
    const mr = await transition(moved, { user: Number(nb[0].id) });
    ok("W5 the sole user is not the declaration's authorized user → ISSUER_DECLARATION_NOT_AUTHORIZED_USER, nothing written",
      mr.r === "ISSUER_DECLARATION_NOT_AUTHORIZED_USER" && (await snap(moved.businessId)) === movedBefore, mr.r);
    const foreign = await business(); await declare(foreign);
    const foreignBefore = await snap(foreign.businessId);
    const fo = await transition(foreign, { user: other.userId });
    ok("W5 a user of another business → NOT_ALLOWED, nothing written", fo.r === "NOT_ALLOWED" && (await snap(foreign.businessId)) === foreignBefore, fo.r);
    const mis = await business(); await declare(mis);
    await owner.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingLegalName" = 'שם אחר' WHERE "businessId" = $1`, mis.businessId);
    const misBefore = await snap(mis.businessId);
    const date = israelToday();
    const misSha = kindTransitionStatementSha256({ businessId: mis.businessId, actorUserId: mis.userId, legalName: "שם אחר", taxId: mis.taxId, vatNumber: mis.taxId, statusEffectiveDate: date });
    const mres = await performKindTransition(mis.businessId, mis.userId, { vatNumber: mis.taxId, statusEffectiveDate: date, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: misSha });
    ok("W5 profile identity differs from the declaration → ISSUER_DECLARATION_IDENTITY_MISMATCH, nothing written",
      mres === "ISSUER_DECLARATION_IDENTITY_MISMATCH" && (await snap(mis.businessId)) === misBefore, mres);

    // duplicates: parallel and repeated requests
    const par = await business(); await declare(par);
    const date2 = israelToday();
    const parSha = kindTransitionStatementSha256({ businessId: par.businessId, actorUserId: par.userId, legalName: LEGAL_NAME, taxId: par.taxId, vatNumber: par.taxId, statusEffectiveDate: date2 });
    const pr = await Promise.all(Array.from({ length: 6 }, () => performKindTransition(par.businessId, par.userId,
      { vatNumber: par.taxId, statusEffectiveDate: date2, reauthMethod: "PASSWORD", reauthAt: new Date(), statementSha256: parSha })));
    observed("W6 six parallel transitions", pr);
    const pds = await decls(par.businessId);
    ok("W6 six parallel transitions → exactly one TRANSITIONED, the rest NOT_EXEMPT_DEALER",
      pr.filter((x) => x === "TRANSITIONED").length === 1 && pr.filter((x) => x === "NOT_EXEMPT_DEALER").length === 5, pr);
    ok("W6 one v2, one history row", pds.length === 2 && pds.filter((x) => x.kind === "STATUS_CHANGE").length === 1 && (await transitions(par.businessId)).length === 1);

    // businesses without a live declaration keep today's path
    const plain = await business();
    const pl = await transition(plain);
    ok("W7 exempt without a declaration → TRANSITIONED, no declaration created (today's path)", pl.r === "TRANSITIONED" && (await decls(plain.businessId)).length === 0, pl.r);
    const anon = await business(); await declare(anon);
    await owner.$executeRawUnsafe(
      `UPDATE "BusinessIssuerDeclaration" SET "legalName"='—',"tradeName"=NULL,"idNumber"='000000000',"address"='—',"phone"='—',"email"='erased@invalid',
         "declarantName"='—',"declarantCapacity"='—',"anonymisedAt"=now() WHERE "businessId" = $1`, anon.businessId);
    const an = await transition(anon);
    ok("W7 anonymised declaration → TRANSITIONED without a new record (today's path)", an.r === "TRANSITIONED" && (await decls(anon.businessId)).length === 1, an.r);
  }

  // ================================================================== X untouched
  section = "X";
  console.log("\n— X businesses that did not transition");
  const controlAfter = await Promise.all(controls.map((c) => snap(c.businessId)));
  ok("X1 exempt + declared control: profile, declarations, history byte-identical", controlAfter[0] === controlBefore[0]);
  ok("X1 exempt, no declaration control: byte-identical", controlAfter[1] === controlBefore[1]);
  ok("X1 authorized + declared control: byte-identical", controlAfter[2] === controlBefore[2]);
  ok("X2 zero network attempts", networkAttempts === 0, networkAttempts);

  console.log(`\nT1 (${WIRED ? "simulated wiring" : "migrations only"}): ${pass} passed, ${failures.length} failed`);
  console.log("by section: " + Object.entries(sectionCounts).map(([k, v]) => `${k} ${v.pass}/${v.pass + v.fail}`).join(" · "));
  if (notes.length) console.log("observed:\n  " + notes.join("\n  "));
  await owner.$disconnect();
  await runtime.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => {
  console.error("BATTERY ERROR:", e);
  await owner.$disconnect();
  process.exit(1);
});
