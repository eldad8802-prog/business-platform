/**
 * Legal identity correction battery — migration 20261128100000_legal_identity_correction against the Production role
 * topology (.sli/lab.sh <db> --with-correction).
 *
 *   OWNER_URL    lab_owner (fixtures, read-back, and the decide function — granted to nobody, so only the owner runs it)
 *   AUTH_URL     te_auth_login, a LOGIN member of app_auth (must hold nothing here)
 *   RUNTIME_URL  app_runtime_prod, a LOGIN member of app_runtime — the business's requests under its tenant context
 *
 *   C1  request refused (DZC01): unconfirmed profile, no profile, another business's user, no tenant context
 *   C2  re-verification (DZC02): too old, in the future, unknown method
 *   C3  a different legal entity (DZC03): sameLegalEntity false, individual ↔ company
 *   C4  invalid values (DZC04) naming the field, never the value: check digit, reason, name length, kind, no change
 *   C5  the kind rule (DZC05): a typo correction cannot change the kind; a kind change cannot change the number
 *   C6  one open request per business (DZC06); ten concurrent submissions → exactly one
 *   C7  append-only: the runtime cannot insert, update, delete or truncate rows directly
 *   C8  tenant isolation of reads
 *   C9  cancel: requester only; twice → NOT_PENDING
 *   C10 decide: four eyes from outside the business (NOT_ALLOWED), a rejection needs a note, REJECTED, NOT_PENDING
 *   C11 approve → APPLIED: the profile holds the requested identity, still confirmed, still locked for the runtime
 *   C12 the identity moved since the request → STALE, nothing applied
 *   C13 nobody but the owner executes decide (runtime and app_auth: permission denied)
 *   C14 erase: refused for a live business; anonymises a business in deletion (no tax id left)
 *   C15 an issued document is untouched by an applied correction (same row version, same frozen snapshot)
 *   C16 a kind change (עוסק פטור → עוסק מורשה, same number) applies
 *   C17 privileges: PUBLIC executes none of the five; app_auth reads nothing
 *
 * Synthetic only. ZERO secrets. ZERO network.
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… npx tsx .sli/correction-battery.ts
 */
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
const TAX_A = withCheckDigit("03141592");
const TAX_B = withCheckDigit("02718281");
const TAX_CO = withCheckDigit("51234567");
const BAD_TAX = TAX_A.slice(0, 8) + String((Number(TAX_A[8]) + 1) % 10);
const BCRYPT = "$2b$10$" + "A".repeat(53);

let seq = 0;
type Biz = { businessId: number; userId: number };
async function business(opts: { kind?: string; legalName?: string; taxId?: string; confirmed?: boolean; profile?: boolean; deleting?: boolean; role?: string } = {}): Promise<Biz> {
  const b = (await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `lic-${++seq}`, opts.deleting ? new Date() : null)) as Rows;
  const businessId = Number(b[0].id);
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt","role") VALUES ($1,$2,'דנה',$3, now(), $4::"UserRole") RETURNING id`,
    `lic-${Date.now()}-${++seq}@lab.invalid`, BCRYPT, businessId, opts.role ?? "USER")) as Rows;
  if (opts.profile !== false) {
    await owner.$executeRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","updatedAt","billingBusinessKind","billingLegalName","billingTaxId",
         "billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource")
       VALUES ($1, now(), $2, $3, $4, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid', $5, $6)`,
      businessId, opts.kind ?? "EXEMPT_DEALER", opts.legalName ?? "דנה כהן", opts.taxId ?? TAX_A,
      opts.confirmed === false ? null : new Date(), opts.confirmed === false ? null : "SIGNUP");
  }
  return { businessId, userId: Number(u[0].id) };
}
async function userOf(businessId: number, role = "USER"): Promise<number> {
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt","role") VALUES ($1,$2,'יוסי',$3, now(), $4::"UserRole") RETURNING id`,
    `lic-${Date.now()}-${++seq}@lab.invalid`, BCRYPT, businessId, role)) as Rows;
  return Number(u[0].id);
}
async function asTenant<T>(businessId: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runtime.$transaction(async (tx) => {
    if (businessId !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(businessId));
    return fn(tx);
  }, TX);
}

