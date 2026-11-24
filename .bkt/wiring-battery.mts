/**
 * 4a T1 wiring — INTEGRATED battery on the REAL migration 20261225090000_kind_transition_issuer_declaration_wiring
 * (.bkt/lab.sh <db> --with-wiring: Production's role topology; the declaration, DZ010, the transition and 4a T1/T1a
 * built by `prisma migrate deploy`, then the wiring migration by `prisma migrate deploy`). Not the proposed SQL.
 *
 *   OWNER_URL    lab_owner (table owner, BYPASSRLS, not superuser) — fixtures and read-back only
 *   RUNTIME_URL  app_runtime_prod (NOBYPASSRLS LOGIN member of app_runtime) — every transition call
 *
 *   I1  the migration is in the ledger with the file's checksum; the deployed body IS the migration's body; owner,
 *       SECURITY DEFINER, search_path and the ACL are unchanged (runtime: the transition only, never the writer)
 *   I2  a declared business transitions: v2 STATUS_CHANGE with the transition's own digest / re-auth / instant;
 *       v1, every issued document (three types, snapshots + hashes + numbers) byte-identical; DZ010 still refuses
 *       any edit of an issued document; the number sequences are not touched
 *   I3  full rollback: a failure at the history row, at the profile update, and the function's own DZL07 (profile
 *       not updated) — each AFTER v2 was filed — leaves nothing (no v2, no history, profile exempt); the business
 *       transitions normally afterwards
 *   I4  equivalence: for every business WITHOUT a live declaration (and every refusal before the writer) the wired
 *       function answers exactly what 20261221090000 answers, with the same effects. The old body runs side by side
 *       as a lab-only function generated from the 20261221090000 file (dropped at the end); each call is rolled back
 *   I5  businesses that do not transition: every row of BusinessProfile / BusinessIssuerDeclaration /
 *       BusinessKindTransition / BillingDocument outside the transitioned businesses is identical before and after
 *       (whole-table fingerprint), plus named controls
 *
 * Synthetic only. ZERO secrets. ZERO network.
 *   OWNER_URL=… RUNTIME_URL=… npx tsx .bkt/wiring-battery.mts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { PrismaClient, type Prisma } from "@prisma/client";

globalThis.fetch = (async () => { throw new Error("network disabled in this lab"); }) as typeof fetch;

const WIRE = "20261225090000_kind_transition_issuer_declaration_wiring";
const OLD = "20261221090000_business_kind_transition";
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail !== "" ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}
type Row = Record<string, unknown>;
type Tx = Prisma.TransactionClient;
const TX = { timeout: 60_000, maxWait: 60_000 };
const ROLLBACK = new Error("deliberate rollback");
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300);
const ms = (x: unknown) => (x instanceof Date ? x : new Date(String(x))).getTime();

function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const ACKS = ["registered_with_vat_authority", "same_legal_entity", "issued_documents_unchanged", "new_documents_as_authorized", "not_reversible_in_dubiz"];
const statementSha = (f: { businessId: number; actorUserId: number; legalName: string; taxId: string; vatNumber: string; date: string }) =>
  createHash("sha256").update([
    "statement=kind-transition-exempt-to-authorized-v1", `business=${f.businessId}`, `actor=${f.actorUserId}`,
    "from=EXEMPT_DEALER", "to=AUTHORIZED_DEALER", `legalName=${f.legalName}`, `taxId=${f.taxId}`, `vatNumber=${f.vatNumber}`,
    `statusEffectiveDate=${f.date}`, ...ACKS.map((a) => `ack=${a}`),
  ].join("\n"), "utf8").digest("hex");
const israelToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date());
const addDays = (ymd: string, d: number) => { const t = new Date(`${ymd}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };

/** The function body between the $fn$ markers of a migration file (LF). */
function bodyOf(file: string): string {
  const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const a = src.indexOf("CREATE OR REPLACE FUNCTION public.business_kind_transition_to_authorized(");
  const s = src.indexOf("$fn$", a) + 4;
  return src.slice(s, src.indexOf("$fn$", s));
}

