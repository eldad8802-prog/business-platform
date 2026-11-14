/**
 * Legal identity correction battery — migration 20261128100000_legal_identity_correction against the Production role
 * topology (.sli/lab.sh <db> --with-correction).
 *
 *   OWNER_URL    lab_owner (fixtures, read-back; the only writer of LegalIdentityApprover)
 *   AUTH_URL     te_auth_login, a LOGIN member of app_auth (must hold nothing here)
 *   RUNTIME_URL  app_runtime_prod, a LOGIN member of app_runtime — the business's calls AND the admin decision, both
 *                inside the request's tenant transaction
 *   ADMIN_URL    lic_admin_login, a LOGIN member of app_admin — the platform-admin read plane
 *
 *   C1  request refused (DZC01): unconfirmed profile, no profile, another business's user, no tenant context
 *   C2  re-verification (DZC02): too old, in the future, unknown method
 *   C3  a different legal entity (DZC03): sameLegalEntity false, individual ↔ company
 *   C4  invalid values (DZC04) naming the field, never the value
 *   C5  the kind rule (DZC05)
 *   C6  one open request per business (DZC06); ten concurrent submissions → exactly one
 *   C7  append-only: the runtime cannot write either table directly
 *   C8  tenant isolation of reads
 *   C9  cancel: requester only; twice → NOT_PENDING
 *   C10 the dedicated permission: no LegalIdentityApprover row / not PLATFORM_ADMIN / the requester / a user of the
 *       business / the wrong tenant context / no tenant context → NOT_ALLOWED; notes required; REJECTED; NOT_PENDING
 *   C11 approve → APPLIED: the profile holds the requested identity, still confirmed, still locked for the runtime
 *   C12 the identity moved since the request → STALE, nothing applied
 *   C13 privileges: app_auth executes nothing; the internal approver check is executable by nobody
 *   C14 erase: refused for a live business; anonymises requests (all personal columns and notes NULL) and attachments
 *       (key and hash NULL) of a business in deletion
 *   C15 an issued document is untouched by an applied correction
 *   C16 a kind change (עוסק פטור → עוסק מורשה, same number) applies
 *   C17 PUBLIC executes none of the eight; app_auth reads nothing
 *   C18 the runtime never reads internalNote nor decidedByUserId (nor SELECT *); it reads publicNote and status
 *   C19 request_info: approver only, note required, REQUESTED keeps the request open, NOT_PENDING after a decision
 *   C20 attachments: valid; the runtime reads them; at most 5 (DZC08); key prefix / traversal / type / size / hash (DZC04);
 *       a business being deleted (DZC01);
 *       requester only and own tenant (DZC01); not after the request closed (DZC09); one row per key (23505)
 *   C21 LegalIdentityApprover is unreadable and unwritable for every application role
 *   C22 app_admin reads requests (internal note included) and attachments, writes nothing, executes nothing
 *   C23 a live issuer declaration (20261126100000) blocks the apply: DECLARATION_ACTIVE, nothing applied, still PENDING;
 *       an anonymised one does not block; rejecting is still possible
 *
 * Synthetic only. ZERO secrets. ZERO network.
 *   OWNER_URL=… AUTH_URL=… RUNTIME_URL=… ADMIN_URL=… npx tsx .sli/correction-battery.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string, n: number) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=${n}&pool_timeout=60`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const auth = new PrismaClient({ datasourceUrl: process.env.AUTH_URL! });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!, 12) });
const admin = new PrismaClient({ datasourceUrl: process.env.ADMIN_URL! });

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
const SHA = "a".repeat(64);
const PUB = "הבקשה נבדקה מול המסמכים שצורפו";
const INTERNAL = "נבדק מול תעודת עוסק; תואם";

let seq = 0;
type Biz = { businessId: number; userId: number };
async function business(opts: { kind?: string; legalName?: string; taxId?: string; confirmed?: boolean; profile?: boolean; deleting?: boolean; role?: string } = {}): Promise<Biz> {
  const b = (await owner.$queryRawUnsafe(
    `INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `lic-${++seq}`, opts.deleting ? new Date() : null)) as Rows;
  const businessId = Number(b[0].id);
  const userId = await userOf(businessId, opts.role ?? "USER");
  if (opts.profile !== false) {
    await owner.$executeRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","updatedAt","billingBusinessKind","billingLegalName","billingTaxId",
         "billingAddress","billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource")
       VALUES ($1, now(), $2, $3, $4, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid', $5, $6)`,
      businessId, opts.kind ?? "EXEMPT_DEALER", opts.legalName ?? "דנה כהן", opts.taxId ?? TAX_A,
      opts.confirmed === false ? null : new Date(), opts.confirmed === false ? null : "SIGNUP");
  }
  return { businessId, userId };
}
async function userOf(businessId: number, role = "USER"): Promise<number> {
  const u = (await owner.$queryRawUnsafe(
    `INSERT INTO "User" ("email","password","name","businessId","updatedAt","role") VALUES ($1,$2,'יוסי',$3, now(), $4::"UserRole") RETURNING id`,
    `lic-${Date.now()}-${++seq}@lab.invalid`, BCRYPT, businessId, role)) as Rows;
  return Number(u[0].id);
}
const grantApprover = (userId: number) =>
  owner.$executeRawUnsafe(`INSERT INTO "LegalIdentityApprover" ("userId", "note") VALUES ($1, 'lab')`, userId);
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
const decide = (ctx: number | null, id: number, approver: number | null, approve: boolean, pub: string | null = PUB, internal: string | null = INTERNAL) =>
  asTenant(ctx, async (tx) => ((await tx.$queryRawUnsafe(
    `SELECT public.legal_identity_correction_decide($1::int, $2::int, $3::boolean, $4, $5) AS r`, id, approver, approve, pub, internal)) as Rows)[0].r as string);
const requestInfo = (ctx: number | null, id: number, approver: number | null, note: string | null) =>
  asTenant(ctx, async (tx) => ((await tx.$queryRawUnsafe(
    `SELECT public.legal_identity_correction_request_info($1::int, $2::int, $3) AS r`, id, approver, note)) as Rows)[0].r as string);
const attach = (ctx: number | null, userId: number, id: number, key: string, mime = "application/pdf", size = 1000, sha = SHA) =>
  asTenant(ctx, async (tx) => Number(((await tx.$queryRawUnsafe(
    `SELECT public.legal_identity_correction_attach($1::int, $2::int, $3, $4, $5::int, $6) AS id`, userId, id, key, mime, size, sha)) as Rows)[0].id));
const keyFor = (businessId: number, id: number, n: number | string) => `biz/${businessId}/legal-identity/${id}/${n}.pdf`;
const profile = async (businessId: number) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM "BusinessProfile" WHERE "businessId" = $1`, businessId)) as Rows)[0];
const reqRow = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT * FROM "LegalIdentityCorrectionRequest" WHERE id = $1`, id)) as Rows)[0];

async function main() {
  // An approver: a PLATFORM_ADMIN of another business, holding a LegalIdentityApprover row.
  const ops = await business({ role: "PLATFORM_ADMIN" });
  await grantApprover(ops.userId);
  const approver = ops.userId;

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
  const r1 = await reqRow(first);
  ok("C6 a valid request is recorded PENDING with the snapshot", r1?.status === "PENDING" && r1?.currentLegalName === "דנה כהן" && r1?.requestedLegalName === "דנה כהן-לוי");
  const e6 = await fails(() => request(a.businessId, a.userId, { legalName: "דנה כ." }));
  ok("C6 a second open request → DZC06", !!e6 && /DZC06/.test(e6), e6 ?? "accepted");
  const race = await business();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    request(race.businessId, race.userId, { legalName: `דנה כהן ${i + 1}` }).then(() => "OK").catch((e) => msg(e))));
  ok("C6 ten concurrent submissions → exactly one", results.filter((r) => r === "OK").length === 1
     && results.filter((r) => /DZC06|23505|unique/i.test(r)).length === 9, results.map((r) => r.slice(0, 20)).join(" | "));

  console.log("C7 append-only for the runtime");
  const aKey0 = keyFor(a.businessId, first, "seed");
  await attach(a.businessId, a.userId, first, aKey0);
  for (const [label, sql] of [
    ["insert request", `INSERT INTO "LegalIdentityCorrectionRequest" ("businessId","requestedByUserId","kind","currentBusinessKind","currentLegalName","currentTaxId","requestedBusinessKind","requestedLegalName","requestedTaxId","reason","sameLegalEntity","verificationMethod","verifiedAt") VALUES (${a.businessId}, ${a.userId}, 'TYPO_CORRECTION', 'EXEMPT_DEALER', 'x', '${TAX_A}', 'EXEMPT_DEALER', 'yy', '${TAX_A}', 'reason long enough', true, 'PASSWORD', now())`],
    ["update request", `UPDATE "LegalIdentityCorrectionRequest" SET "status" = 'APPLIED' WHERE "businessId" = ${a.businessId}`],
    ["delete request", `DELETE FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = ${a.businessId}`],
    ["truncate requests", `TRUNCATE "LegalIdentityCorrectionRequest"`],
    ["insert attachment", `INSERT INTO "LegalIdentityCorrectionAttachment" ("requestId","businessId","storageKey","mimeType","sizeBytes","sha256","uploadedByUserId") VALUES (${first}, ${a.businessId}, '${keyFor(a.businessId, first, "x")}', 'application/pdf', 1, '${SHA}', ${a.userId})`],
    ["update attachment", `UPDATE "LegalIdentityCorrectionAttachment" SET "sizeBytes" = 2 WHERE "businessId" = ${a.businessId}`],
    ["delete attachment", `DELETE FROM "LegalIdentityCorrectionAttachment" WHERE "businessId" = ${a.businessId}`],
  ] as const) {
    const e = await fails(() => asTenant(a.businessId, (tx) => tx.$executeRawUnsafe(sql)));
    ok(`C7 runtime ${label} refused`, !!e && (DENIED.test(e) || /DZC07/.test(e)), e ?? "allowed");
  }
  ok("C7 the request is still PENDING", (await reqRow(first))?.status === "PENDING");

  console.log("C8 tenant isolation");
  const countAs = async (ctx: number | null, table: string, where = "") =>
    Number(((await asTenant(ctx, (tx) => tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}" ${where}`))) as Rows)[0].n);
  ok("C8 a business reads its own requests", (await countAs(a.businessId, "LegalIdentityCorrectionRequest")) === 1);
  ok("C8 another tenant reads none of them", (await countAs(race.businessId, "LegalIdentityCorrectionRequest", `WHERE "businessId" = ${a.businessId}`)) === 0);
  ok("C8 no tenant context reads nothing", (await countAs(null, "LegalIdentityCorrectionRequest")) === 0);
  ok("C8 attachments: own yes, other tenant none", (await countAs(a.businessId, "LegalIdentityCorrectionAttachment")) === 1
     && (await countAs(race.businessId, "LegalIdentityCorrectionAttachment", `WHERE "businessId" = ${a.businessId}`)) === 0);

  console.log("C9 cancel");
  const colleague = await userOf(a.businessId);
  ok("C9 another user of the business → NOT_FOUND", (await cancel(a.businessId, colleague, first)) === "NOT_FOUND");
  ok("C9 the requester → CANCELLED", (await cancel(a.businessId, a.userId, first)) === "CANCELLED");
  ok("C9 again → NOT_PENDING", (await cancel(a.businessId, a.userId, first)) === "NOT_PENDING");

  console.log("C10 the dedicated permission, notes, finality");
  const r10 = await request(a.businessId, a.userId, { legalName: "דנה כהן-לוי" });
  const plainAdmin = await userOf(ops.businessId, "PLATFORM_ADMIN");     // PLATFORM_ADMIN without an approver row
  const rowNoAdmin = await userOf(ops.businessId, "USER");               // an approver row without the role
  await grantApprover(rowNoAdmin);
  const insider = await userOf(a.businessId, "PLATFORM_ADMIN");          // approver of the business itself
  await grantApprover(insider);
  ok("C10 a PLATFORM_ADMIN without a LegalIdentityApprover row → NOT_ALLOWED", (await decide(a.businessId, r10, plainAdmin, true)) === "NOT_ALLOWED");
  ok("C10 an approver row without PLATFORM_ADMIN → NOT_ALLOWED", (await decide(a.businessId, r10, rowNoAdmin, true)) === "NOT_ALLOWED");
  ok("C10 the requester → NOT_ALLOWED", (await decide(a.businessId, r10, a.userId, true)) === "NOT_ALLOWED");
  ok("C10 an approver who belongs to the business → NOT_ALLOWED", (await decide(a.businessId, r10, insider, true)) === "NOT_ALLOWED");
  ok("C10 a valid approver in another tenant's transaction → NOT_ALLOWED", (await decide(race.businessId, r10, approver, true)) === "NOT_ALLOWED");
  ok("C10 a valid approver without a tenant context → NOT_ALLOWED", (await decide(null, r10, approver, true)) === "NOT_ALLOWED");
  ok("C10 reject without a public note → NOTE_REQUIRED", (await decide(a.businessId, r10, approver, false, " ", INTERNAL)) === "NOTE_REQUIRED");
  ok("C10 reject without an internal note → NOTE_REQUIRED", (await decide(a.businessId, r10, approver, false, PUB, null)) === "NOTE_REQUIRED");
  ok("C10 approve without an internal note → NOTE_REQUIRED", (await decide(a.businessId, r10, approver, true, PUB, "abc")) === "NOTE_REQUIRED");
  ok("C10 rejected with both notes → REJECTED", (await decide(a.businessId, r10, approver, false, "לא צורף אישור רשמי", "חסר מסמך רשם")) === "REJECTED");
  ok("C10 decided again → NOT_PENDING", (await decide(a.businessId, r10, approver, true)) === "NOT_PENDING");
  const row10 = await reqRow(r10);
  ok("C10 the rejection is on record (who, when, public + internal note)", Number(row10?.decidedByUserId) === approver && row10?.decidedAt instanceof Date
     && row10?.publicNote === "לא צורף אישור רשמי" && row10?.internalNote === "חסר מסמך רשם");
  ok("C10 the profile is unchanged", (await profile(a.businessId))?.billingLegalName === "דנה כהן");

  console.log("C18 the runtime's view of a request");
  for (const col of ["internalNote", "decidedByUserId"]) {
    const e = await fails(() => asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT "${col}" FROM "LegalIdentityCorrectionRequest" WHERE id = $1`, r10)));
    ok(`C18 the runtime cannot read ${col}`, !!e && DENIED.test(e), e ?? "allowed");
  }
  const eStar = await fails(() => asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT * FROM "LegalIdentityCorrectionRequest" WHERE id = $1`, r10)));
  ok("C18 the runtime cannot SELECT *", !!eStar && DENIED.test(eStar), eStar ?? "allowed");
  const seen = (await asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT "status", "publicNote", "decidedAt" FROM "LegalIdentityCorrectionRequest" WHERE id = $1`, r10))) as Rows;
  ok("C18 the runtime reads status and the public note", seen[0]?.status === "REJECTED" && seen[0]?.publicNote === "לא צורף אישור רשמי");

  console.log("C19 request more information");
  const r19 = await request(a.businessId, a.userId, { legalName: "דנה כהן-לוי" });
  ok("C19 a non-approver → NOT_ALLOWED", (await requestInfo(a.businessId, r19, plainAdmin, "נא לצרף תעודה")) === "NOT_ALLOWED");
  ok("C19 another tenant's transaction → NOT_ALLOWED", (await requestInfo(race.businessId, r19, approver, "נא לצרף תעודה")) === "NOT_ALLOWED");
  ok("C19 a short note → NOTE_REQUIRED", (await requestInfo(a.businessId, r19, approver, "לא")) === "NOTE_REQUIRED");
  ok("C19 → REQUESTED", (await requestInfo(a.businessId, r19, approver, "נא לצרף תעודת עוסק")) === "REQUESTED");
  const v19 = (await asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT "status", "infoRequestNote", "infoRequestedAt" FROM "LegalIdentityCorrectionRequest" WHERE id = $1`, r19))) as Rows;
  ok("C19 still PENDING, the note visible to the business", v19[0]?.status === "PENDING" && v19[0]?.infoRequestNote === "נא לצרף תעודת עוסק" && v19[0]?.infoRequestedAt instanceof Date);

  console.log("C20 attachments");
  const k = (n: number | string) => keyFor(a.businessId, r19, n);
  const att1 = await attach(a.businessId, a.userId, r19, k(1));
  ok("C20 a valid attachment is recorded", att1 > 0);
  const own = (await asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT "storageKey", "mimeType", "sizeBytes", "sha256" FROM "LegalIdentityCorrectionAttachment" WHERE id = $1`, att1))) as Rows;
  ok("C20 the runtime reads its attachment metadata", own[0]?.storageKey === k(1) && own[0]?.sha256 === SHA);
  for (const [label, run, code] of [
    ["another business's prefix", () => attach(a.businessId, a.userId, r19, keyFor(race.businessId, r19, 9)), /DZC04/],
    ["the prefix alone", () => attach(a.businessId, a.userId, r19, `biz/${a.businessId}/legal-identity/`), /DZC04/],
    ["a traversal", () => attach(a.businessId, a.userId, r19, `biz/${a.businessId}/legal-identity/../x.pdf`), /DZC04/],
    ["a disallowed type", () => attach(a.businessId, a.userId, r19, k("t"), "text/html"), /DZC04/],
    ["an empty file", () => attach(a.businessId, a.userId, r19, k("e"), "application/pdf", 0), /DZC04/],
    ["over 10 MB", () => attach(a.businessId, a.userId, r19, k("b"), "application/pdf", 10485761), /DZC04/],
    ["an upper-case hash", () => attach(a.businessId, a.userId, r19, k("h"), "application/pdf", 10, "A".repeat(64)), /DZC04/],
    ["another user of the business", () => attach(a.businessId, colleague, r19, k("c")), /DZC01/],
    ["another tenant's transaction", () => attach(race.businessId, a.userId, r19, k("o")), /DZC01/],
    ["the same key twice", () => attach(a.businessId, a.userId, r19, k(1)), /23505|unique/i],
  ] as const) {
    const e = await fails(run);
    ok(`C20 refused: ${label}`, !!e && code.test(e), e ?? "accepted");
  }
  for (const n of [2, 3, 4, 5]) await attach(a.businessId, a.userId, r19, k(n), n % 2 ? "image/png" : "image/jpeg", 5000);
  const e6th = await fails(() => attach(a.businessId, a.userId, r19, k(6)));
  ok("C20 a sixth attachment → DZC08", !!e6th && /DZC08/.test(e6th), e6th ?? "accepted");

  console.log("C11 + C15 approve applies; issued documents untouched");
  const doc = (await owner.$queryRawUnsafe(
    `INSERT INTO "BillingDocument" ("businessId","documentType","status","issuedAt","issuedSnapshot","updatedAt")
     VALUES ($1, 'RECEIPT', 'ISSUED', now(), $2::jsonb, now()) RETURNING id, xmin::text AS v`,
    a.businessId, JSON.stringify({ issuer: { legalName: "דנה כהן", taxId: TAX_A } }))) as Rows;
  const before = (await profile(a.businessId))?.legalIdentityConfirmedAt as Date;
  ok("C11 approved → APPLIED", (await decide(a.businessId, r19, approver, true)) === "APPLIED");
  const p11 = await profile(a.businessId);
  ok("C11 the profile holds the requested legal name", p11?.billingLegalName === "דנה כהן-לוי" && p11?.billingTaxId === TAX_A);
  ok("C11 still confirmed, same confirmation instant", (p11?.legalIdentityConfirmedAt as Date)?.getTime() === before.getTime() && p11?.legalIdentitySource === "SIGNUP");
  const e11 = await fails(() => asTenant(a.businessId, (tx) => tx.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingLegalName" = 'אחר' WHERE "businessId" = $1`, a.businessId)));
  ok("C11 the runtime still cannot change it (DZL04)", !!e11 && /DZL04/.test(e11), e11 ?? "allowed");
  const after = ((await owner.$queryRawUnsafe(`SELECT xmin::text AS v, "issuedSnapshot"::text AS s FROM "BillingDocument" WHERE id = $1`, Number(doc[0].id))) as Rows)[0];
  ok("C15 the issued document: same row version, same frozen snapshot", after.v === doc[0].v && String(after.s).includes("דנה כהן") && !String(after.s).includes("לוי"));
  ok("C19 request_info after the decision → NOT_PENDING", (await requestInfo(a.businessId, r19, approver, "נא לצרף תעודה")) === "NOT_PENDING");
  const eClosed = await fails(() => attach(a.businessId, a.userId, r19, k(7)));
  ok("C20 attaching to a decided request → DZC09", !!eClosed && /DZC09/.test(eClosed), eClosed ?? "accepted");

  console.log("C12 STALE");
  const s = await business();
  const r12 = await request(s.businessId, s.userId, { legalName: "שם מבוקש" });
  await owner.$executeRawUnsafe(`UPDATE "BusinessProfile" SET "billingLegalName" = 'שם אחר' WHERE "businessId" = $1`, s.businessId);
  ok("C12 the identity moved → STALE", (await decide(s.businessId, r12, approver, true)) === "STALE");
  ok("C12 nothing applied", (await profile(s.businessId))?.billingLegalName === "שם אחר" && (await reqRow(r12))?.status === "STALE");

  console.log("C23 a live issuer declaration blocks the apply (no bypass of its lock)");
  // The lab ledger does not include 20261126100000_issuer_declaration; decide reads the table dynamically, so a
  // stand-in with the two columns it reads is enough. Created only if absent; dropped again at the end of this case.
  const standIn = ((await owner.$queryRawUnsafe(`SELECT to_regclass('public."BusinessIssuerDeclaration"') IS NULL AS absent`)) as Rows)[0].absent === true;
  if (standIn) await owner.$executeRawUnsafe(`CREATE TABLE public."BusinessIssuerDeclaration" ("businessId" integer NOT NULL, "version" integer NOT NULL, "anonymisedAt" timestamptz NULL)`);
  const d = await business();
  const r23 = await request(d.businessId, d.userId, { legalName: "שם מתוקן" });
  // An older anonymised version and a newer live one: the LATEST decides (as the issuer lock reads it).
  await owner.$executeRawUnsafe(`INSERT INTO public."BusinessIssuerDeclaration" ("businessId", "version", "anonymisedAt") VALUES ($1, 1, now()), ($1, 2, NULL)`, d.businessId);
  const nameBefore = (await profile(d.businessId))?.billingLegalName;
  ok("C23 approve with a live declaration → DECLARATION_ACTIVE", (await decide(d.businessId, r23, approver, true)) === "DECLARATION_ACTIVE");
  ok("C23 nothing applied, the request stays PENDING", (await profile(d.businessId))?.billingLegalName === nameBefore && (await reqRow(r23))?.status === "PENDING");
  await owner.$executeRawUnsafe(`UPDATE public."BusinessIssuerDeclaration" SET "anonymisedAt" = now() WHERE "businessId" = $1`, d.businessId);
  ok("C23 an anonymised declaration does not block → APPLIED", (await decide(d.businessId, r23, approver, true)) === "APPLIED");
  const d2 = await business();
  const r23b = await request(d2.businessId, d2.userId, { legalName: "שם נדחה" });
  await owner.$executeRawUnsafe(`INSERT INTO public."BusinessIssuerDeclaration" ("businessId", "version", "anonymisedAt") VALUES ($1, 1, NULL)`, d2.businessId);
  ok("C23 rejecting is still possible with a live declaration → REJECTED", (await decide(d2.businessId, r23b, approver, false)) === "REJECTED");
  if (standIn) await owner.$executeRawUnsafe(`DROP TABLE public."BusinessIssuerDeclaration"`);

  console.log("C13 privileges");
  for (const [label, sql] of [
    ["decide", `SELECT public.legal_identity_correction_decide(1, 1, true, 'xxxxx', 'xxxxx')`],
    ["request_info", `SELECT public.legal_identity_correction_request_info(1, 1, 'xxxxx')`],
    ["attach", `SELECT public.legal_identity_correction_attach(1, 1, 'k', 'application/pdf', 1, '${SHA}')`],
    ["erase", `SELECT public.legal_identity_correction_erase()`],
  ] as const) {
    const e = await fails(() => auth.$queryRawUnsafe(sql));
    ok(`C13 app_auth cannot execute ${label}`, !!e && DENIED.test(e), e ?? "allowed");
  }
  const eHelper = await fails(() => asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_is_approver($1::int, $2::int)`, approver, r19)));
  ok("C13 the runtime cannot execute the internal approver check", !!eHelper && DENIED.test(eHelper), eHelper ?? "allowed");

  console.log("C21 LegalIdentityApprover is out of every application role's reach");
  for (const [label, client] of [["runtime", null], ["app_auth", auth], ["app_admin", admin]] as const) {
    const read = await fails(() => client ? client.$queryRawUnsafe(`SELECT 1 FROM "LegalIdentityApprover" LIMIT 1`)
                                         : asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT 1 FROM "LegalIdentityApprover" LIMIT 1`)));
    const write = await fails(() => client ? client.$executeRawUnsafe(`INSERT INTO "LegalIdentityApprover" ("userId") VALUES (${a.userId})`)
                                          : asTenant(a.businessId, (tx) => tx.$executeRawUnsafe(`INSERT INTO "LegalIdentityApprover" ("userId") VALUES (${a.userId})`)));
    ok(`C21 ${label} cannot read it`, !!read && DENIED.test(read), read ?? "allowed");
    ok(`C21 ${label} cannot write it`, !!write && DENIED.test(write), write ?? "allowed");
  }

  console.log("C22 the platform-admin read plane (app_admin)");
  const adminRows = (await admin.$queryRawUnsafe(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE "internalNote" IS NOT NULL)::int AS internal FROM "LegalIdentityCorrectionRequest"`)) as Rows;
  const total = Number(((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "LegalIdentityCorrectionRequest"`)) as Rows)[0].n);
  ok("C22 app_admin reads every request, internal notes included", Number(adminRows[0].n) === total && Number(adminRows[0].internal) >= 2, JSON.stringify(adminRows[0]));
  const adminAtt = (await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "LegalIdentityCorrectionAttachment"`)) as Rows;
  ok("C22 app_admin reads attachments", Number(adminAtt[0].n) >= 6);
  const eAdminW = await fails(() => admin.$executeRawUnsafe(`UPDATE "LegalIdentityCorrectionRequest" SET "publicNote" = 'x' WHERE id = ${r19}`));
  ok("C22 app_admin cannot write a request", !!eAdminW && (DENIED.test(eAdminW) || /DZC07/.test(eAdminW)), eAdminW ?? "allowed");
  const eAdminX = await fails(() => admin.$queryRawUnsafe(`SELECT public.legal_identity_correction_decide(1, 1, true, 'xxxxx', 'xxxxx')`));
  ok("C22 app_admin cannot execute decide", !!eAdminX && DENIED.test(eAdminX), eAdminX ?? "allowed");

  console.log("C20 no attachment once the business is being deleted");
  const leaving = await business();
  const rLeave = await request(leaving.businessId, leaving.userId, { legalName: "דנה כהן-לוי" });
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, leaving.businessId);
  const eLeave = await fails(() => attach(leaving.businessId, leaving.userId, rLeave, keyFor(leaving.businessId, rLeave, 1)));
  ok("C20 attaching while the business is being deleted → DZC01", !!eLeave && /DZC01/.test(eLeave), eLeave ?? "accepted");

  console.log("C14 erase");
  const eLive = await fails(() => asTenant(race.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_erase()`)));
  ok("C14 refused for a live business", !!eLive && /DZC01/.test(eLive), eLive ?? "allowed");
  const eNoCtx = await fails(() => asTenant(null, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_erase()`)));
  ok("C14 refused without a tenant context", !!eNoCtx && /DZC01/.test(eNoCtx), eNoCtx ?? "allowed");
  await owner.$executeRawUnsafe(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, a.businessId);
  const n14 = (await asTenant(a.businessId, (tx) => tx.$queryRawUnsafe(`SELECT public.legal_identity_correction_erase() AS n`))) as Rows;
  const leftReq = (await owner.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE "currentLegalName" IS NOT NULL OR "currentTaxId" IS NOT NULL OR "requestedLegalName" IS NOT NULL
                               OR "requestedTaxId" IS NOT NULL OR "reason" IS NOT NULL OR "infoRequestNote" IS NOT NULL
                               OR "publicNote" IS NOT NULL OR "internalNote" IS NOT NULL OR "anonymisedAt" IS NULL)::int AS bad,
            count(*) FILTER (WHERE "status" = 'PENDING')::int AS open, count(*)::int AS n
       FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = $1`, a.businessId)) as Rows;
  ok("C14 every request of a business in deletion: personal columns and notes NULL, none open",
     Number(n14[0].n) >= 3 && Number(leftReq[0].bad) === 0 && Number(leftReq[0].open) === 0, JSON.stringify(leftReq[0]));
  const leftAtt = (await owner.$queryRawUnsafe(
    `SELECT count(*) FILTER (WHERE "storageKey" IS NOT NULL OR "sha256" IS NOT NULL OR "anonymisedAt" IS NULL)::int AS bad, count(*)::int AS n
       FROM "LegalIdentityCorrectionAttachment" WHERE "businessId" = $1`, a.businessId)) as Rows;
  ok("C14 every attachment: key and hash NULL", Number(leftAtt[0].n) >= 6 && Number(leftAtt[0].bad) === 0, JSON.stringify(leftAtt[0]));
  const otherLeft = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "LegalIdentityCorrectionRequest" WHERE "businessId" = $1 AND "anonymisedAt" IS NULL`, race.businessId)) as Rows;
  ok("C14 another business's requests are untouched", Number(otherLeft[0].n) >= 1);

  console.log("C16 a kind change with the same number");
  const kb = await business({ kind: "EXEMPT_DEALER" });
  const r16 = await request(kb.businessId, kb.userId, { kind: "BUSINESS_KIND_CHANGE", requestedKind: "AUTHORIZED_DEALER", legalName: "דנה כהן", taxId: TAX_A, reason: "המעבר מעוסק פטור לעוסק מורשה אושר ברשות המסים" });
  ok("C16 approved → APPLIED", (await decide(kb.businessId, r16, approver, true, "השינוי בוצע", "נבדק מול תעודת עוסק מורשה")) === "APPLIED");
  const p16 = await profile(kb.businessId);
  ok("C16 kind changed, number unchanged", p16?.billingBusinessKind === "AUTHORIZED_DEALER" && p16?.billingTaxId === TAX_A);

  console.log("C17 privileges");
  const acl = (await owner.$queryRawUnsafe(`
    SELECT p.proname, (COALESCE(p.proacl::text, '') = '' OR p.proacl::text LIKE '%{=X/%' OR p.proacl::text LIKE '%,=X/%') AS public_exec
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'legal_identity_correction_%'`)) as Rows;
  ok("C17 eight functions, PUBLIC executes none", acl.length === 8 && acl.every((r) => r.public_exec === false), JSON.stringify(acl));
  const e17 = await fails(() => auth.$queryRawUnsafe(`SELECT 1 FROM "LegalIdentityCorrectionRequest" LIMIT 1`));
  ok("C17 app_auth reads nothing", !!e17 && DENIED.test(e17), e17 ?? "allowed");

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await Promise.all([owner.$disconnect(), auth.$disconnect(), runtime.$disconnect(), admin.$disconnect()]); });