type Req = { kind?: string; requestedKind?: string; legalName?: string; taxId?: string; reason?: string; same?: boolean; method?: string; verifiedAt?: Date };
const REQUEST_SQL = `SELECT public.legal_identity_correction_request($1::int, $2, $3, $4, $5, $6, $7::boolean, $8, $9::timestamptz) AS id`;
async function request(ctx: number | null, userId: number, r: Req = {}): Promise<number> {
  return asTenant(ctx, async (tx) => {
    const rows = (await tx.$queryRawUnsafe(REQUEST_SQL, userId, r.kind ?? "TYPO_CORRECTION", r.requestedKind ?? "EXEMPT_DEALER",
      r.legalName ?? "דנה כהן-לוי", r.taxId ?? TAX_A, r.reason ?? "שגיאת הקלדה בשם המשפטי בעת ההרשמה",
      r.same ?? true, r.method ?? "PASSWORD", r.verifiedAt ?? new Date())) as Rows;
    return Number(rows[0].id);
  });
}
const cancel = (ctx: number, userId: number, id: number) =>
  asTenant(ctx, async (tx) => ((await tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_cancel($1::int, $2::int) AS r`, userId, id)) as Rows)[0].r as string);
const decide = async (id: number, approver: number | null, approve: boolean, note: string | null) =>
  ((await owner.$queryRawUnsafe(`SELECT public.legal_identity_correction_decide($1::int, $2::int, $3::boolean, $4) AS r`, id, approver, approve, note)) as Rows)[0].r as string;
const profile = async (businessId: number) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0];
const reqRow = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM "LegalIdentityCorrectionRequest" WHERE id = $1`, id)) as Rows)[0];