// ---------------------------------------------------------------- fixtures (owner)
const stamp = Date.now();
let n = 0;
const LEGAL_NAME = "דנה כהן";
const taxFor = (k: number) => withCheckDigit(String(30_000_000 + ((stamp + k * 7919) % 9_000_000)).slice(0, 8));
type Biz = { businessId: number; userId: number; taxId: string };
async function business(o: { kind?: string | null; users?: number; deleting?: boolean; profile?: boolean } = {}): Promise<Biz> {
  const kind = o.kind === undefined ? "EXEMPT_DEALER" : o.kind;
  const taxId = taxFor(++n);
  const b = (await owner.$queryRawUnsafe(`INSERT INTO "Business" ("name","updatedAt","deletionRequestedAt") VALUES ($1, now(), $2) RETURNING id`,
    `ktw-${stamp}-${n}`, o.deleting ? new Date() : null)) as Row[];
  const businessId = Number(b[0].id);
  let userId = 0;
  for (let i = 0; i < (o.users ?? 1); i++) {
    const u = (await owner.$queryRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'דנה',$3, now()) RETURNING id`,
      `ktw-${stamp}-${n}-${i}@lab.invalid`, "$2b$10$" + "A".repeat(53), businessId)) as Row[];
    if (i === 0) userId = Number(u[0].id);
  }
  if (o.profile !== false) {
    await owner.$executeRawUnsafe(
      `INSERT INTO "BusinessProfile" ("businessId","billingBusinessKind","billingLegalName","billingTaxId","billingVatNumber","billingAddress",
         "billingPhone","billingEmail","legalIdentityConfirmedAt","legalIdentitySource","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'הרצל 1, תל אביב','0501234567','biz@lab.invalid', now(), 'SIGNUP', now())`,
      businessId, kind, LEGAL_NAME, taxId, kind === "AUTHORIZED_DEALER" ? taxId : null);
  }
  return { businessId, userId, taxId };
}
async function declare(b: Biz, o: { authorized?: boolean; anonymised?: boolean } = {}) {
  const ex = !o.authorized;
  const r = (await owner.$queryRawUnsafe(
    `INSERT INTO "BusinessIssuerDeclaration" ("businessId","version","kind","track","legalForm","vatStatus","legalName","idType","idNumber","vatRegistrationNumber",
       "address","phone","email","effectiveFrom","authorizedUserId","authorityBasis","declaredByUserId","declarantName","declarantCapacity",
       "statementVersion","statementSha256","reauthMethod","reauthAt")
     VALUES ($1, 1, 'INITIAL', $2::"IssuerTrack", 'INDIVIDUAL', $3::"IssuerVatStatus", $4, 'ISRAELI_ID', $5, $6, 'הרצל 1, תל אביב', '0501234567', 'biz@lab.invalid',
       now() - interval '1 day', $7, 'SOLE_USER_VERIFIED', $7, 'דנה כהן', 'בעלים', 'issuer-statement-v1', $8, 'EMAIL_LINK', now() - interval '1 day') RETURNING id`,
    b.businessId, ex ? "EXEMPT_DEALER" : "AUTHORIZED_DEALER_INDIVIDUAL", ex ? "EXEMPT" : "AUTHORIZED", LEGAL_NAME, b.taxId, ex ? null : b.taxId, b.userId, "c".repeat(64))) as Row[];
  if (o.anonymised) {
    await owner.$executeRawUnsafe(
      `UPDATE "BusinessIssuerDeclaration" SET "legalName"='—',"tradeName"=NULL,"idNumber"='000000000',"address"='—',"phone"='—',"email"='erased@invalid',
         "declarantName"='—',"declarantCapacity"='—',"anonymisedAt"=now() WHERE "businessId" = $1`, b.businessId);
  }
  return Number(r[0].id);
}
/** A second user joins AFTER the declaration (the declaration itself requires a sole user, DZD33). */
async function addUser(b: Biz) {
  await owner.$executeRawUnsafe(`INSERT INTO "User" ("email","password","name","businessId","updatedAt") VALUES ($1,$2,'בני',$3, now())`,
    `ktw-${stamp}-${b.businessId}-extra@lab.invalid`, "$2b$10$" + "A".repeat(53), b.businessId);
}
let docNo = 500;
async function issuedDoc(b: Biz, type: string) {
  const snapshot = { issuer: { legalName: LEGAL_NAME, taxId: b.taxId }, extensions: { billingBusinessKind: "EXEMPT_DEALER" }, type };
  const d = (await owner.$queryRawUnsafe(
    `INSERT INTO "BillingDocument" ("businessId","documentType","status","documentNumber","issuedAt","issuedSnapshot","legalSnapshotHash","updatedAt")
     VALUES ($1,$2::"BillingDocumentType",'ISSUED',$3, now() - interval '3 days', $4::jsonb, $5, now() - interval '3 days') RETURNING id`,
    b.businessId, type, ++docNo, json(snapshot), createHash("sha256").update(json(snapshot)).digest("hex"))) as Row[];
  return Number(d[0].id);
}
const rows = async (table: string, businessId: number, order = "id") =>
  (await owner.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "businessId" = $1 ORDER BY "${order}"`, businessId)) as Row[];
const snap = async (businessId: number) => json({
  p: await rows("BusinessProfile", businessId), d: await rows("BusinessIssuerDeclaration", businessId, "version"),
  t: await rows("BusinessKindTransition", businessId), docs: await rows("BillingDocument", businessId),
});

type Call = { fn?: string; user?: number; vat?: string | null; date?: string | null; method?: string | null; at?: Date | null; sha?: string | null; ctx?: number | null };
function callArgs(b: Biz, c: Call) {
  const user = c.user ?? b.userId;
  const vat = c.vat === undefined ? b.taxId : c.vat;
  const date = c.date === undefined ? israelToday() : c.date;
  const sha = c.sha === undefined ? statementSha({ businessId: b.businessId, actorUserId: user, legalName: LEGAL_NAME, taxId: b.taxId, vatNumber: vat ?? "", date: date ?? "" }) : c.sha;
  return [user, vat, date, c.method === undefined ? "PASSWORD" : c.method, c.at === undefined ? new Date() : c.at, sha] as const;
}
async function callIn(tx: Tx, b: Biz, c: Call): Promise<string> {
  const ctx = c.ctx === undefined ? b.businessId : c.ctx;
  if (ctx !== null) await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(ctx));
  const r = (await tx.$queryRawUnsafe(`SELECT public.${c.fn ?? "business_kind_transition_to_authorized"}($1::int, $2, $3::date, $4, $5::timestamptz, $6) AS r`,
    ...callArgs(b, c))) as Row[];
  return String(r[0].r);
}
/** A committed transition as the application makes it (runtime, tenant transaction). */
const transition = (b: Biz, c: Call = {}) => runtime.$transaction((tx) => callIn(tx, b, c), TX);

/** Effects of one call, normalised (ids / clock columns out), read inside the same transaction, then rolled back. */
async function dryRun(b: Biz, c: Call): Promise<{ r: string; effects: string }> {
  let out: { r: string; effects: string } | null = null;
  try {
    await runtime.$transaction(async (tx) => {
      const r = await callIn(tx, b, c);
      // The runtime reads its own tenant's rows (the history under RLS; the profile through its SELECT grant).
      const p = (await tx.$queryRawUnsafe(`SELECT "billingBusinessKind" k, "billingVatNumber" v, "billingLegalName" n, "billingTaxId" t,
          "legalIdentityConfirmedAt" c, "legalIdentitySource" s FROM "BusinessProfile" WHERE "businessId" = $1`, b.businessId)) as Row[];
      const h = (await tx.$queryRawUnsafe(`SELECT "fromKind","toKind","statusEffectiveDate","confirmedByUserId","reauthMethod","statementVersion","statementSha256"
          FROM "BusinessKindTransition" WHERE "businessId" = $1`, b.businessId)) as Row[];
      out = { r, effects: json({ p, h }) };
      throw ROLLBACK;
    }, TX);
  } catch (e) { if (e !== ROLLBACK) throw e; }
  return out!;
}
/** Whole-table fingerprint of every row outside the given businesses. */
async function fingerprint(exclude: number[]) {
  const ex = exclude.length ? exclude : [0];
  const r = (await owner.$queryRawUnsafe(`SELECT
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) FROM "BusinessProfile" t WHERE NOT (t."businessId" = ANY($1::int[]))) AS p,
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) FROM "BusinessIssuerDeclaration" t WHERE NOT (t."businessId" = ANY($1::int[]))) AS d,
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) FROM "BusinessKindTransition" t WHERE NOT (t."businessId" = ANY($1::int[]))) AS h,
      (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t."id"), '')) FROM "BillingDocument" t WHERE NOT (t."businessId" = ANY($1::int[]))) AS docs,
      (SELECT count(*)::int FROM "BusinessProfile" t WHERE NOT (t."businessId" = ANY($1::int[]))) AS profiles`, ex)) as Row[];
  return r[0];
}

async function main() {
  const transitioned: number[] = [];

  // ================================================================== I1
  console.log("— I1 the real migration is what runs");
  const fileSha = createHash("sha256").update(readFileSync(`prisma/migrations/${WIRE}/migration.sql`)).digest("hex");
  const led = (await owner.$queryRawUnsafe(`SELECT checksum, finished_at IS NOT NULL AS done, rolled_back_at IS NULL AS live FROM "_prisma_migrations" WHERE migration_name = $1`, WIRE)) as Row[];
  ok("I1 the ledger records 20261225090000 once, finished, with the file's checksum",
    led.length === 1 && led[0].done === true && led[0].live === true && led[0].checksum === fileSha, { led, fileSha });
  const [f] = (await owner.$queryRawUnsafe(`SELECT p.prosrc, p.prosecdef, p.proconfig::text AS cfg,
      pg_get_userbyid(p.proowner) AS fowner, pg_get_userbyid((SELECT relowner FROM pg_class WHERE relname = 'BusinessIssuerDeclaration')) AS downer,
      pg_get_userbyid((SELECT proowner FROM pg_proc WHERE proname = 'issuer_declaration_status_change')) AS wowner,
      has_function_privilege('app_runtime', p.oid, 'EXECUTE') AS rt,
      has_function_privilege('app_runtime', 'public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)', 'EXECUTE') AS rt_writer,
      has_function_privilege('app_runtime_prod', 'public.issuer_declaration_status_change(integer, text, text, timestamptz, text, text)', 'EXECUTE') AS rtp_writer,
      has_function_privilege('app_auth', p.oid, 'EXECUTE') AS auth,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS pub
    FROM pg_proc p WHERE p.proname = 'business_kind_transition_to_authorized'`)) as Row[];
  ok("I1 the deployed body is byte-identical to the migration file's body", f.prosrc === bodyOf(`prisma/migrations/${WIRE}/migration.sql`));
  ok("I1 it differs from 20261221090000 (the wiring is live)", f.prosrc !== bodyOf(`prisma/migrations/${OLD}/migration.sql`));
  ok("I1 SECURITY DEFINER, pinned search_path, one owner for the transition, the writer and the declaration table",
    f.prosecdef === true && String(f.cfg).includes("search_path=pg_catalog, public, pg_temp") && f.fowner === f.downer && f.fowner === f.wowner, f);
  ok("I1 ACL unchanged: app_runtime executes the transition, never the writer; app_auth and PUBLIC nothing",
    f.rt === true && f.rt_writer === false && f.rtp_writer === false && f.auth === false && f.pub === false, f);
  const direct = await runtime.$transaction(async (tx) => {
    try { await tx.$queryRawUnsafe(`SELECT public.issuer_declaration_status_change(1, '000000000', 'PASSWORD', now(), 'x', 'y')`); return null; }
    catch (e) { return msg(e); }
  }, TX).catch((e) => msg(e));
  ok("I1 the runtime calling the writer directly → permission denied", direct !== null && /permission denied|42501/i.test(String(direct)), direct ?? "allowed");

  // Controls for I5, created before anything transitions.
  const controls = {
    exemptDeclared: await business(), exemptPlain: await business(), authorizedDeclared: await business({ kind: "AUTHORIZED_DEALER" }),
    company: await business({ kind: "LTD_COMPANY" }), twoUsersDeclared: await business(), anonymised: await business(),
  };
  await declare(controls.exemptDeclared); await declare(controls.authorizedDeclared, { authorized: true });
  await declare(controls.twoUsersDeclared); await addUser(controls.twoUsersDeclared); await declare(controls.anonymised, { anonymised: true });
  for (const c of Object.values(controls)) { await issuedDoc(c, "RECEIPT"); }
  const controlBefore = await Promise.all(Object.values(controls).map((c) => snap(c.businessId)));

  // ================================================================== I2
  console.log("\n— I2 a declared business: v2, and history stays history");
  const a = await business();
  const v1Id = await declare(a);
  const docIds = [await issuedDoc(a, "RECEIPT"), await issuedDoc(a, "RECEIPT"), await issuedDoc(a, "PRICE_QUOTE")];
  const before = { d: await rows("BusinessIssuerDeclaration", a.businessId, "version"), docs: await rows("BillingDocument", a.businessId) };
  const seqBefore = json(await rows("BillingDocumentNumberSequence", a.businessId));
  const fp0 = await fingerprint([a.businessId]);
  const date = addDays(israelToday(), -40);
  const r = await transition(a, { date });
  transitioned.push(a.businessId);
  const ds = await rows("BusinessIssuerDeclaration", a.businessId, "version");
  const h = (await rows("BusinessKindTransition", a.businessId))[0] ?? {};
  const p = (await rows("BusinessProfile", a.businessId))[0];
  const docsAfter = await rows("BillingDocument", a.businessId);
  ok("I2 TRANSITIONED", r === "TRANSITIONED", r);
  ok("I2 declaration v2 STATUS_CHANGE / AUTHORIZED_DEALER_INDIVIDUAL / AUTHORIZED, VAT = id, supersedes v1",
    ds.length === 2 && ds[1].kind === "STATUS_CHANGE" && ds[1].track === "AUTHORIZED_DEALER_INDIVIDUAL" && ds[1].vatStatus === "AUTHORIZED"
      && ds[1].vatRegistrationNumber === a.taxId && Number(ds[1].supersedesId) === v1Id, ds.map((x) => [x.version, x.kind]));
  ok("I2 v2 digest = the history row's digest = the digest of what the owner confirmed (server-computed)",
    ds[1]?.statementSha256 === h.statementSha256 && h.statementSha256 === callArgs(a, { date })[5] && ds[1]?.statementVersion === "kind-transition-exempt-to-authorized-v1");
  ok("I2 v2 re-auth method and instant = the history row's; v2 effectiveFrom = confirmedAt",
    ds[1]?.reauthMethod === h.reauthMethod && ms(ds[1]?.reauthAt) === ms(h.reauthAt) && ms(ds[1]?.effectiveFrom) === ms(h.confirmedAt));
  ok("I2 the declared start date is recorded in the history only (v2 does not back-date)",
    String(h.statusEffectiveDate instanceof Date ? (h.statusEffectiveDate as Date).toISOString().slice(0, 10) : h.statusEffectiveDate) === date && ms(ds[1]?.effectiveFrom) > ms(new Date(`${date}T23:59:59Z`)));
  ok("I2 v1 byte-identical", json(ds[0]) === json(before.d[0]));
  ok("I2 profile AUTHORIZED_DEALER, VAT = id; name, id number, confirmation untouched; v2 identity = profile identity",
    p.billingBusinessKind === "AUTHORIZED_DEALER" && p.billingVatNumber === a.taxId && p.billingLegalName === LEGAL_NAME && p.billingTaxId === a.taxId
      && ds[1]?.legalName === p.billingLegalName && ds[1]?.idNumber === p.billingTaxId);
  ok("I2 every issued document (2 receipts + 1 quote) byte-identical: snapshot, hash, number, status, timestamps",
    docsAfter.length === 3 && json(docsAfter) === json(before.docs) && docsAfter.every((d) => json(d.issuedSnapshot).includes("EXEMPT_DEALER")));
  const edit = await runtime.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(a.businessId));
    try { await tx.$executeRawUnsafe(`UPDATE "BillingDocument" SET "issuedSnapshot" = '{}'::jsonb WHERE id = $1`, docIds[0]); return null; } catch (e) { return msg(e); }
  }, TX).catch((e) => msg(e));
  ok("I2 an issued document still cannot be edited after the transition (DZ010 / grants)", edit !== null, edit ?? "updated");
  ok("I2 the number sequences of the business are not touched by the transition", json(await rows("BillingDocumentNumberSequence", a.businessId)) === seqBefore);
  ok("I2 nothing outside the business changed (whole-table fingerprint)", json(await fingerprint([a.businessId])) === json(fp0));

  // ================================================================== I3
  console.log("\n— I3 full rollback when anything fails after v2 was filed");
  const faults: [string, string, string, string][] = [
    ["the history row", "BusinessKindTransition", "INSERT", "RAISE EXCEPTION 'LAB_FAULT_INJECTED'"],
    ["the profile update", "BusinessProfile", "UPDATE", "RAISE EXCEPTION 'LAB_FAULT_INJECTED'"],
    // The function's own invariant: the profile row is not updated (a trigger swallows the UPDATE) → DZL07.
    ["DZL07 (profile not updated)", "BusinessProfile", "UPDATE", "RETURN NULL"],
  ];
  for (const [where, table, op, action] of faults) {
    const b = await business(); await declare(b); await issuedDoc(b, "RECEIPT");
    const s0 = await snap(b.businessId);
    const fn = `lab_fault_${n}`;
    await owner.$executeRawUnsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."businessId" = ${b.businessId} THEN ${action}; END IF; RETURN NEW; END $$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE ${op} ON "${table}" FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    let err: string | null = null;
    try { await transition(b); } catch (e) { err = msg(e); }
    await owner.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "${table}"`);
    await owner.$executeRawUnsafe(`DROP FUNCTION public.${fn}()`);
    const expected = action.startsWith("RAISE") ? /LAB_FAULT_INJECTED/ : /KIND_TRANSITION_PROFILE_NOT_UPDATED|DZL07/;
    ok(`I3 a failure at ${where} → the call fails, nothing is left (no v2, no history, profile exempt, documents identical)`,
      err !== null && expected.test(err) && (await snap(b.businessId)) === s0, err ?? "no error");
    const again = await transition(b);
    transitioned.push(b.businessId);
    ok(`I3 after ${where}: the same business transitions normally`, again === "TRANSITIONED" && (await rows("BusinessIssuerDeclaration", b.businessId)).length === 2, again);
  }

  // ================================================================== I4
  console.log("\n— I4 without a live declaration the wired function = 20261221090000 (side by side, rolled back)");
  const old = readFileSync(`prisma/migrations/${OLD}/migration.sql`, "utf8").replace(/\r\n/g, "\n");
  const oa = old.indexOf("CREATE OR REPLACE FUNCTION public.business_kind_transition_to_authorized(");
  const oldFn = old.slice(oa, old.indexOf("\n$fn$;", oa) + 6).replace("public.business_kind_transition_to_authorized(", "public.lab_kt_v0(");
  await owner.$executeRawUnsafe(oldFn);
  await owner.$executeRawUnsafe(`REVOKE ALL ON FUNCTION public.lab_kt_v0(integer, text, date, text, timestamptz, text) FROM PUBLIC`);
  await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.lab_kt_v0(integer, text, date, text, timestamptz, text) TO app_runtime`);
  const other = await business();
  const today = israelToday();
  const cases: [string, () => Promise<Biz>, Call][] = [
    ["exempt, no declaration (happy path)", () => business(), {}],
    ["exempt, no declaration, early start date + GOOGLE", () => business(), { date: "2015-03-01", method: "GOOGLE" }],
    ["anonymised declaration (happy path)", async () => { const b = await business(); await declare(b, { anonymised: true }); return b; }, {}],
    ["authorized dealer", () => business({ kind: "AUTHORIZED_DEALER" }), {}],
    ["authorized dealer with a live declaration", async () => { const b = await business({ kind: "AUTHORIZED_DEALER" }); await declare(b, { authorized: true }); return b; }, {}],
    ["company", () => business({ kind: "LTD_COMPANY" }), {}],
    ["no kind", () => business({ kind: null }), {}],
    ["no profile", () => business({ profile: false }), {}],
    ["VAT check digit", () => business(), { vat: "123456789" }],
    ["VAT missing", () => business(), { vat: null }],
    ["VAT another valid number", () => business(), { vat: withCheckDigit("03141592") }],
    ["start date tomorrow", () => business(), { date: addDays(today, 1) }],
    ["start date before 2000", () => business(), { date: "1999-12-31" }],
    ["re-auth 11 minutes old", () => business(), { at: new Date(Date.now() - 11 * 60_000) }],
    ["re-auth unknown method", () => business(), { method: "EMAIL_LINK" }],
    ["digest wrong", () => business(), { sha: "0".repeat(64) }],
    ["no tenant context", () => business(), { ctx: null }],
    ["user of another business", () => business(), { user: other.userId }],
    ["business being deleted", () => business({ deleting: true }), {}],
    ["two users", () => business({ users: 2 }), {}],
    ["live declaration + two users (refused before the writer)", async () => { const b = await business(); await declare(b); await addUser(b); return b; }, {}],
    ["live declaration + VAT ≠ id (refused before the writer)", async () => { const b = await business(); await declare(b); return b; }, { vat: withCheckDigit("03141592") }],
    ["live declaration + stale re-auth (refused before the writer)", async () => { const b = await business(); await declare(b); return b; }, { at: new Date(Date.now() - 11 * 60_000) }],
  ];
  for (const [label, make, c] of cases) {
    const b = await make();
    const s0 = await snap(b.businessId);
    const v0 = await dryRun(b, { ...c, fn: "lab_kt_v0" });
    const v1 = await dryRun(b, c);
    ok(`I4 ${label}: same answer (${v0.r}) and same effects; nothing committed`, v0.r === v1.r && v0.effects === v1.effects && (await snap(b.businessId)) === s0,
      { old: v0.r, wired: v1.r, same: v0.effects === v1.effects });
  }
  {
    // The single intended difference.
    const b = await business(); await declare(b);
    const v0 = await dryRun(b, { fn: "lab_kt_v0" });
    const v1 = await dryRun(b, {});
    ok("I4 the intended difference: a live exempt declaration — before ISSUER_DECLARATION_ACTIVE, now TRANSITIONED", v0.r === "ISSUER_DECLARATION_ACTIVE" && v1.r === "TRANSITIONED", [v0.r, v1.r]);
    // Its corollary: the old refusal came before the digest check; now a live declaration reaches the digest check.
    const s = await business(); await declare(s);
    const w0 = await dryRun(s, { fn: "lab_kt_v0", sha: "f".repeat(64) });
    const w1 = await dryRun(s, { sha: "f".repeat(64) });
    ok("I4 its corollary: live declaration + stale digest — before ISSUER_DECLARATION_ACTIVE, now STATEMENT_STALE; nothing written either way",
      w0.r === "ISSUER_DECLARATION_ACTIVE" && w1.r === "STATEMENT_STALE", [w0.r, w1.r]);
  }
  await owner.$executeRawUnsafe(`DROP FUNCTION public.lab_kt_v0(integer, text, date, text, timestamptz, text)`);

  // ================================================================== I5
  console.log("\n— I5 businesses that did not transition");
  const controlAfter = await Promise.all(Object.values(controls).map((c) => snap(c.businessId)));
  Object.keys(controls).forEach((k, i) => ok(`I5 control ${k}: profile, declarations, history, documents byte-identical`, controlAfter[i] === controlBefore[i]));
  const lingering = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'lab_%'`)) as Row[];
  ok("I5 no lab-only function left behind", Number(lingering[0].n) === 0, lingering[0].n);
  const strays = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessKindTransition" WHERE NOT ("businessId" = ANY($1::int[]))
      AND "businessId" IN (SELECT id FROM "Business" WHERE name LIKE $2)`, transitioned, `ktw-${stamp}-%`)) as Row[];
  ok("I5 no history row for any business of this run except the ones that transitioned", Number(strays[0].n) === 0, strays[0].n);
  const v2s = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessIssuerDeclaration" WHERE kind = 'STATUS_CHANGE' AND NOT ("businessId" = ANY($1::int[]))
      AND "businessId" IN (SELECT id FROM "Business" WHERE name LIKE $2)`, transitioned, `ktw-${stamp}-%`)) as Row[];
  ok("I5 no STATUS_CHANGE declaration for any business of this run except the ones that transitioned", Number(v2s[0].n) === 0, v2s[0].n);

  console.log(`\nwiring battery (REAL migration ${WIRE}): ${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length) process.exit(1);
}

main().catch(async (e) => {
  console.error("BATTERY ERROR:", e);
  await owner.$disconnect(); await runtime.$disconnect();
  process.exit(1);
});
