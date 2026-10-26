/**
 * Document ↔ supplier link — what migration 20261102080000_document_supplier_link does, measured with the real role
 * topology on a Production-shaped database:
 *   owner   (OWNER_URL: the migration role — owner of every table and function, BYPASSRLS like Production's),
 *   runtime (RUNTIME_URL: NOSUPERUSER NOBYPASSRLS, member of app_runtime — the tenant plane).
 *
 *   1. Isolation, four sides, on both new tables, as the runtime: no context → nothing visible and every write
 *      refused; own rows visible; the other business's rows invisible and unchangeable; a write naming the other
 *      business refused; DELETE refused on both; UPDATE refused on the trail.
 *   2. Cross-business references refused by the DATABASE: another business's supplier, document, previous supplier
 *      or user can never be named — even when the application is bypassed.
 *   3. Shapes: one decision row per document; ACTIVE names a supplier, REMOVED names none; a suggestion reason only
 *      with an accepted suggestion; the trail's actions name exactly their suppliers; idempotency tokens are tokens
 *      and unique per business.
 *   4. Concurrency: twelve simultaneous first links of the same document — exactly one succeeds.
 *   5. The trail is append-only for the owner too: every change refused except nulling the acting user.
 *   6. A supplier a link names cannot be removed; a removed document takes its link and trail with it.
 *   7. ExtractedData issuer columns: the reading's verdict and its tax id always agree.
 *   8. Account erasure refuses without a context and for an active business; for a business being deleted it
 *      nulls that business's acting users only.
 *   9. The flag is OFF.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only.
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const withPool = (url: string) => `${url}${url.includes("?") ? "&" : "?"}connection_limit=24&pool_timeout=30`;
const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: withPool(process.env.RUNTIME_URL!) });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;

async function inTx<T>(client: PrismaClient, guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return client.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }, { timeout: 30_000 }).catch((e: Error) => e.message);
}
const q = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const x = (client: PrismaClient, guc: number | null, sql: string, ...args: unknown[]) =>
  inTx(client, guc, (tx) => tx.$executeRawUnsafe(sql, ...args));
const rows = (r: unknown): Rows => (Array.isArray(r) ? (r as Rows) : []);
const num = (r: unknown, key = "n") => Number(rows(r)[0]?.[key] ?? NaN);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const DENIED = /permission denied/i;
const RLS = /row-level security/i;
const CHECK = /check constraint|23514/i;
const FK = /foreign key|23503/i;
const UNIQUE = /unique constraint|23505/i;
const SAME_BIZ = /DOCUMENT_SUPPLIER_LINK_USER_OTHER_BUSINESS|DZS01/;
const ERASURE = /DOCUMENT_SUPPLIER_LINK_ERASURE_|DZS02/;
const APPEND_ONLY = /DOCUMENT_SUPPLIER_LINK_EVENT_APPEND_ONLY|DZS03/;

const LINK = `"DocumentSupplierLink"`;
const EVT = `"DocumentSupplierLinkEvent"`;
const linkCols = `("businessId", "documentId", "supplierId", "status", "method", "suggestionReason", "linkedByUserId", "linkedAt")`;
const evtCols = `("businessId", "documentId", "action", "supplierId", "previousSupplierId", "method", "suggestionReason", "actorUserId", "idempotencyKey")`;

async function seedBusiness(tag: string) {
  const run = `${tag}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const b = num(await q(owner, null, `INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id" AS n`, `dsl ${run}`));
  const u = num(await q(owner, null, `INSERT INTO "User" ("email", "password", "businessId", "name", "updatedAt") VALUES ($1, 'x', $2, 'DSL', now()) RETURNING "id" AS n`, `dsl-${run}@example.test`, b));
  const s1 = num(await q(owner, null, `INSERT INTO "Supplier" ("businessId", "name", "updatedAt") VALUES ($1, 'אלפא', now()) RETURNING "id" AS n`, b));
  const s2 = num(await q(owner, null, `INSERT INTO "Supplier" ("businessId", "name", "updatedAt") VALUES ($1, 'בטא', now()) RETURNING "id" AS n`, b));
  const docs: number[] = [];
  for (let i = 0; i < 4; i++) {
    docs.push(num(await q(owner, null,
      `INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status") VALUES ($1, $2, 'file', 'application/pdf', 'needs_review') RETURNING "id" AS n`,
      b, `dsl/${run}/${i}.pdf`)));
  }
  return { b, u, s1, s2, docs };
}

async function main() {
  const A = await seedBusiness("a");
  const B = await seedBusiness("b");
  const now = `CURRENT_TIMESTAMP`;

  console.log("\n1. Isolation (runtime)");
  ok("no context → link insert refused",
    refused(await x(runtime, null, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, $4, ${now})`, A.b, A.docs[0], A.s1, A.u), RLS));
  ok("own link insert (A in A's context)",
    !refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, $4, ${now})`, A.b, A.docs[0], A.s1, A.u), /./));
  ok("own trail insert", !refused(await x(runtime, A.b,
    `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'LINKED', $3, NULL, 'MANUAL_PICK', NULL, $4, 'idem-a-0001')`, A.b, A.docs[0], A.s1, A.u), /./));
  await x(runtime, B.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, $4, ${now})`, B.b, B.docs[0], B.s1, B.u);
  await x(runtime, B.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'LINKED', $3, NULL, 'MANUAL_PICK', NULL, $4, 'idem-b-0001')`, B.b, B.docs[0], B.s1, B.u);
  ok("no context → nothing visible (links)", num(await q(runtime, null, `SELECT count(*)::int AS n FROM ${LINK}`)) === 0);
  ok("no context → nothing visible (trail)", num(await q(runtime, null, `SELECT count(*)::int AS n FROM ${EVT}`)) === 0);
  ok("A sees exactly its own link", num(await q(runtime, A.b, `SELECT count(*)::int AS n FROM ${LINK}`)) === 1);
  ok("A sees exactly its own trail", num(await q(runtime, A.b, `SELECT count(*)::int AS n FROM ${EVT}`)) === 1);
  ok("A cannot see B's link by id", num(await q(runtime, A.b, `SELECT count(*)::int AS n FROM ${LINK} WHERE "businessId" = $1`, B.b)) === 0);
  ok("A's UPDATE of B's link changes nothing",
    Number(await x(runtime, A.b, `UPDATE ${LINK} SET "version" = "version" + 1 WHERE "businessId" = $1`, B.b)) === 0);
  ok("a write naming B in A's context is refused",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, B.b, B.docs[1], B.s1), RLS));
  ok("DELETE on the link refused", refused(await x(runtime, A.b, `DELETE FROM ${LINK}`), DENIED));
  ok("DELETE on the trail refused", refused(await x(runtime, A.b, `DELETE FROM ${EVT}`), DENIED));
  ok("UPDATE on the trail refused (runtime)", refused(await x(runtime, A.b, `UPDATE ${EVT} SET "actorUserId" = NULL`), DENIED));

  console.log("\n2. Cross-business references refused by the database");
  ok("A's link to B's supplier → refused (composite FK)",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, A.b, A.docs[1], B.s1), FK));
  ok("A's link to B's document → refused (composite FK)",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, A.b, B.docs[1], A.s1), FK));
  ok("A's trail naming B's previous supplier → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'RELINKED', $3, $4, 'MANUAL_PICK', NULL, NULL, NULL)`, A.b, A.docs[0], A.s2, B.s1), FK));
  ok("A's link naming B's user → refused (trigger)",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, $4, ${now})`, A.b, A.docs[1], A.s1, B.u), SAME_BIZ));
  ok("A's trail naming B's user → refused (trigger)",
    refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'LINKED', $3, NULL, 'MANUAL_PICK', NULL, $4, NULL)`, A.b, A.docs[1], A.s1, B.u), SAME_BIZ));
  ok("owner bypassing the app: A's link to B's supplier still refused",
    refused(await x(owner, null, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, A.b, A.docs[2], B.s2), FK));

  console.log("\n3. Shapes");
  ok("a second decision row for the same document → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, A.b, A.docs[0], A.s2), UNIQUE));
  ok("ACTIVE without a supplier → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, NULL, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, A.b, A.docs[1]), CHECK));
  ok("REMOVED naming a supplier → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ("businessId", "documentId", "supplierId", "status", "removedAt") VALUES ($1, $2, $3, 'REMOVED', ${now})`, A.b, A.docs[1], A.s1), CHECK));
  ok("a suggestion reason on a manual pick → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', 'TAX_ID', NULL, ${now})`, A.b, A.docs[1], A.s1), CHECK));
  ok("an unknown method → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'AUTO', NULL, NULL, ${now})`, A.b, A.docs[1], A.s1), CHECK));
  ok("an accepted suggestion with its reason is allowed",
    !refused(await x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'SUGGESTION_ACCEPTED', 'TAX_ID', NULL, ${now})`, A.b, A.docs[1], A.s1), /./));
  ok("removal: ACTIVE → REMOVED with no supplier is allowed",
    !refused(await x(runtime, A.b, `UPDATE ${LINK} SET "status" = 'REMOVED', "supplierId" = NULL, "method" = NULL, "suggestionReason" = NULL, "removedAt" = ${now}, "version" = "version" + 1 WHERE "businessId" = $1 AND "documentId" = $2`, A.b, A.docs[1]), /./));
  ok("RELINKED to the same supplier → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'RELINKED', $3, $3, 'MANUAL_PICK', NULL, NULL, NULL)`, A.b, A.docs[0], A.s1), CHECK));
  ok("UNLINKED naming a new supplier → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'UNLINKED', $3, $4, NULL, NULL, NULL, NULL)`, A.b, A.docs[0], A.s2, A.s1), CHECK));
  ok("SUGGESTION_DISMISSED is a closed shape (supplier only)",
    !refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'SUGGESTION_DISMISSED', $3, NULL, NULL, NULL, NULL, NULL)`, A.b, A.docs[2], A.s2), /./));
  ok("free text as an idempotency key → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'LINKED', $3, NULL, 'MANUAL_PICK', NULL, NULL, 'שלום עולם')`, A.b, A.docs[2], A.s1), CHECK));
  ok("a repeated idempotency key in the same business → refused",
    refused(await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'LINKED', $3, NULL, 'MANUAL_PICK', NULL, NULL, 'idem-a-0001')`, A.b, A.docs[2], A.s1), UNIQUE));
  ok("the same idempotency key in another business is fine",
    !refused(await x(runtime, B.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'LINKED', $3, NULL, 'MANUAL_PICK', NULL, NULL, 'idem-a-0001')`, B.b, B.docs[1], B.s2), /./));

  console.log("\n4. Concurrency — twelve simultaneous first links of one document");
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    x(runtime, A.b, `INSERT INTO ${LINK} ${linkCols} VALUES ($1, $2, $3, 'ACTIVE', 'MANUAL_PICK', NULL, NULL, ${now})`, A.b, A.docs[3], i % 2 ? A.s1 : A.s2)));
  const won = attempts.filter((r) => typeof r === "number").length;
  const lost = attempts.filter((r) => refused(r, UNIQUE)).length;
  ok("exactly one wins, eleven are refused by the unique key", won === 1 && lost === 11, `won ${won}, unique-refused ${lost}`);
  ok("one row exists for the document", num(await q(runtime, A.b, `SELECT count(*)::int AS n FROM ${LINK} WHERE "documentId" = $1`, A.docs[3])) === 1);

  console.log("\n5. The trail is append-only — the owner too");
  ok("owner: changing the action → refused",
    refused(await x(owner, null, `UPDATE ${EVT} SET "action" = 'UNLINKED' WHERE "businessId" = $1`, A.b), APPEND_ONLY));
  ok("owner: changing the supplier → refused",
    refused(await x(owner, null, `UPDATE ${EVT} SET "supplierId" = $2 WHERE "businessId" = $1 AND "action" = 'LINKED'`, A.b, A.s2), APPEND_ONLY));
  ok("owner: setting another actor → refused",
    refused(await x(owner, null, `UPDATE ${EVT} SET "actorUserId" = $2 WHERE "businessId" = $1 AND "actorUserId" IS NULL`, A.b, A.u), APPEND_ONLY));

  console.log("\n6. Removal semantics");
  ok("a supplier named by a link cannot be removed",
    refused(await x(owner, null, `DELETE FROM "Supplier" WHERE "id" = $1`, A.s1), FK));
  const doc0Before = num(await q(owner, null, `SELECT count(*)::int AS n FROM ${EVT} WHERE "documentId" = $1`, A.docs[0]));
  await x(owner, null, `DELETE FROM "Document" WHERE "id" = $1`, A.docs[0]);
  ok("a removed document takes its link with it",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM ${LINK} WHERE "documentId" = $1`, A.docs[0])) === 0);
  ok("…and its trail", doc0Before > 0 && num(await q(owner, null, `SELECT count(*)::int AS n FROM ${EVT} WHERE "documentId" = $1`, A.docs[0])) === 0);

  console.log("\n7. ExtractedData — the reading's issuer verdict and its tax id agree");
  const ed = (doc: number, cols: string, vals: string) =>
    x(owner, null, `INSERT INTO "ExtractedData" ("documentId", ${cols}) VALUES ($1, ${vals})`, doc);
  const freshDoc = async () => num(await q(owner, null,
    `INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status") VALUES ($1, 'dsl/x.pdf', 'file', 'application/pdf', 'needs_review') RETURNING "id" AS n`, A.b));
  ok("OK with a valid id is allowed", !refused(await ed(await freshDoc(), `"issuerTaxId", "issuerTaxIdSource", "issuerTaxIdValid", "issuerCheck"`, `'512345678', 'VENDOR_LINE', true, 'OK'`), /./));
  ok("OK without a valid id → refused", refused(await ed(await freshDoc(), `"issuerTaxId", "issuerTaxIdSource", "issuerTaxIdValid", "issuerCheck"`, `'512345670', 'VENDOR_LINE', false, 'OK'`), CHECK));
  ok("TAX_ID_INVALID with a valid id → refused", refused(await ed(await freshDoc(), `"issuerTaxId", "issuerTaxIdSource", "issuerTaxIdValid", "issuerCheck"`, `'512345678', 'HEADER', true, 'TAX_ID_INVALID'`), CHECK));
  ok("OWN_BUSINESS_ONLY carrying an id → refused", refused(await ed(await freshDoc(), `"issuerTaxId", "issuerTaxIdSource", "issuerTaxIdValid", "issuerCheck", "ownBusinessExcluded"`, `'512345678', 'HEADER', true, 'OWN_BUSINESS_ONLY', true`), CHECK));
  ok("an id without its source → refused", refused(await ed(await freshDoc(), `"issuerTaxId", "issuerTaxIdValid"`, `'512345678', true`), CHECK));
  ok("letters as a tax id → refused", refused(await ed(await freshDoc(), `"issuerTaxId", "issuerTaxIdSource", "issuerTaxIdValid"`, `'51234567A', 'HEADER', false`), CHECK));
  ok("a reading from before this foundation (all NULL) is still valid", !refused(await ed(await freshDoc(), `"vendorName"`, `'ספק'`), /./));
  ok("ownBusinessExcluded defaults to false",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "ExtractedData" e JOIN "Document" d ON d."id" = e."documentId" WHERE d."businessId" = $1 AND e."vendorName" = 'ספק' AND e."ownBusinessExcluded" = false`, A.b)) === 1);

  console.log("\n8. Account erasure");
  ok("no context → refused", refused(await q(runtime, null, `SELECT public.document_supplier_link_erase_business() AS n`), ERASURE));
  ok("an active business → refused", refused(await q(runtime, A.b, `SELECT public.document_supplier_link_erase_business() AS n`), ERASURE));
  const actorsOfA = async () => num(await q(owner, null,
    `SELECT ((SELECT count(*) FROM ${LINK} WHERE "businessId" = $1 AND "linkedByUserId" IS NOT NULL)
           + (SELECT count(*) FROM ${EVT} WHERE "businessId" = $1 AND "actorUserId" IS NOT NULL))::int AS n`, A.b));
  // A keeps an acting user that must survive B's erasure (A's earlier ones went with the document removed in 6).
  await x(runtime, A.b, `INSERT INTO ${EVT} ${evtCols} VALUES ($1, $2, 'SUGGESTION_DISMISSED', $3, NULL, NULL, NULL, $4, NULL)`, A.b, A.docs[2], A.s1, A.u);
  const aBefore = await actorsOfA();
  await x(owner, null, `UPDATE "Business" SET "deletionRequestedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, B.b);
  const erased = num(await q(runtime, B.b, `SELECT public.document_supplier_link_erase_business() AS n`));
  ok("a business being deleted → its acting users nulled", erased >= 2, `changed ${erased}`);
  ok("…none of B's acting users remain",
    num(await q(owner, null, `SELECT (SELECT count(*) FROM ${LINK} WHERE "businessId" = $1 AND "linkedByUserId" IS NOT NULL) + (SELECT count(*) FROM ${EVT} WHERE "businessId" = $1 AND "actorUserId" IS NOT NULL) AS n`, B.b)) === 0);
  const aAfter = await actorsOfA();
  ok("…and A's are untouched", aBefore > 0 && aAfter === aBefore, `before ${aBefore}, after ${aAfter}`);

  console.log("\n9. The flag is OFF");
  ok("document_supplier_linking: defaultEnabled false, globalEnabled false, no override",
    num(await q(owner, null, `SELECT count(*)::int AS n FROM "PlatformFeatureDefinition" d JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key"
       WHERE d."key" = 'document_supplier_linking' AND d."defaultEnabled" = false AND p."globalEnabled" = false AND p."emergencyDisabled" = false`)) === 1);

  console.log(`\ndocument-supplier-link battery: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await owner.$disconnect(); await runtime.$disconnect(); });