async function main() {
  const admin = await business({ role: "PLATFORM_ADMIN" });   // a platform administrator from another business

  console.log("C1 request refused (DZC01)");
  const unconf = await business({ confirmed: false });
  const noProf = await business({ profile: false });
  const a = await business();
  for (const [label, run] of [
    ["unconfirmed profile", () => request(unconf.businessId, unconf.userId)],
    ["no profile", () => request(noProf.businessId, noProf.userId)],
    ["another business's user", () => request(a.businessId, unconf.userId)],
    ["no tenant context", () => request(null, a.userId)],
  ] as const) {
    const e = await fails(run);
    ok(`C1 ${label}`, !!e && /DZC01/.test(e), e ?? "accepted");
  }

  console.log("C2 re-verification (DZC02)");
  for (const [label, r] of [
    ["11 minutes old", { verifiedAt: new Date(Date.now() - 11 * 60_000) }],
    ["5 minutes in the future", { verifiedAt: new Date(Date.now() + 5 * 60_000) }],
    ["unknown method", { method: "SMS" }],
  ] as const) {
    const e = await fails(() => request(a.businessId, a.userId, r));
    ok(`C2 ${label}`, !!e && /DZC02/.test(e), e ?? "accepted");
  }

  console.log("C3 a different legal entity (DZC03)");
  for (const [label, r] of [
    ["sameLegalEntity false", { same: false }],
    ["individual → company", { kind: "BUSINESS_KIND_CHANGE", requestedKind: "LTD_COMPANY" }],
  ] as const) {
    const e = await fails(() => request(a.businessId, a.userId, r));
    ok(`C3 ${label}`, !!e && /DZC03/.test(e), e ?? "accepted");
  }
  const co = await business({ kind: "LTD_COMPANY", legalName: "חברה בע״מ", taxId: TAX_CO });
  const e3 = await fails(() => request(co.businessId, co.userId, { kind: "BUSINESS_KIND_CHANGE", requestedKind: "AUTHORIZED_DEALER", legalName: "חברה בע״מ", taxId: TAX_CO }));
  ok("C3 company → individual", !!e3 && /DZC03/.test(e3), e3 ?? "accepted");

  console.log("C4 invalid values (DZC04), field named, value never echoed");
  for (const [label, r, secret] of [
    ["bad check digit", { taxId: BAD_TAX }, BAD_TAX],
    ["reason shorter than 10", { reason: "קצר" }, null],
    ["legal name over 120", { legalName: "א".repeat(121) }, null],
    ["unknown kind", { requestedKind: "PARTNERSHIP" }, null],
    ["no change", { legalName: "דנה כהן" }, null],
  ] as const) {
    const e = await fails(() => request(a.businessId, a.userId, r as Req));
    ok(`C4 ${label}`, !!e && /DZC04/.test(e) && (!secret || !e.includes(secret)), e ?? "accepted");
  }

  console.log("C5 the kind rule (DZC05)");
  for (const [label, r] of [
    ["typo correction changing the kind", { kind: "TYPO_CORRECTION", requestedKind: "AUTHORIZED_DEALER" }],
    ["kind change changing the number", { kind: "BUSINESS_KIND_CHANGE", requestedKind: "AUTHORIZED_DEALER", taxId: TAX_B }],
  ] as const) {
    const e = await fails(() => request(a.businessId, a.userId, r));
    ok(`C5 ${label}`, !!e && /DZC05/.test(e), e ?? "accepted");
  }

  console.log("C6 one open request per business");
  const first = await request(a.businessId, a.userId);
  ok("C6 a valid request is recorded PENDING with the snapshot", (await reqRow(first))?.status === "PENDING"
     && (await reqRow(first))?.currentLegalName === "דנה כהן" && (await reqRow(first))?.requestedLegalName === "דנה כהן-לוי");
  const e6 = await fails(() => request(a.businessId, a.userId, { legalName: "דנה כ." }));
  ok("C6 a second open request → DZC06", !!e6 && /DZC06/.test(e6), e6 ?? "accepted");
  const race = await business();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    request(race.businessId, race.userId, { legalName: `דנה כהן ${i + 1}` }).then(() => "OK").catch((e) => msg(e))));
  ok("C6 ten concurrent submissions → exactly one", results.filter((r) => r === "OK").length === 1
     && results.filter((r) => /DZC06|23505|unique/i.test(r)).length === 9, results.map((r) => r.slice(0, 20)).join(" | "));

  console.log("C7 append-only for the runtime");
  for (const [label, sql] of [
    ["insert", `INSERT INTO "LegalIdentityCorrectionRequest" ("businessId","requestedByUserId","kind","currentBusinessKind","currentLegalName","currentTaxId","requestedBusinessKind","requestedLegalName","requestedTaxId","reason","sameLegalEntity","verificationMethod","verifiedAt") VALUES (${a.businessId}, ${a.userId}, 'TYPO_CORRECTION', 'EXEMPT_DEALER', 'x', '${TAX_A}', 'EXEMPT_DEALER', 'yy', '${TAX_A}', 'reason long enough', true, 'PASSWORD', now())`],
    ["update", `UPDATE "LegalIdentityCorrectionRequest" SET "status" = 'APPLIED' WHERE "businessId" = ${a.businessId}`],
    ["delete", `DELETE FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = ${a.businessId}`],
    ["truncate", `TRUNCATE "LegalIdentityCorrectionRequest"`],
  ] as const) {
    const e = await fails(() => asTenant(a.businessId, (tx) => tx.$executeRawUnsafe(sql)));
    ok(`C7 runtime ${label} refused`, !!e && (DENIED.test(e) || /DZC07/.test(e)), e ?? "allowed");
  }
  ok("C7 the request is still PENDING", (await reqRow(first))?.status === "PENDING");

  console.log("C8 tenant isolation");
  const seenA = (await asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "LegalIdentityCorrectionRequest"`))) as Rows;
  const seenB = (await asTenant(race.businessId, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = $1`, a.businessId))) as Rows;
  const seenNone = (await asTenant(null, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "LegalIdentityCorrectionRequest"`))) as Rows;
  ok("C8 a business reads its own requests", Number(seenA[0].n) === 1);
  ok("C8 another tenant reads none of them", Number(seenB[0].n) === 0);
  ok("C8 no tenant context reads nothing", Number(seenNone[0].n) === 0);

  console.log("C9 cancel");
  const colleague = await userOf(a.businessId);
  ok("C9 another user of the business → NOT_FOUND", (await cancel(a.businessId, colleague, first)) === "NOT_FOUND");
  ok("C9 the requester → CANCELLED", (await cancel(a.businessId, a.userId, first)) === "CANCELLED");
  ok("C9 again → NOT_PENDING", (await cancel(a.businessId, a.userId, first)) === "NOT_PENDING");

  console.log("C10 decide: four eyes, notes, finality");
  const r10 = await request(a.businessId, a.userId, { legalName: "דנה כהן-לוי" });
  const plain = await userOf(admin.businessId);                 // not a platform admin
  const insiderAdmin = await userOf(a.businessId, "PLATFORM_ADMIN");
  ok("C10 a non-admin → NOT_ALLOWED", (await decide(r10, plain, true, null)) === "NOT_ALLOWED");
  ok("C10 the requester → NOT_ALLOWED", (await decide(r10, a.userId, true, null)) === "NOT_ALLOWED");
  ok("C10 an admin who belongs to the business → NOT_ALLOWED", (await decide(r10, insiderAdmin, true, null)) === "NOT_ALLOWED");
  ok("C10 a rejection without a note → NOTE_REQUIRED", (await decide(r10, admin.userId, false, " ")) === "NOTE_REQUIRED");
  ok("C10 rejected with a note → REJECTED", (await decide(r10, admin.userId, false, "לא צורף אישור רשמי")) === "REJECTED");
  ok("C10 decided again → NOT_PENDING", (await decide(r10, admin.userId, true, null)) === "NOT_PENDING");
  const row10 = await reqRow(r10);
  ok("C10 the rejection is on record (who, when, note)", Number(row10?.decidedByUserId) === admin.userId && row10?.decidedAt instanceof Date && row10?.decisionNote === "לא צורף אישור רשמי");
  ok("C10 the profile is unchanged", (await profile(a.businessId))?.billingLegalName === "דנה כהן");

  console.log("C11 + C15 approve applies; issued documents untouched");
  const doc = (await owner.$queryRawUnsafe(
    `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","issuedSnapshot","updatedAt")
     VALUES ($1, 'RECEIPT', 'ISSUED', now(), $2::jsonb, now()) RETURNING id, xmin::text AS v`,
    a.businessId, JSON.stringify({ issuer: { legalName: "דנה כהן", taxId: TAX_A } }))) as Rows;
  const before = (await profile(a.businessId))?.legalIdentityConfirmedAt as Date;
  const r11 = await request(a.businessId, a.userId, { legalName: "דנה כהן-לוי" });
  ok("C11 approved → APPLIED", (await decide(r11, admin.userId, true, null)) === "APPLIED");
  const p11 = await profile(a.businessId);
  ok("C11 the profile holds the requested legal name", p11?.billingLegalName === "דנה כהן-לוי" && p11?.billingTaxId === TAX_A);
  ok("C11 still confirmed, same confirmation instant", (p11?.legalIdentityConfirmedAt as Date)?.getTime() === before.getTime() && p11?.legalIdentitySource === "SIGNUP");
  const e11 = await fails(() => asTenant(a.businessId, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingLegalName" = 'אחר' WHERE "businessId" = $1`, a.businessId)));
  ok("C11 the runtime still cannot change it (DZL04)", !!e11 && /DZL04/.test(e11), e11 ?? "allowed");
  const after = ((await owner.$queryRawUnsafe(`SELECT xmin::text AS v, "issuedSnapshot"::text AS s FROM "BillingDocument" WHERE id = $1`, Number(doc[0].id))) as Rows)[0];
  ok("C15 the issued document: same row version, same frozen snapshot", after.v === doc[0].v && String(after.s).includes("דנה כהן") && !String(after.s).includes("לוי"));

  console.log("C12 STALE");
  const s = await business();
  const r12 = await request(s.businessId, s.userId, { legalName: "שם מבוקש" });
  await owner.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingLegalName" = 'שם אחר' WHERE "businessId" = $1`, s.businessId);
  ok("C12 the identity moved → STALE", (await decide(r12, admin.userId, true, null)) === "STALE");
  ok("C12 nothing applied", (await profile(s.businessId))?.billingLegalName === "שם אחר" && (await reqRow(r12))?.status === "STALE");

  console.log("C13 decide is granted to nobody");
  const r13 = await request(race.businessId, race.userId, { legalName: "בדיקה" }).catch(() => null);
  const target = r13 ?? r12;
  const e13a = await fails(() => asTenant(race.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_decide($1::int, $2::int, true, NULL)`, target, admin.userId)));
  const e13b = await fails(() => auth.$queryRawUnsafe(`SELECT public.legal_identity_correction_decide($1::int, $2::int, true, NULL)`, target, admin.userId));
  ok("C13 the runtime cannot execute decide", !!e13a && DENIED.test(e13a), e13a ?? "allowed");
  ok("C13 app_auth cannot execute decide", !!e13b && DENIED.test(e13b), e13b ?? "allowed");

  console.log("C14 erase");
  const e14 = await fails(() => asTenant(race.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_erase()`)));
  ok("C14 refused for a live business", !!e14 && /DZC01/.test(e14), e14 ?? "allowed");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, race.businessId);
  const n14 = (await asTenant(race.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_erase() AS n`))) as Rows;
  const left = (await owner.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE "currentTaxId" <> '000000000' OR "requestedTaxId" <> '000000000' OR "anonymisedAt" IS NULL)::int AS bad,
            count(*) FILTER (WHERE "status" = 'PENDING')::int AS open, count(*)::int AS n
       FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = $1`, race.businessId)) as Rows;
  ok("C14 anonymises every request of a business in deletion", Number(n14[0].n) >= 1 && Number(left[0].bad) === 0 && Number(left[0].open) === 0, JSON.stringify(left[0]));

  console.log("C16 a kind change with the same number");
  const k = await business({ kind: "EXEMPT_DEALER" });
  const r16 = await request(k.businessId, k.userId, { kind: "BUSINESS_KIND_CHANGE", requestedKind: "AUTHORIZED_DEALER", legalName: "דנה כהן", taxId: TAX_A, reason: "המעבר מעוסק פטור לעוסק מורשה אושר ברשות המסים" });
  ok("C16 approved → APPLIED", (await decide(r16, admin.userId, true, "נבדק מול תעודת עוסק מורשה")) === "APPLIED");
  const p16 = await profile(k.businessId);
  ok("C16 kind changed, number unchanged", p16?.billingBusinessKind === "AUTHORIZED_DEALER" && p16?.billingTaxId === TAX_A);

  console.log("C17 privileges");
  const acl = (await owner.$queryRawUnsafe(`
    SELECT p.proname, (COALESCE(p.proacl::text, '') = '' OR p.proacl::text LIKE '%{=X/%' OR p.proacl::text LIKE '%,=X/%') AS public_exec
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'legal_identity_correction_%'`)) as Rows;
  ok("C17 five functions, PUBLIC executes none", acl.length === 5 && acl.every((r) => r.public_exec === false), JSON.stringify(acl));
  const e17 = await fails(() => auth.$queryRawUnsafe(`SELECT 1 FROM "LegalIdentityCorrectionRequest" LIMIT 1`));
  ok("C17 app_auth reads nothing", !!e17 && DENIED.test(e17), e17 ?? "allowed");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), auth.$disconnect(), runtime.$disconnect()]); });
