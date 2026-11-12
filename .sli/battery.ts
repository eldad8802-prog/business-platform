/**
 * Signup legal identity battery — migration 20261128090000_signup_legal_identity against the Production role
 * topology (.sli/lab.sh): BusinessProfile under FORCE RLS with the runtime's real grants, app_auth with its real
 * column grants on Business, a non-superuser owner.
 *
 *   OWNER_URL    lab_owner (fixtures and read-back only)
 *   AUTH_URL     te_auth_login, a LOGIN member of app_auth — the signup account transaction
 *   RUNTIME_URL  app_runtime_prod, a LOGIN member of app_runtime — every tenant request
 *
 *   L1  seed inside the account transaction: the profile carries the identity, SIGNUP, confirmed
 *   L2  seed for a business the transaction did not create → DZL01 (app_auth cannot reach existing businesses)
 *   L3  seed with an invalid field → DZL02 naming the field, never the value; the whole account rolls back
 *   L4  app_auth still holds nothing on BusinessProfile
 *   L5  confirmed: address / phone / email / trade name editable; kind / legal name / tax id refused (DZL04);
 *       re-writing the same value passes
 *   L6  nobody but the functions writes the confirmation state (DZL03 on UPDATE and INSERT)
 *   L7  an unconfirmed (existing) profile edits exactly as today
 *   L8  confirm_existing: INCOMPLETE / INVALID_TAX_ID / CONFIRMED / ALREADY_CONFIRMED / NOT_ALLOWED (other
 *       business's user, no tenant context, business in deletion); then locked
 *   L9  the runtime cannot delete a profile row (no grant) or clear a locked column; a business being deleted
 *       can (the account purge clears them)
 *   L10 tenant isolation: tenant A's context reaches no row of B
 *   L11 ten concurrent confirmations → exactly one CONFIRMED
 *   L12 privileges: PUBLIC executes nothing; the runtime cannot seed; app_auth cannot confirm
 *   L13 the SQL check digit agrees with lib/identity/tax-id.ts on a fixed vector set
 *
 * Synthetic only. ZERO secrets. ZERO network.
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .sli/battery.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client";

import { authoritativeTaxId } from "../lib/identity/tax-id";

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

// Valid Israeli check digits (computed, not hand-typed): the same rule as lib/identity/tax-id.ts.
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const VALID_A = withCheckDigit("51234567");
const VALID_B = withCheckDigit("03141592");
const INVALID = VALID_A.slice(0, 8) + String((Number(VALID_A[8]) + 1) % 10);

let seq = 0;
const SEED = (businessId: number, over: Partial<Record<string, string>> = {}) => {
  const v = { kind: "AUTHORIZED_DEALER", legalName: "דנה כהן", taxId: VALID_A, address: "הרצל 1, תל אביב",
              phone: "0501234567", email: "biz@lab.invalid", ...over };
  return [businessId, v.kind, v.legalName, v.taxId, v.address, v.phone, v.email] as const;
};
const SEED_SQL = `SELECT public.signup_legal_identity_seed($1::int, $2, $3, $4, $5, $6, $7)`;

/** The account transaction as the auth plane runs it: Business, then (here) the seed, in one transaction. */
async function signup(over: Partial<Record<string, string>> = {}): Promise<number> {
  return auth.$transaction(async (tx) => {
    const b = (await tx.$queryRawUnsafe(
      `INSERT INTO "Business" ("name","createdAt","updatedAt") VALUES ($1, now(), now()) RETURNING "id"`,
      `sli-${++seq}`)) as Rows;
    const id = Number(b[0].id);
    await tx.$executeRawUnsafe(SEED_SQL, ...SEED(id, over));
    return id;
  }, TX);
}
async function legacyBusiness(profile: Record<string, string | null> | null, opts: { deleting?: boolean } = {}) {
  const b = (await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `sli-legacy-${++seq}`, opts.deleting ? new Date() : null)) as Rows;
  const businessId = Number(b[0].id);
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
    `sli-${Date.now()}-${++seq}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Rows;
  if (profile) {
    const cols = Object.keys(profile);
    await owner.$queryRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","updatedAt"${cols.map((c) => `,"${c}"`).join("")}) VALUES ($1, now()${cols.map((_, i) => `,$${i + 2}`).join("")})`,
      businessId, ...cols.map((c) => profile[c]));
  }
  return { businessId, userId: Number(u[0].id) };
}
async function asTenant<T>(businessId: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runtime.$transaction(async (tx) => {
    if (businessId !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businessId));
    return fn(tx);
  }, TX);
}
const profileOf = async (businessId: number) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0];
const update = (businessId: number, set: string, ...args: unknown[]) =>
  asTenant(businessId, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET ${set}, "updatedAt" = now() WHERE "businessId" = $1`, businessId, ...args));
const confirm = (businessId: number | null, userId: number) =>
  asTenant(businessId, async (tx) => ((await tx.$queryRawUnsafe(`SELECT public.legal_identity_confirm_existing($1::int) AS r`, userId)) as Rows)[0].r as string);

const COMPLETE = { billingBusinessKind: "EXEMPT_DEALER", billingLegalName: "יוסי לוי", billingTaxId: VALID_B,
                   billingAddress: "הגפן 2, חיפה", billingPhone: "0521234567", billingEmail: "y@lab.invalid" };

async function main() {
  console.log("L1 seed inside the account transaction");
  const b1 = await signup();
  const p1 = await profileOf(b1);
  ok("L1 the profile carries the identity", p1?.billingBusinessKind === "AUTHORIZED_DEALER" && p1?.billingLegalName === "דנה כהן"
     && p1?.billingTaxId === VALID_A && p1?.billingAddress === "הרצל 1, תל אביב" && p1?.billingPhone === "0501234567"
     && p1?.billingEmail === "biz@lab.invalid");
  ok("L1 confirmed at signup (SIGNUP)", p1?.legalIdentitySource === "SIGNUP" && p1?.legalIdentityConfirmedAt instanceof Date);

  console.log("L2 seed for a business this transaction did not create");
  const legacy = await legacyBusiness(null);
  const e2 = await fails(() => auth.$transaction((tx) => tx.$executeRawUnsafe(SEED_SQL, ...SEED(legacy.businessId)), TX));
  ok("L2 DZL01 for an existing business", !!e2 && /DZL01|LEGAL_IDENTITY_SEED_NOT_NEW_BUSINESS/.test(e2), e2 ?? "");
  ok("L2 no profile was written", (await profileOf(legacy.businessId)) === undefined);

  console.log("L3 invalid fields");
  const before = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Business"`)) as Rows)[0].n);
  const cases: [string, Record<string, string>][] = [
    ["taxId", { taxId: INVALID }], ["taxId", { taxId: "111111111" }], ["taxId", { taxId: "12345" }],
    ["kind", { kind: "PARTNERSHIP" }], ["legalName", { legalName: " x" }], ["address", { address: "" }],
    ["phone", { phone: "abc" }], ["email", { email: "no-at-sign" }],
  ];
  for (const [field, over] of cases) {
    const e = await fails(() => signup(over));
    const leaked = Object.values(over).some((v) => v.length > 2 && !!e && e.includes(v));
    ok(`L3 ${field} ${JSON.stringify(Object.keys(over))} refused (DZL02), value not in the message`,
       !!e && /DZL02|LEGAL_IDENTITY_INVALID/.test(e) && !leaked, e ?? "accepted");
  }
  const after = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "Business"`)) as Rows)[0].n);
  ok("L3 every refused signup rolled its Business back", after === before, `${before} -> ${after}`);

  console.log("L4 app_auth on BusinessProfile");
  for (const sql of [`SELECT 1 FROM "BusinessProfile" LIMIT 1`, `UPDATE "BusinessProfile" SET "billingPhone" = '1' WHERE false`]) {
    const e = await fails(() => auth.$queryRawUnsafe(sql));
    ok(`L4 app_auth denied: ${sql.slice(0, 32)}`, !!e && DENIED.test(e), e ?? "allowed");
  }

  console.log("L5 confirmed profile");
  for (const [label, set, arg] of [["address", `"billingAddress" = $2`, "יפו 5"], ["phone", `"billingPhone" = $2`, "0531111111"],
                                   ["email", `"billingEmail" = $2`, "new@lab.invalid"], ["activity", `"category" = $2`, "beauty"]] as const) {
    const e = await fails(() => update(b1, set, arg));
    ok(`L5 ${label} editable`, e === null, e ?? "");
  }
  const e5t = await fails(() => asTenant(b1, (tx) => tx.$executeRawUnsafe(`UPDATE "Business" SET "name" = 'שם מסחרי' WHERE id = $1`, b1)));
  ok("L5 trade name (Business.name) editable", e5t === null, e5t ?? "");
  for (const [label, set, arg] of [["kind", `"billingBusinessKind" = $2`, "LTD_COMPANY"], ["legal name", `"billingLegalName" = $2`, "אחר"],
                                   ["tax id", `"billingTaxId" = $2`, VALID_B], ["tax id to NULL", `"billingTaxId" = $2`, null]] as const) {
    const e = await fails(() => update(b1, set, arg));
    ok(`L5 ${label} refused (DZL04)`, !!e && /DZL04|LEGAL_IDENTITY_LOCKED/.test(e), e ?? "allowed");
  }
  const e5s = await fails(() => update(b1, `"billingTaxId" = $2, "billingLegalName" = $3`, VALID_A, "דנה כהן"));
  ok("L5 re-writing the same values passes", e5s === null, e5s ?? "");
  ok("L5 identity unchanged", (await profileOf(b1))?.billingTaxId === VALID_A);

  console.log("L6 the confirmation state is server-owned");
  for (const set of [`"legalIdentityConfirmedAt" = NULL, "legalIdentitySource" = NULL`, `"legalIdentitySource" = 'OWNER_CONFIRMED'`]) {
    const e = await fails(() => update(b1, set));
    ok(`L6 UPDATE ${set.slice(0, 30)} refused (DZL03)`, !!e && /DZL03/.test(e), e ?? "allowed");
  }
  const l6 = await legacyBusiness(null);
  const e6 = await fails(() => asTenant(l6.businessId, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","updatedAt","legalIdentityConfirmedAt","legalIdentitySource") VALUES ($1, now(), now(), 'SIGNUP')`, l6.businessId)));
  ok("L6 INSERT with a confirmation refused (DZL03)", !!e6 && /DZL03/.test(e6), e6 ?? "allowed");
  const e6b = await fails(() => asTenant(l6.businessId, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "BusinessProfile" ("businessId","updatedAt","billingTaxId") VALUES ($1, now(), $2)`, l6.businessId, VALID_B)));
  ok("L6 a plain runtime INSERT (today's upsert) still works", e6b === null, e6b ?? "");

  console.log("L7 existing (unconfirmed) profile");
  const l7 = await legacyBusiness(COMPLETE);
  const e7 = await fails(() => update(l7.businessId, `"billingTaxId" = $2, "billingLegalName" = $3, "billingBusinessKind" = $4`, VALID_A, "שם חדש", "AUTHORIZED_DEALER"));
  ok("L7 every field editable before confirmation", e7 === null, e7 ?? "");

  console.log("L8 controlled completion of an existing business");
  const inc = await legacyBusiness({ billingBusinessKind: "EXEMPT_DEALER", billingLegalName: "חסר", billingTaxId: null,
                                     billingAddress: null, billingPhone: null, billingEmail: null });
  ok("L8 INCOMPLETE", (await confirm(inc.businessId, inc.userId)) === "INCOMPLETE");
  const none = await legacyBusiness(null);
  ok("L8 INCOMPLETE without a profile", (await confirm(none.businessId, none.userId)) === "INCOMPLETE");
  const bad = await legacyBusiness({ ...COMPLETE, billingTaxId: INVALID });
  ok("L8 INVALID_TAX_ID", (await confirm(bad.businessId, bad.userId)) === "INVALID_TAX_ID");
  const good = await legacyBusiness(COMPLETE);
  const other = await legacyBusiness(COMPLETE);
  ok("L8 NOT_ALLOWED for another business's user", (await confirm(good.businessId, other.userId)) === "NOT_ALLOWED");
  ok("L8 NOT_ALLOWED without a tenant context", (await confirm(null, good.userId)) === "NOT_ALLOWED");
  const deleting = await legacyBusiness(COMPLETE, { deleting: true });
  ok("L8 NOT_ALLOWED for a business in deletion", (await confirm(deleting.businessId, deleting.userId)) === "NOT_ALLOWED");
  ok("L8 CONFIRMED", (await confirm(good.businessId, good.userId)) === "CONFIRMED");
  ok("L8 ALREADY_CONFIRMED", (await confirm(good.businessId, good.userId)) === "ALREADY_CONFIRMED");
  const pg = await profileOf(good.businessId);
  ok("L8 values untouched, source OWNER_CONFIRMED", pg?.billingTaxId === VALID_B && pg?.legalIdentitySource === "OWNER_CONFIRMED");
  const e8 = await fails(() => update(good.businessId, `"billingLegalName" = $2`, "שינוי"));
  ok("L8 locked after confirmation (DZL04)", !!e8 && /DZL04/.test(e8), e8 ?? "allowed");

  console.log("L9 deletion");
  const live = await signup();
  const e9 = await fails(() => asTenant(live, (tx) => tx.$executeRawUnsafe(`DELETE FROM "BusinessProfile" WHERE "businessId" = $1`, live)));
  ok("L9 the runtime cannot delete a confirmed profile (DZL05, or no DELETE grant)", !!e9 && (/DZL05/.test(e9) || DENIED.test(e9)), e9 ?? "allowed");
  const e9a = await fails(() => update(live, `"billingLegalName" = NULL`));
  ok("L9 a live business cannot clear a locked column (DZL04)", !!e9a && /DZL04/.test(e9a), e9a ?? "allowed");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, live);
  const e9b = await fails(() => update(live, `"billingLegalName" = NULL, "billingTaxId" = NULL, "billingPhone" = NULL`));
  ok("L9 the purge clears the locked columns of a business in deletion", e9b === null, e9b ?? "");

  console.log("L10 tenant isolation");
  const a = await signup(); const b = await signup();
  const n10 = await asTenant(a, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingPhone" = '0549999999' WHERE "businessId" = $1`, b));
  ok("L10 tenant A updates 0 rows of B", n10 === 0);
  const seen = (await asTenant(a, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessProfile" WHERE "businessId" = $1`, b))) as Rows;
  ok("L10 tenant A reads 0 rows of B", Number(seen[0].n) === 0);

  console.log("L11 concurrency");
  const race = await legacyBusiness(COMPLETE);
  const results = await Promise.all(Array.from({ length: 10 }, () => confirm(race.businessId, race.userId).catch((e) => `ERR ${msg(e)}`)));
  ok("L11 exactly one CONFIRMED of ten", results.filter((r) => r === "CONFIRMED").length === 1
     && results.filter((r) => r === "ALREADY_CONFIRMED").length === 9, results.join(","));

  console.log("L12 privileges");
  const acl = (await owner.$queryRawUnsafe(`
    SELECT p.proname,
           has_function_privilege('app_auth', p.oid, 'EXECUTE') AS auth,
           has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt,
           (COALESCE(p.proacl::text, '') = '' OR p.proacl::text LIKE '%{=X/%' OR p.proacl::text LIKE '%,=X/%') AS public_exec
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
      ('signup_legal_identity_seed','legal_identity_confirm_existing','legal_identity_tax_id_ok',
       'legal_identity_business_is_being_deleted','legal_identity_lock','legal_identity_no_delete')`)) as Rows;
  const by = Object.fromEntries(acl.map((r) => [r.proname as string, r]));
  ok("L12 six functions exist", acl.length === 6, String(acl.length));
  ok("L12 PUBLIC executes none", acl.every((r) => r.public_exec === false));
  ok("L12 seed: app_auth yes, runtime no", by.signup_legal_identity_seed?.auth === true && by.signup_legal_identity_seed?.rt === false);
  ok("L12 confirm: runtime yes, app_auth no", by.legal_identity_confirm_existing?.rt === true && by.legal_identity_confirm_existing?.auth === false);
  const e12 = await fails(() => asTenant(a, (tx) => tx.$executeRawUnsafe(SEED_SQL, ...SEED(a))));
  ok("L12 the runtime cannot call the seed", !!e12 && DENIED.test(e12), e12 ?? "allowed");
  const e12b = await fails(() => auth.$queryRawUnsafe(`SELECT public.legal_identity_confirm_existing(1)`));
  ok("L12 app_auth cannot call the completion", !!e12b && DENIED.test(e12b), e12b ?? "allowed");

  console.log("L13 check digit agrees with lib/identity/tax-id.ts");
  const vectors = [VALID_A, VALID_B, INVALID, "000000018", "123456789", "111111111", "000000000", "12345678", "99999998"];
  for (const v of vectors) {
    const sql = ((await owner.$queryRawUnsafe(`SELECT public.legal_identity_tax_id_ok($1) AS ok`, v)) as Rows)[0].ok === true;
    const ts = authoritativeTaxId(v) === v; // 9-digit canonical input is valid iff the library returns it unchanged
    ok(`L13 ${v}: sql=${sql} ts=${ts}`, sql === ts);
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), auth.$disconnect(), runtime.$disconnect()]); });
