/**
 * P2 · Identity statements + P3-A trust claims — tenant isolation under real RLS.
 *   TEST_DATABASE_URL="postgres://…test…" npx tsx lib/services/identity/identity.rls.db.test.ts
 *
 * The lab schema comes from `prisma db push` (the migration chain cannot be replayed from an empty
 * database), which models no RLS, no CHECK and no partial index. So this test first makes the lab
 * look like Production, the same way the P1 suite does:
 *   1. creates `app_runtime`, drops what `db push` made for P2, and replays the P2 migration
 *      verbatim — so its own guarded GRANT block runs exactly as it will in Production. The P2
 *      table is never re-granted here: whatever app_runtime can do to it, the migration gave it;
 *   2. replays the RLS the base tables it reads get from the migrations that own them.
 * Then the real P2 code runs as app_runtime — NOSUPERUSER, NOBYPASSRLS — in a child process,
 * because the owner test connection bypasses every policy.
 *
 * Run this BEFORE identity.db.test.ts, which relies on the replayed constraints.
 * Refuses Production.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_DB || !/^postgres(ql)?:\/\//i.test(TEST_DB)) {
  console.error("ABORT: set TEST_DATABASE_URL to a non-production Postgres URL.");
  process.exit(1);
}
if ((() => { try { return new URL(TEST_DB).hostname; } catch { return ""; } })().includes("ep-flat-brook")) {
  console.error("ABORT: TEST_DATABASE_URL is the Production endpoint.");
  process.exit(1);
}
const IS_CHILD = process.env.P2_RLS_CHILD === "1";
if (!IS_CHILD) process.env.DATABASE_URL = TEST_DB;

const ROLE = "app_runtime";
const P2_TABLE = "BusinessIdentityStatement";
const FACT_TABLE = "BusinessIdentityFactAuthority";
const P2_TABLES = [P2_TABLE, FACT_TABLE];
/** P3-A: the trust-claim table, created and granted by the P3-A migration replayed after P2. */
const TRUST_TABLE = "BusinessTrustClaim";
const P2_TYPES = [
  "BusinessIdentityDimension", "BusinessIdentitySource", "BusinessIdentityStatus", "BusinessIdentityFact",
  "ConversionChannel", "TrustClaimKind", "TrustClaimClass", "TrustClaimStatus", "TrustVerificationMethod",
];
/** Base tables the identity read model reads. Their runtime grants come from ops scripts in Production. */
const READ_TABLES = [
  "BusinessProfile", "BusinessService", "InventoryItem", "InventoryCategory",
  "OfferingDemandSignal", "ContentRun", "ContentEvent", "ContentVariant", "BusinessBot", "BusinessBotProfile",
  // P3-A context: served-customer evidence, the website form, the WhatsApp connection status.
  "Appointment", "Lead", "AcquisitionConnection", "WhatsAppConnection",
  // P3-B landing context: asset metadata and the offering ↔ asset links.
  "BusinessAsset", "BusinessServiceAsset", "InventoryItemAsset",
];
/**
 * Business is set up exactly as in Production, never with a table-wide grant:
 *   - column privileges from 20260908180000_d2_user_business_privilege_narrowing (the runtime may
 *     SELECT id, name, createdAt, deletionRequestedAt, deletedAt — nothing else);
 *   - B4, 20261006090000_business_tenant_write_rls, replayed verbatim (SELECT USING (true), UPDATE
 *     pinned to the tenant, INSERT only for app_auth, no DELETE policy, FORCE).
 */
const BUSINESS_COLUMN_GRANT_MIGRATION = "20260908180000_d2_user_business_privilege_narrowing";
const B4_MIGRATION = "20261006090000_business_tenant_write_rls";

const P2_MIGRATION = "20261004090000_p2_business_identity";
/** P3-A, replayed verbatim after P2 (enum labels first: they must commit before the CHECKs name them). */
const P3A_MIGRATIONS = ["20261008090000_p3a_identity_enum_values", "20261008090100_p3a_trust_claims"];
const BASE_RLS: Array<{ migration: string; tables: string[] }> = [
  { migration: "20260824210000_d2_p7_wave1_tenant_rls", tables: ["BusinessService", "Lead"] },
  { migration: "20260902120000_d2_cutover2b_pilot_tenant_rls", tables: ["Appointment"] },
  { migration: "20261009090000_m6_acquisition_connections", tables: ["AcquisitionConnection"] },
  { migration: "20260825120000_d2_p7_wave1_businessprofile_rls", tables: ["BusinessProfile"] },
  { migration: "20260825150000_d2_p7_wave2_tenant_rls", tables: ["ContentRun", "ContentEvent", "ContentVariant", "BusinessBotProfile"] },
  { migration: "20260825200000_d2_p7_wave3_tenant_rls", tables: ["InventoryItem", "InventoryCategory"] },
  { migration: "20260831120000_d2_p7_w4eb2_billing_tenant_rls", tables: ["BusinessBot"] },
  { migration: "20260928120000_p1_business_offering", tables: ["OfferingDemandSignal", "BusinessServiceAsset", "InventoryItemAsset"] },
  { migration: "20260929090000_tenant_rls_closure", tables: ["BusinessAsset"] },
];
const TENANT_READ_TABLES = BASE_RLS.flatMap((m) => m.tables);

/** Statements of a migration file. Dollar-quoted bodies stay whole. */
function migrationStatements(migration: string): string[] {
  const sql = readFileSync(path.join(process.cwd(), "prisma", "migrations", migration, "migration.sql"), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
    if (tag && (quote === null || quote === tag)) {
      quote = quote === null ? tag : null;
      current += tag;
      i += tag.length - 1;
      continue;
    }
    if (sql[i] === ";" && quote === null) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += sql[i];
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const ALREADY_THERE = new Set(["42710", "42P07", "42701"]);
function alreadyThere(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (typeof meta?.code === "string" && ALREADY_THERE.has(meta.code)) return true;
  return /already exists/i.test(String((error as Error).message));
}

let failed = 0;
function ok(name: string, condition: boolean, detail: unknown = "") {
  if (!condition) {
    console.error("FAIL:", name, typeof detail === "string" ? detail : JSON.stringify(detail));
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

/* ───────────────────────── child: runs as app_runtime ───────────────────────── */

async function child() {
  const a = Number(process.env.P2_BUSINESS_A);
  const b = Number(process.env.P2_BUSINESS_B);
  const userA = Number(process.env.P2_USER_A);
  const statementB = Number(process.env.P2_STATEMENT_B);
  const textStatementB = Number(process.env.P2_TEXT_STATEMENT_B);
  const statementA = Number(process.env.P2_STATEMENT_A);
  const factB = Number(process.env.P2_FACT_B);

  const { prisma } = await import("@/lib/prisma");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const svc = await import("./identity-statement.service");
  const { getBusinessIdentity, adoptIdentitySuggestion, loadIdentityEvidence, resolveIdentityProvenance } = await import("./business-identity");
  const { decideFactAuthority, listActiveFactAuthorities } = await import("./identity-fact-authority.service");
  const { loadIdentityKnowledge } = await import("@/lib/knowledge/snapshot/snapshot-sources");
  const { deriveIdentitySignals } = await import("./identity-signals");

  const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (error) {
      return `${(error as Error).name}: ${String((error as Error).message)}`;
    }
  };

  const role = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const noContext = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${P2_TABLE}"`))[0].n);
  const leakedUnderA = await tenantTx(a, async (tx) =>
    Number((await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${P2_TABLE}" WHERE "businessId" = $1`, b))[0].n));

  // CROSS-TENANT IDENTITY READ — A's session asks for B, through every read path.
  // Business reads are open by design under B4 (SELECT USING (true)), so the identity read model
  // pins them itself: asking for B from A's transaction is refused before anything is read.
  const readB = await refused(() => tenantTx(a, (tx) => getBusinessIdentity(b, tx)));
  const listB = await tenantTx(a, (tx) => svc.listActiveIdentityStatements(b, tx));
  const evidenceB = await tenantTx(a, (tx) => loadIdentityEvidence(b, tx));
  const ownA = await tenantTx(a, (tx) => getBusinessIdentity(a, tx));

  // B4 — Business.name under the Production column grants and policies.
  const { loadIdentityFactValues } = await import("./identity-fact-authority.service");
  const ownName = ownA.facts.find((f) => f.fact === "BUSINESS_NAME")?.value ?? null;
  const factsNoContext = await refused(() => prisma.$transaction((tx) => loadIdentityFactValues(a, tx)));
  const factsBFromA = await refused(() => tenantTx(a, (tx) => loadIdentityFactValues(b, tx)));
  const businessWriteB = await tenantTx(a, (tx) =>
    tx.$executeRawUnsafe(`UPDATE "Business" SET "updatedAt" = now() WHERE "id" = $1`, b));
  const businessOtherColumn = await refused(() =>
    tenantTx(a, (tx) => tx.$queryRawUnsafe(`SELECT "archivedAt" FROM "Business" WHERE "id" = $1`, a)));

  // CROSS-TENANT IDENTITY WRITE
  const createForB = await refused(() =>
    tenantTx(a, (tx) => svc.createIdentityStatement({ businessId: b, userId: userA, dimension: "TONE", code: "PREMIUM", source: "OWNER_INPUT" }, tx)));
  const rawInsertB = await refused(() =>
    tenantTx(a, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "${P2_TABLE}" ("businessId","dimension","code","source","updatedAt") VALUES ($1,'TONE','PREMIUM','OWNER_INPUT',now())`, b)));

  // CROSS-TENANT POSITIONING UPDATE — retire, approve, re-point, raw update.
  const retireB = await refused(() =>
    tenantTx(a, (tx) => svc.retireIdentityStatement({ businessId: a, userId: userA, statementId: statementB }, tx)));
  const retireBasB = await refused(() =>
    tenantTx(a, (tx) => svc.retireIdentityStatement({ businessId: b, userId: userA, statementId: statementB }, tx)));
  const approveB = await refused(() =>
    tenantTx(a, (tx) => svc.setIdentityPublicUse({ businessId: b, userId: userA, statementId: textStatementB, approved: true }, tx)));
  const replaceB = await refused(() =>
    tenantTx(a, (tx) => svc.createIdentityStatement({ businessId: a, userId: userA, dimension: "TONE", code: "ENERGETIC", source: "OWNER_INPUT", replacesStatementId: statementB }, tx)));
  const rawUpdateB = await tenantTx(a, (tx) =>
    tx.$executeRawUnsafe(`UPDATE "${P2_TABLE}" SET "code" = 'ENERGETIC' WHERE "id" = $1`, statementB));
  const repointAtoB = await refused(() =>
    tenantTx(a, (tx) => tx.$executeRawUnsafe(`UPDATE "${P2_TABLE}" SET "businessId" = $1 WHERE "id" = $2`, b, statementA)));

  // CROSS-TENANT EVIDENCE LINK — B's evidence supports an AT_CUSTOMER suggestion; A's does not.
  const bKey = deriveIdentitySignals({
    services: [{ id: 1, active: true, categoryLabel: null, fulfillment: "AT_CUSTOMER", priceMode: null }],
    products: [], demand: [], variantSelections: [], bot: null,
  }).find((s) => s.kind === "FULFILLMENT_MODE")!.key;
  const adoptBEvidence = await refused(() =>
    tenantTx(a, (tx) => adoptIdentitySuggestion({ businessId: a, userId: userA, signalKey: bKey, dimension: "TARGET_AUDIENCE", code: "HOME_SERVICE_CUSTOMERS" }, tx)));
  const adoptAsB = await refused(() =>
    tenantTx(a, (tx) => adoptIdentitySuggestion({ businessId: b, userId: userA, signalKey: bKey, dimension: "TARGET_AUDIENCE", code: "HOME_SERVICE_CUSTOMERS" }, tx)));

  // The positive path still works under RLS, for A's own data.
  const mine = await tenantTx(a, (tx) => svc.createIdentityStatement({ businessId: a, userId: userA, dimension: "DIFFERENTIATOR", text: "שירות בעברית ובערבית", source: "OWNER_INPUT" }, tx));
  const mineApproved = await tenantTx(a, (tx) => svc.setIdentityPublicUse({ businessId: a, userId: userA, statementId: mine.id, approved: true }, tx));

  // Evidence cannot be erased by the runtime.
  const deleteRefused = await refused(() =>
    tenantTx(a, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${P2_TABLE}" WHERE "id" = $1`, statementA)));

  // FACT AUTHORITY across tenants.
  const factNoContext = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${FACT_TABLE}"`))[0].n);
  const factsBUnderA = await tenantTx(a, (tx) => listActiveFactAuthorities(b, tx));
  const approveFactForB = await refused(() =>
    tenantTx(a, (tx) => decideFactAuthority({ businessId: b, userId: userA, fact: "BUSINESS_NAME", action: "APPROVE_PUBLIC" }, tx)));
  const withdrawFactB = await refused(() =>
    tenantTx(a, (tx) => decideFactAuthority({ businessId: b, userId: userA, fact: "CITY", action: "WITHDRAW_PUBLIC" }, tx)));
  const rawFactUpdateB = await tenantTx(a, (tx) =>
    tx.$executeRawUnsafe(`UPDATE "${FACT_TABLE}" SET "publicUseApproved" = false, "publicUseApprovedAt" = NULL WHERE "id" = $1`, factB));
  const factDeleteRefused = await refused(() =>
    tenantTx(a, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${FACT_TABLE}" WHERE "businessId" = $1`, a)));
  const myFact = await tenantTx(a, (tx) => decideFactAuthority({ businessId: a, userId: userA, fact: "BUSINESS_NAME", action: "APPROVE_PUBLIC" }, tx));

  // BUSINESS MEMORY REFERENCES across tenants.
  const memoryBUnderA = await tenantTx(a, (tx) => loadIdentityKnowledge(tx, b, new Date()));
  const memoryA = await tenantTx(a, (tx) => loadIdentityKnowledge(tx, a, new Date()));
  const resolveBStatementAsB = await tenantTx(a, (tx) => resolveIdentityProvenance(b, { store: "BusinessIdentityStatement", id: statementB }, tx));
  const resolveBStatementAsA = await tenantTx(a, (tx) => resolveIdentityProvenance(a, { store: "BusinessIdentityStatement", id: statementB }, tx));
  const resolveBFact = await tenantTx(a, (tx) => resolveIdentityProvenance(a, { store: "BusinessIdentityFactAuthority", id: factB }, tx));
  const resolveOwn = await tenantTx(a, (tx) => resolveIdentityProvenance(a, { store: "BusinessIdentityStatement", id: statementA }, tx));

  // ── P3-A · trust claims, private evidence and the canonical context across tenants ──
  const claimB = Number(process.env.P3_CLAIM_B);
  const trust = await import("@/lib/services/trust/trust-claim.service");
  const { getBusinessIdentityContext, identityContextForAi } = await import("./business-identity-context");
  const { loadTrustKnowledge } = await import("@/lib/knowledge/snapshot/snapshot-sources");
  const trustNoContext = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "${TRUST_TABLE}"`))[0].n);
  const ctxBFromA = await refused(() => tenantTx(a, (tx) => getBusinessIdentityContext(b, tx)));
  const claimsBUnderA = (await tenantTx(a, (tx) => trust.listActiveTrustClaims(b, tx))).length;
  const withdrawBClaim = await refused(() => tenantTx(a, (tx) => trust.setTrustClaimPublicUse({ businessId: a, userId: userA, claimId: claimB, approved: false }, tx)));
  const withdrawBClaimAsB = await refused(() => tenantTx(a, (tx) => trust.setTrustClaimPublicUse({ businessId: b, userId: userA, claimId: claimB, approved: false }, tx)));
  const retireBClaim = await refused(() => tenantTx(a, (tx) => trust.retireTrustClaim({ businessId: b, userId: userA, claimId: claimB }, tx)));
  const confirmForB = await refused(() => tenantTx(a, (tx) => trust.confirmTrustClaim({ businessId: b, userId: userA, kind: "FOUNDED_YEAR", params: { foundedYear: 2000 } }, tx)));
  const rawUpdateBClaim = await tenantTx(a, (tx) => tx.$executeRawUnsafe(`UPDATE "${TRUST_TABLE}" SET "publicUseApproved" = false, "publicUseApprovedAt" = NULL, "publicUseApprovedByUserId" = NULL WHERE "id" = $1`, claimB));
  const attachToB = await refused(() => tenantTx(a, (tx) => trust.attachVerificationDocument(
    { businessId: a, userId: userA, claimId: claimB, storageKey: `biz/${a}/trust/claim-${claimB}/doc-1-x.pdf`, sha256: "c".repeat(64), mimeType: "application/pdf" }, tx)));
  const docRefB = await tenantTx(a, (tx) => trust.verificationDocumentRef({ businessId: a, claimId: claimB }, tx));
  const docRefBAsB = await tenantTx(a, (tx) => trust.verificationDocumentRef({ businessId: b, claimId: claimB }, tx));
  const docKeyRowsB = (await tenantTx(a, (tx) => tx.$queryRawUnsafe<unknown[]>(`SELECT "verificationAttachmentKey" FROM "${TRUST_TABLE}" WHERE "id" = $1`, claimB))).length;
  const trustMemoryBUnderA = (await tenantTx(a, (tx) => loadTrustKnowledge(tx, b, new Date()))).trustClaims.length;

  // A's own flow under RLS: confirm → approval refused without the document → attach → approve → retire.
  const myClaim = await tenantTx(a, (tx) => trust.confirmTrustClaim({ businessId: a, userId: userA, kind: "LICENSED", params: { licenseType: "קבלן שיפוצים", issuer: "רשם הקבלנים" } }, tx));
  const approveEarly = await refused(() => tenantTx(a, (tx) => trust.setTrustClaimPublicUse({ businessId: a, userId: userA, claimId: myClaim.id, approved: true }, tx)));
  const rawPublicInsert = await refused(() => tenantTx(a, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "${TRUST_TABLE}" ("businessId","claimKind","claimClass","params","wording","wordingHash","confirmedByUserId","publicUseApproved","publicUseApprovedAt","publicUseApprovedByUserId","updatedAt")
     VALUES ($1,'FOUNDED_YEAR','OWNER_ASSERTED','{}','x',encode(sha256(convert_to('x','UTF8')),'hex'),$2,true,now(),$2,now())`, a, userA)));
  const rawWordingUpdate = await refused(() => tenantTx(a, (tx) => tx.$executeRawUnsafe(`UPDATE "${TRUST_TABLE}" SET "wording" = 'y' WHERE "id" = $1`, myClaim.id)));
  const claimDelete = await refused(() => tenantTx(a, (tx) => tx.$executeRawUnsafe(`DELETE FROM "${TRUST_TABLE}" WHERE "businessId" = $1`, a)));
  await tenantTx(a, (tx) => trust.attachVerificationDocument(
    { businessId: a, userId: userA, claimId: myClaim.id, storageKey: `biz/${a}/trust/claim-${myClaim.id}/doc-1-abc.pdf`, sha256: "b".repeat(64), mimeType: "application/pdf" }, tx));
  const myApproved = await tenantTx(a, (tx) => trust.setTrustClaimPublicUse({ businessId: a, userId: userA, claimId: myClaim.id, approved: true }, tx));
  const myDocRef = await tenantTx(a, (tx) => trust.verificationDocumentRef({ businessId: a, claimId: myClaim.id }, tx));
  const ctxA = await tenantTx(a, (tx) => getBusinessIdentityContext(a, tx));
  const aiA = identityContextForAi(ctxA);

  // Document lifecycle against the REAL database (row lock, RLS) and a real local storage root.
  const { storeVerificationDocument } = await import("@/lib/services/trust/trust-document-storage");
  const { LocalFsStorageService } = await import("@/lib/storage");
  const { mkdtemp, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const docRoot = await mkdtemp(path.join(tmpdir(), "p3a-rls-docs-"));
  const storage = new LocalFsStorageService({ provider: "local", localRoot: docRoot, signedUrlTtlSeconds: 60 });
  const leaks: unknown[] = [];
  const pdf = (tag: string) => Buffer.concat([Buffer.from(`%PDF-1.7\n${tag}\n`), Buffer.alloc(32)]);
  const store = (businessId: number, claimId: number, tag: string) =>
    storeVerificationDocument({ businessId, claimId, mimeType: "application/pdf", body: pdf(tag) }, {
      storage,
      onLeak: (l) => leaks.push(l),
      attach: (doc) => tenantTx(businessId, (tx) => trust.attachVerificationDocument({ businessId, userId: userA, claimId, ...doc }, tx)),
      currentKey: () => tenantTx(businessId, (tx) => trust.currentVerificationDocumentKey({ businessId, claimId }, tx)),
    });
  const objects = async (businessId: number, claimId: number) => {
    try {
      return (await readdir(path.join(docRoot, "biz", String(businessId), "trust", `claim-${claimId}`))).filter((f) => !f.endsWith(".meta.json"));
    } catch {
      return [];
    }
  };
  const dbKey = () => tenantTx(a, (tx) => trust.currentVerificationDocumentKey({ businessId: a, claimId: myClaim.id }, tx));
  const d1 = await store(a, myClaim.id, "d1");
  const afterD1 = { key: await dbKey(), files: await objects(a, myClaim.id) };
  const d3 = await store(a, myClaim.id, "d3");
  const afterD3 = { key: await dbKey(), files: await objects(a, myClaim.id) };
  const raced = await Promise.allSettled([1, 2, 3, 4].map((i) => store(a, myClaim.id, `race-${i}`)));
  const afterRace = { key: await dbKey(), files: await objects(a, myClaim.id), fulfilled: raced.filter((r) => r.status === "fulfilled").length };
  // Cross-tenant: A's session aims the whole flow at B's claim id (skipping the route's ownership read).
  const crossTenant = await refused(() => store(a, claimB, "cross"));
  const crossTenantFiles = (await objects(a, claimB)).length + (await objects(b, claimB)).length;

  await tenantTx(a, (tx) => trust.retireTrustClaim({ businessId: a, userId: userA, claimId: myClaim.id }, tx));
  // Stale: the claim was retired after any earlier ownership check — the attach refuses, nothing is left.
  const staleFilesBefore = (await objects(a, myClaim.id)).length;
  const stale = await refused(() => store(a, myClaim.id, "stale"));
  const staleFilesAfter = (await objects(a, myClaim.id)).length;
  await rm(docRoot, { recursive: true, force: true });
  const ctxAfterRetire = await tenantTx(a, (tx) => getBusinessIdentityContext(a, tx));
  const retiredFrozen = await tenantTx(a, (tx) => tx.$executeRawUnsafe(`UPDATE "${TRUST_TABLE}" SET "status" = 'ACTIVE', "retiredAt" = NULL, "retiredByUserId" = NULL WHERE "id" = $1`, myClaim.id));
  const servedA = await tenantTx(a, (tx) => trust.loadServedCustomers(a, tx));
  const servedBUnderA = await tenantTx(a, (tx) => trust.loadServedCustomers(b, tx));

  // ── P3-B · landing strategy set across tenants ──
  const { getLandingStrategySet } = await import("@/lib/services/landing/landing-strategy.service");
  const { getLandingBusinessContext } = await import("@/lib/services/landing/landing-business-context");
  const bServiceId = Number(process.env.P3B_B_SERVICE);
  const bAssetId = Number(process.env.P3B_B_ASSET);
  const aAssetId = Number(process.env.P3B_A_ASSET);
  const aServiceIds = String(process.env.P3B_A_SERVICES).split(",").map(Number);
  const landingBFromA = await refused(() => tenantTx(a, (tx) => getLandingStrategySet(b, tx)));
  // S20: the whole strategy computation runs inside a READ ONLY transaction — any write would fail.
  const readOnlyRun = await refused(() => tenantTx(a, async (tx) => { await tx.$executeRawUnsafe("SET LOCAL transaction_read_only = on"); return getLandingStrategySet(a, tx); }));
  const readOnlyBites = await refused(() => tenantTx(a, async (tx) => { await tx.$executeRawUnsafe("SET LOCAL transaction_read_only = on"); await tx.$executeRawUnsafe(`UPDATE "BusinessIdentityStatement" SET "updatedAt" = now() WHERE "businessId" = $1`, a); }));
  const landingSetA = await tenantTx(a, async (tx) => { await tx.$executeRawUnsafe("SET LOCAL transaction_read_only = on"); return getLandingStrategySet(a, tx); });
  const landingCtxA = await tenantTx(a, (tx) => getLandingBusinessContext(a, tx));
  const landingCtxB = await tenantTx(b, (tx) => getLandingBusinessContext(b, tx)); // positive control: B's own data is real
  const landing = {
    landingBFromA, readOnlyRun, readOnlyBites,
    aOfferingIds: landingCtxA.offerings.active.map((o) => o.id),
    aPublicAssets: landingCtxA.assets.publicApproved.map((x) => x.id), aNotApproved: landingCtxA.assets.notApprovedCount,
    aDemand: landingCtxA.demand.totalSignals, aSignals: landingCtxA.supportedSignals,
    aTrust: landingCtxA.publishable.trustClaims.map((c) => c.id),
    aStrategies: landingSetA.strategies.map((x) => x.strategyType),
    aStrategyOfferings: landingSetA.strategies.flatMap((x) => x.publishable.offeringRefs.map((r) => r.id)),
    aStrategyAssets: landingSetA.strategies.flatMap((x) => x.publishable.assetIds),
    aStrategyTrust: landingSetA.strategies.flatMap((x) => x.publishable.trustClaimIds),
    aAuthority: [landingSetA.authority, ...landingSetA.strategies.map((x) => x.authority)],
    bOwn: { assets: landingCtxB.assets.publicApproved.map((x) => x.id), demand: landingCtxB.demand.totalSignals, featured: landingCtxB.offerings.active.filter((o) => o.ownerFeatured).map((o) => o.id), trust: landingCtxB.publishable.trustClaims.map((c) => c.id), signals: landingCtxB.supportedSignals },
    ids: { bServiceId, bAssetId, aAssetId, aServiceIds },
  };

  // ── P3-C · blueprint composition: server-recomputed strategy, tenant-scoped, single-flight ──
  const { composeLandingBlueprintForBusiness, resetComposerCacheForTests } = await import("@/lib/services/landing/composer/landing-blueprint.service");
  const { fakeModel, goodDraft } = await import("@/lib/services/landing/__fixtures__/composer-fakes");
  const setB = await tenantTx(b, (tx) => getLandingStrategySet(b, tx));
  const aIds = landingSetA.strategies.map((x) => x.id);
  const bOnlyId = setB.strategies.map((x) => x.id).find((id) => !aIds.includes(id)) ?? null;
  const counting = fakeModel((c) => goodDraft(c));
  resetComposerCacheForTests();
  const [c1, c2] = await Promise.all([
    composeLandingBlueprintForBusiness(a, aIds[0], { model: counting }),
    composeLandingBlueprintForBusiness(a, aIds[0], { model: counting }),
  ]);
  const composeBOnly = bOnlyId ? await refused(() => composeLandingBlueprintForBusiness(a, bOnlyId, { model: counting })) : "NO_B_ONLY_ID";
  const composeForged = await refused(() => composeLandingBlueprintForBusiness(a, "p3b.strategy.v1:CHECKOUT_FIRST:BUY:DUBIZ_CHECKOUT", { model: counting }));
  const composeObject = await refused(() => composeLandingBlueprintForBusiness(a, { strategyType: "TRUST_AUTHORITY_FIRST", publishable: { trustClaimIds: [claimB] } }, { model: counting }));
  const composer = {
    calls: counting.calls, same: c1 === c2, status: c1.compositionStatus, bOnlyId, composeBOnly, composeForged, composeObject,
    refs: c1.blueprint ? { offerings: c1.blueprint.offeringRefs, trust: c1.blueprint.trustClaimRefs, assets: c1.blueprint.assetRefs, business: c1.blueprint.businessId } : null,
    promptHasB: counting.prompts.some((pr) => pr.includes(`offering:SERVICE:${bServiceId}`) || pr.includes(`asset:${bAssetId}`) || pr.includes(`trust:${claimB}`)),
  };

  console.log(
    "@@RESULT@@" +
      JSON.stringify({
        role: role[0],
        noContext,
        leakedUnderA,
        readB,
        ownName, factsNoContext, factsBFromA, businessWriteB, businessOtherColumn,
        listB: listB.length,
        evidenceB: evidenceB.services.length + evidenceB.products.length + evidenceB.demand.length + (evidenceB.contentChoices?.length ?? 0),
        factNoContext, factsBUnderA: factsBUnderA.length, approveFactForB, withdrawFactB, rawFactUpdateB, factDeleteRefused,
        myFact: myFact ? { business: myFact.businessId, approved: myFact.publicUseApproved } : null,
        memoryBUnderA: memoryBUnderA.identityStatements.length + memoryBUnderA.identityFacts.length,
        memoryA: { statements: memoryA.identityStatements.map((s) => s.id), facts: memoryA.identityFacts.map((f) => f.id) },
        resolveBStatementAsB, resolveBStatementAsA, resolveBFact,
        resolveOwn: resolveOwn ? { id: resolveOwn.row.id, business: resolveOwn.row.businessId } : null,
        ownA: ownA.statements.map((s) => s.id),
        createForB, rawInsertB, retireB, retireBasB, approveB, replaceB, rawUpdateB, repointAtoB,
        adoptBEvidence, adoptAsB,
        mine: { business: mine.businessId, approved: mineApproved.publicUseApproved },
        deleteRefused,
        p3a: {
          trustNoContext, ctxBFromA, claimsBUnderA, withdrawBClaim, withdrawBClaimAsB, retireBClaim, confirmForB, rawUpdateBClaim, attachToB,
          docRefB, docRefBAsB, docKeyRowsB, trustMemoryBUnderA,
          approveEarly, rawPublicInsert, rawWordingUpdate, claimDelete,
          myApproved: { business: myApproved.businessId, approved: myApproved.publicUseApproved },
          myDocRef,
          ctxA: {
            claimIds: ctxA.trust.claims.map((c) => c.id),
            publicIds: ctxA.publicUse.trustClaims.map((c) => c.id),
            served: ctxA.trust.servedCustomers.count,
            whatsapp: ctxA.conversion.channels.find((c) => c.channel === "WHATSAPP_CLOUD")?.state,
            json: JSON.stringify(ctxA) + JSON.stringify(aiA),
          },
          afterRetire: { claimIds: ctxAfterRetire.trust.claims.map((c) => c.id), publicIds: ctxAfterRetire.publicUse.trustClaims.map((c) => c.id) },
          retiredFrozen, servedA, servedBUnderA,
          landing, composer,
          docs: {
            d1: { old: d1.oldDocument, key: afterD1.key, files: afterD1.files },
            d3: { old: d3.oldDocument, key: afterD3.key, files: afterD3.files, replacedFrom: afterD1.key },
            race: afterRace,
            crossTenant, crossTenantFiles,
            stale, staleFilesBefore, staleFilesAfter,
            leaks: leaks.length,
            claimJson: JSON.stringify(d3.claim),
          },
          myClaimId: myClaim.id,
        },
      }) +
      "@@END@@\n",
  );
  await prisma.$disconnect();
}

/* ───────────────────────────── parent: owner setup ──────────────────────────── */

async function main() {
  const { prisma } = await import("@/lib/prisma");

  console.log(`\n1 · replay the P2 migration (${P2_MIGRATION}) with app_runtime present`);
  const password = randomBytes(18).toString("hex");
  await prisma.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF; END $$`);
  await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
  for (const table of [...P2_TABLES, TRUST_TABLE]) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  for (const type of P2_TYPES) await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "${type}" CASCADE`);
  let applied = 0;
  const p2Statements = migrationStatements(P2_MIGRATION);
  for (const statement of p2Statements) {
    await prisma.$executeRawUnsafe(statement);
    applied += 1;
  }
  ok(`applied all ${applied} statements of the P2 migration verbatim, none tolerated`, applied === p2Statements.length && applied >= 25, applied);
  for (const migration of P3A_MIGRATIONS) {
    const statements = migrationStatements(migration);
    let n = 0;
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
      n += 1;
    }
    ok(`applied all ${n} statements of ${migration} verbatim, none tolerated`, n === statements.length && n >= 2, n);
  }
  // Some base-table policies are granted TO the env-neutral NOLOGIN `app_admin` group, which
  // Production has (20260825090000_d2_p7_w2gate_admin_read). Created here exactly as that migration
  // does; app_runtime is not a member, so it changes nothing about the runtime's isolation.
  await prisma.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
      CREATE ROLE app_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
    END IF; END $$`);

  console.log("\n1b · replay base-table RLS from the migrations that own it");
  for (const { migration, tables } of BASE_RLS) {
    for (const statement of migrationStatements(migration)) {
      if (!/ROW LEVEL SECURITY|POLICY/i.test(statement)) continue;
      if (!tables.some((table) => new RegExp(`"${table}"(?![A-Za-z])`).test(statement))) continue;
      try {
        await prisma.$executeRawUnsafe(statement);
      } catch (error) {
        if (!alreadyThere(error)) throw error;
      }
    }
  }
  const baseRls = await prisma.$queryRawUnsafe<Array<{ relname: string; rls: boolean; forced: boolean }>>(
    `SELECT relname::text, relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relkind = 'r' AND relname = ANY($1::text[])`,
    TENANT_READ_TABLES);
  ok("every base table the identity read model reads is tenant-RLS'd and FORCED", baseRls.length === TENANT_READ_TABLES.length && baseRls.every((r) => r.rls && r.forced), baseRls);

  for (const table of P2_TABLES) {
    const rls = await prisma.$queryRawUnsafe<Array<{ rls: boolean; forced: boolean }>>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = $1 AND relkind = 'r'`, table);
    const policies = await prisma.$queryRawUnsafe<Array<{ policyname: string; cmd: string; expr: string }>>(
      `SELECT policyname::text, cmd::text, coalesce(qual, with_check)::text AS expr FROM pg_policies WHERE tablename = $1 ORDER BY policyname`, table);
    ok(`${table}: RLS enabled and FORCED`, rls.length === 1 && rls[0].rls && rls[0].forced, rls);
    ok(`${table}: per-command SELECT / INSERT / UPDATE policies on app.current_business_id; no ALL, no DELETE`,
      JSON.stringify(policies.map((p) => p.cmd).sort()) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]) &&
      policies.every((p) => p.expr.includes("app.current_business_id")), policies);
    const grants = await prisma.$queryRawUnsafe<Array<{ privilege_type: string }>>(
      `SELECT privilege_type::text FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = $2`, ROLE, table);
    ok(`${table}: the migration's own grants are SELECT / INSERT / UPDATE, never DELETE or TRUNCATE`,
      ["SELECT", "INSERT", "UPDATE"].every((p) => grants.some((g) => g.privilege_type === p)) &&
      !grants.some((g) => g.privilege_type === "DELETE" || g.privilege_type === "TRUNCATE"), grants);
  }

  {
    const rls = await prisma.$queryRawUnsafe<Array<{ rls: boolean; forced: boolean }>>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relname = $1 AND relkind = 'r'`, TRUST_TABLE);
    const policies = await prisma.$queryRawUnsafe<Array<{ cmd: string; expr: string }>>(
      `SELECT cmd::text, (coalesce(qual, '') || ' ' || coalesce(with_check, ''))::text AS expr FROM pg_policies WHERE tablename = $1 ORDER BY cmd`, TRUST_TABLE);
    const tableGrants = await prisma.$queryRawUnsafe<Array<{ privilege_type: string }>>(
      `SELECT privilege_type::text FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = $2 ORDER BY 1`, ROLE, TRUST_TABLE);
    const updateCols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name::text FROM information_schema.column_privileges WHERE grantee = $1 AND table_name = $2 AND privilege_type = 'UPDATE' ORDER BY 1`, ROLE, TRUST_TABLE);
    ok(`${TRUST_TABLE}: RLS enabled and FORCED`, rls.length === 1 && rls[0].rls && rls[0].forced, rls);
    ok(`${TRUST_TABLE}: SELECT / INSERT / UPDATE policies on app.current_business_id; no ALL, no DELETE`,
      JSON.stringify(policies.map((p) => p.cmd)) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]) && policies.every((p) => p.expr.includes("app.current_business_id")), policies);
    ok(`${TRUST_TABLE}: the migration grants SELECT + INSERT table-wide, never DELETE / TRUNCATE / a table-wide UPDATE`,
      JSON.stringify(tableGrants.map((g) => g.privilege_type)) === JSON.stringify(["INSERT", "SELECT"]), tableGrants);
    ok(`${TRUST_TABLE}: UPDATE is column-scoped to approval, verification and retirement — kind, wording, parameters, evidence, tenant are immutable`,
      updateCols.length > 0 && !updateCols.some((c) => ["businessId", "claimKind", "claimClass", "scopeKey", "params", "wording", "wordingHash", "evidenceCondition", "confirmedAt", "validUntil"].includes(c.column_name)), updateCols);
  }

  // Base tables: read-only grants, as the Production ops scripts give (none of them is P2's to grant).
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
  for (const table of READ_TABLES) await prisma.$executeRawUnsafe(`GRANT SELECT ON "${table}" TO ${ROLE}`);

  console.log("\n1c · Business exactly as in Production: column privileges + B4 (replayed verbatim)");
  await prisma.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
      CREATE ROLE app_auth NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF; END $$`);
  // The runtime's Business privileges, from the migration that narrowed them (Business statements only).
  for (const statement of migrationStatements(BUSINESS_COLUMN_GRANT_MIGRATION)) {
    if (/ON\s+public\."Business"\s+(FROM|TO)\s+app_runtime/i.test(statement)) await prisma.$executeRawUnsafe(statement);
  }
  const businessRls = await prisma.$queryRawUnsafe<Array<{ rls: boolean }>>(
    `SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'Business' AND relkind = 'r'`);
  if (!businessRls[0]?.rls) {
    for (const statement of migrationStatements(B4_MIGRATION)) await prisma.$executeRawUnsafe(statement);
  }
  const businessPolicies = await prisma.$queryRawUnsafe<Array<{ cmd: string }>>(
    `SELECT cmd::text FROM pg_policies WHERE tablename = 'Business' ORDER BY cmd`);
  const businessCols = await prisma.$queryRawUnsafe<Array<{ column_name: string; privilege_type: string }>>(
    `SELECT column_name::text, privilege_type::text FROM information_schema.column_privileges
      WHERE grantee = $1 AND table_name = 'Business' AND privilege_type = 'SELECT' ORDER BY column_name`, ROLE);
  const businessTable = await prisma.$queryRawUnsafe<Array<{ privilege_type: string }>>(
    `SELECT privilege_type::text FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name = 'Business'`, ROLE);
  ok("Business: B4 in force (FORCE RLS; SELECT/UPDATE/INSERT policies, no DELETE policy)",
    JSON.stringify(businessPolicies.map((p) => p.cmd)) === JSON.stringify(["INSERT", "SELECT", "UPDATE"]), businessPolicies);
  ok("Business: the runtime holds no table-wide privilege; it may SELECT only id, name, createdAt, deletionRequestedAt, deletedAt",
    businessTable.length === 0 &&
    JSON.stringify(businessCols.map((c) => c.column_name)) === JSON.stringify(["createdAt", "deletedAt", "deletionRequestedAt", "id", "name"]),
    { businessTable, businessCols });

  console.log("\n2 · fixtures (owner connection)");
  const tag = `qa-p2-rls-${Date.now()}`;
  const a = await prisma.business.create({ data: { name: `${tag}-A` } });
  const b = await prisma.business.create({ data: { name: `${tag}-B` } });
  const userA = await prisma.user.create({ data: { email: `${tag}@example.test`, password: "not-a-real-password", businessId: a.id } });
  try {
    await prisma.businessProfile.create({ data: { businessId: b.id, category: "Home Services", city: "חיפה" } });
    await prisma.businessService.create({ data: { businessId: b.id, name: "ביקור בית", type: "SERVICE", fulfillment: "AT_CUSTOMER" } });
    const stA = await prisma.businessIdentityStatement.create({ data: { businessId: a.id, dimension: "TONE", code: "WARM", source: "OWNER_INPUT" } });
    const stB = await prisma.businessIdentityStatement.create({ data: { businessId: b.id, dimension: "TONE", code: "PROFESSIONAL", source: "OWNER_INPUT" } });
    const txtB = await prisma.businessIdentityStatement.create({ data: { businessId: b.id, dimension: "DIFFERENTIATOR", text: "טכנאי מוסמך", source: "OWNER_INPUT" } });
    const { factValueHash } = await import("./identity-fact-authority.service");
    const factBRow = await prisma.businessIdentityFactAuthority.create({
      data: { businessId: b.id, fact: "CITY", sourceField: "BusinessProfile.city", valueHash: factValueHash("חיפה"), publicUseApproved: true, publicUseApprovedAt: new Date() },
    });
    // P3-A · B holds a documented, public licence claim and a connected WhatsApp; A has billing-like
    // customer rows of which only two were really served (COMPLETED appointment ∪ WON lead).
    const { normalizeTrustClaim, wordingHash } = await import("@/lib/services/trust/trust-claim-catalogue");
    const licB = normalizeTrustClaim("LICENSED", { licenseType: "חשמלאי", issuer: "משרד העבודה" }, { now: new Date(), servedCustomers: null });
    const claimBRow = await prisma.businessTrustClaim.create({
      data: {
        businessId: b.id, claimKind: licB.kind, claimClass: licB.claimClass, scopeKey: licB.scopeKey, params: licB.params, wording: licB.wording,
        wordingHash: wordingHash(licB.wording), confirmedByUserId: userA.id,
        verificationMethod: "OWNER_DOCUMENT", verificationAttachmentKey: `biz/${b.id}/trust/claim-1/doc-1-secret.pdf`, verificationAttachmentSha256: "a".repeat(64),
        verificationAttachmentMimeType: "application/pdf", verifiedAt: new Date(),
        publicUseApproved: true, publicUseApprovedAt: new Date(), publicUseApprovedByUserId: userA.id,
      },
    });
    await prisma.whatsAppConnection.create({
      data: { businessId: b.id, phoneNumberId: `${tag}-pn`, displayPhoneNumber: "+972500000000", wabaId: `${tag}-waba`, accessTokenEncrypted: "x", accessTokenIv: "x", accessTokenTag: "x" },
    });
    const appt = (businessId: number, customerId: number, status: "COMPLETED" | "PROPOSED") =>
      prisma.appointment.create({ data: { businessId, customerId, status, createdByActor: "OWNER", sourceChannel: "INBOX_WEB", createdByUserId: userA.id } });
    const customersA = [];
    for (let i = 0; i < 12; i += 1) customersA.push(await prisma.customer.create({ data: { businessId: a.id, name: `${tag}-ca-${i}` } }));
    await appt(a.id, customersA[0].id, "COMPLETED");
    await appt(a.id, customersA[1].id, "COMPLETED");
    await appt(a.id, customersA[2].id, "PROPOSED");
    await prisma.lead.create({ data: { businessId: a.id, customerId: customersA[1].id, status: "WON" } });
    await prisma.lead.create({ data: { businessId: a.id, customerId: customersA[2].id, status: "LOST" } });
    for (let i = 0; i < 5; i += 1) {
      const c = await prisma.customer.create({ data: { businessId: b.id, name: `${tag}-cb-${i}` } });
      await appt(b.id, c.id, "COMPLETED");
    }

    // P3-B · B: a featured service with a PUBLIC-approved image and real completed-booking demand (12 signals).
    // A: three plain services and one UNAPPROVED asset. Nothing of B may reach A's landing context.
    const bService = await prisma.businessService.findFirstOrThrow({ where: { businessId: b.id } });
    await prisma.businessService.update({ where: { id: bService.id }, data: { featuredByOwner: true } });
    const bAsset = await prisma.businessAsset.create({ data: { businessId: b.id, origin: "OWNER_UPLOAD", publicUseApproved: true } });
    await prisma.businessServiceAsset.create({ data: { businessId: b.id, businessServiceId: bService.id, businessAssetId: bAsset.id } });
    for (let i = 0; i < 12; i += 1) {
      const ap = await appt(b.id, (await prisma.customer.create({ data: { businessId: b.id, name: `${tag}-cbd-${i}` } })).id, "COMPLETED");
      await prisma.offeringDemandSignal.create({ data: { businessId: b.id, offeringKind: "SERVICE", businessServiceId: bService.id, appointmentId: ap.id, signalType: "BOOKING", source: "APPOINTMENT", idempotencyKey: `${tag}-bd-${i}` } });
    }
    const aServiceIds: number[] = [];
    for (let i = 0; i < 3; i += 1) aServiceIds.push((await prisma.businessService.create({ data: { businessId: a.id, name: `${tag}-a-svc-${i}`, type: "SERVICE" } })).id);
    const aAsset = await prisma.businessAsset.create({ data: { businessId: a.id, origin: "OWNER_UPLOAD", publicUseApproved: false } });

    // B's explicit content tone choices: real owner evidence — for B only.
    for (let i = 0; i < 3; i += 1) {
      await prisma.contentRun.create({ data: { businessId: b.id, inputSnapshot: { schemaVersion: 1, generatedAt: new Date().toISOString(), source: "user",
        data: { selectedDirection: { tone: "premium" }, audienceTypes: ["new"], choiceProvenance: { tone: "OWNER_SELECTED", audience: "DERIVED" } } } } });
    }

    console.log("\n3 · real P2 code as app_runtime (NOSUPERUSER NOBYPASSRLS)");
    const url = new URL(TEST_DB!);
    url.username = ROLE;
    url.password = password;
    const run = spawnSync("npx", ["tsx", process.argv[1]], {
      shell: process.platform === "win32",
      encoding: "utf8",
      env: {
        ...process.env,
        P2_RLS_CHILD: "1",
        DATABASE_URL: url.toString(),
        P2_BUSINESS_A: String(a.id),
        P2_BUSINESS_B: String(b.id),
        P2_USER_A: String(userA.id),
        P2_STATEMENT_A: String(stA.id),
        P2_STATEMENT_B: String(stB.id),
        P2_TEXT_STATEMENT_B: String(txtB.id),
        P2_FACT_B: String(factBRow.id),
        P2_NAME_A: a.name,
        P3_CLAIM_B: String(claimBRow.id),
        P3B_B_SERVICE: String(bService.id),
        P3B_B_ASSET: String(bAsset.id),
        P3B_A_ASSET: String(aAsset.id),
        P3B_A_SERVICES: aServiceIds.join(","),
      },
      timeout: 180_000,
    });
    const match = /@@RESULT@@(.*)@@END@@/s.exec(run.stdout ?? "");
    ok("child ran as app_runtime", run.status === 0 && !!match, (run.stderr ?? "").slice(-2000));
    if (match) {
      const r = JSON.parse(match[1]);
      const rlsRefusal = (s: string | null) => /row-level security/i.test(s ?? "");
      ok("runtime role is neither superuser nor BYPASSRLS", !r.role.rolsuper && !r.role.rolbypassrls);
      ok("no tenant context → zero identity rows", r.noContext === 0, r.noContext);
      ok("under A's context → zero of B's identity rows", r.leakedUnderA === 0, r.leakedUnderA);
      ok("CROSS-TENANT IDENTITY READ: B's identity asked for under A is refused before anything is read (B4 keeps Business reads open, so the read model pins them)",
        /IdentityTenantMismatchError/.test(r.readB ?? ""), r.readB);
      ok("B4 · A reads its own Business.name under the Production column grants and policies", r.ownName === a.name, r.ownName);
      ok("B4 · Business.name is not read without a tenant context (fails closed)", /IdentityTenantMismatchError/.test(r.factsNoContext ?? ""), r.factsNoContext);
      ok("B4 · Business.name of B is not read from A's transaction", /IdentityTenantMismatchError/.test(r.factsBFromA ?? ""), r.factsBFromA);
      ok("B4 · a write to B's Business row from A's transaction touches nothing", r.businessWriteB === 0, r.businessWriteB);
      ok("B4 · columns outside the runtime's Business grant stay unreadable", /permission denied/i.test(r.businessOtherColumn ?? ""), r.businessOtherColumn);
      ok("CROSS-TENANT IDENTITY READ: B's statement list under A is empty", r.listB === 0);
      ok("CROSS-TENANT IDENTITY READ: B's offering / demand / content evidence under A is empty", r.evidenceB === 0, r.evidenceB);
      ok("A still reads its own statement", r.ownA.includes(Number(stA.id)));
      ok("CROSS-TENANT IDENTITY WRITE: the service writing B's row under A is refused by RLS", rlsRefusal(r.createForB), r.createForB);
      ok("CROSS-TENANT IDENTITY WRITE: a raw B row under A is refused by RLS", rlsRefusal(r.rawInsertB), r.rawInsertB);
      ok("CROSS-TENANT POSITIONING UPDATE: retiring B's statement as A → not found", /IdentityNotFoundError/.test(r.retireB ?? ""), r.retireB);
      ok("CROSS-TENANT POSITIONING UPDATE: retiring B's statement claiming B under A → not found", /IdentityNotFoundError/.test(r.retireBasB ?? ""), r.retireBasB);
      ok("CROSS-TENANT POSITIONING UPDATE: approving B's text for public use under A → not found", /IdentityNotFoundError/.test(r.approveB ?? ""), r.approveB);
      ok("CROSS-TENANT POSITIONING UPDATE: 'replacing' B's statement from A → not found", /IdentityNotFoundError/.test(r.replaceB ?? ""), r.replaceB);
      ok("CROSS-TENANT POSITIONING UPDATE: a raw UPDATE of B's row under A touches nothing", r.rawUpdateB === 0, r.rawUpdateB);
      ok("CROSS-TENANT POSITIONING UPDATE: re-pointing A's row to B is refused by RLS", rlsRefusal(r.repointAtoB), r.repointAtoB);
      ok("CROSS-TENANT EVIDENCE LINK: adopting a suggestion only B's evidence supports is refused for A",
        /not currently supported/.test(r.adoptBEvidence ?? ""), r.adoptBEvidence);
      ok("CROSS-TENANT EVIDENCE LINK: adopting it as B from A's session is refused", r.adoptAsB !== null, r.adoptAsB);
      ok("A's own write + public-use approval work under RLS", r.mine.business === a.id && r.mine.approved === true, r.mine);
      ok("identity history cannot be deleted by the runtime role", /permission denied/i.test(r.deleteRefused ?? ""), r.deleteRefused);

      ok("FACT AUTHORITY: no tenant context → zero rows", r.factNoContext === 0, r.factNoContext);
      ok("FACT AUTHORITY: B's authorities are invisible under A", r.factsBUnderA === 0, r.factsBUnderA);
      ok("FACT AUTHORITY: approving B's business name from A's session is refused (tenant pin before the read; RLS behind it)",
        /IdentityTenantMismatchError/.test(r.approveFactForB ?? "") || rlsRefusal(r.approveFactForB), r.approveFactForB);
      ok("FACT AUTHORITY: withdrawing B's city approval from A is refused (tenant pin first; not-found behind it)", /IdentityTenantMismatchError|IdentityNotFoundError/.test(r.withdrawFactB ?? ""), r.withdrawFactB);
      ok("FACT AUTHORITY: a raw UPDATE of B's authority under A touches nothing", r.rawFactUpdateB === 0, r.rawFactUpdateB);
      ok("FACT AUTHORITY: authority history cannot be deleted by the runtime role", /permission denied/i.test(r.factDeleteRefused ?? ""), r.factDeleteRefused);
      ok("FACT AUTHORITY: A approves its own name under RLS", r.myFact?.business === a.id && r.myFact?.approved === true, r.myFact);

      ok("MEMORY: B's identity knowledge loaded under A is empty", r.memoryBUnderA === 0, r.memoryBUnderA);
      ok("MEMORY: A's identity knowledge holds A's own references", r.memoryA.statements.length >= 1 && r.memoryA.facts.length === 1, r.memoryA);
      ok("MEMORY REFERENCE: B's statement id cannot be resolved from A's session, even claiming B", r.resolveBStatementAsB === null && r.resolveBStatementAsA === null);
      ok("MEMORY REFERENCE: B's fact-authority id cannot be resolved from A's session", r.resolveBFact === null);
      ok("MEMORY REFERENCE: A's own reference resolves to A's row", r.resolveOwn?.id === Number(stA.id) && r.resolveOwn?.business === a.id, r.resolveOwn);

      const p = r.p3a;
      // T1 — a business sees only its own identity / trust context.
      ok("P3-A T1: no tenant context → zero trust claims", p.trustNoContext === 0, p.trustNoContext);
      ok("P3-A T1: B's canonical context asked for from A's session is refused before anything is read", /IdentityTenantMismatchError/.test(p.ctxBFromA ?? ""), p.ctxBFromA);
      ok("P3-A T1: A's context holds only A's claims (B's public claim is absent)", !p.ctxA.claimIds.includes(Number(claimBRow.id)) && p.ctxA.claimIds.includes(p.myClaimId), p.ctxA.claimIds);
      ok("P3-A T1: A's context does not see B's WhatsApp connection", p.ctxA.whatsapp === "NOT_CONFIGURED", p.ctxA.whatsapp);
      ok("P3-A T1: nothing of B (wording, document key) appears in A's context or AI projection",
        !p.ctxA.json.includes(licB.wording) && !p.ctxA.json.includes(`biz/${b.id}/`) && !p.ctxA.json.includes("verificationAttachmentKey"));
      // T16 — cross-tenant claim access denied.
      ok("P3-A T16: B's claims listed under A → empty", p.claimsBUnderA === 0, p.claimsBUnderA);
      ok("P3-A T16: withdrawing B's claim as A → not found", /TrustClaimNotFoundError/.test(p.withdrawBClaim ?? ""), p.withdrawBClaim);
      ok("P3-A T16: withdrawing B's claim claiming B from A's session → not found (RLS)", /TrustClaimNotFoundError/.test(p.withdrawBClaimAsB ?? ""), p.withdrawBClaimAsB);
      ok("P3-A T16: retiring B's claim from A's session → not found", /TrustClaimNotFoundError/.test(p.retireBClaim ?? ""), p.retireBClaim);
      ok("P3-A T16: creating a claim for B from A's session is refused by RLS", /row-level security/i.test(p.confirmForB ?? ""), p.confirmForB);
      ok("P3-A T16: a raw UPDATE of B's claim under A touches nothing", p.rawUpdateBClaim === 0, p.rawUpdateBClaim);
      ok("P3-A T16: B's claims loaded into Business Memory under A → empty", p.trustMemoryBUnderA === 0, p.trustMemoryBUnderA);
      // T17 — private evidence / document access cross-tenant denied.
      ok("P3-A T17: B's document reference is not served to A (as A or claiming B)", p.docRefB === null && p.docRefBAsB === null, { a: p.docRefB, b: p.docRefBAsB });
      ok("P3-A T17: B's document key is unreadable under A even by raw SQL", p.docKeyRowsB === 0, p.docKeyRowsB);
      ok("P3-A T17: A cannot attach a document to B's claim", /TrustClaimNotFoundError/.test(p.attachToB ?? ""), p.attachToB);
      ok("P3-A T17: A's own document reference resolves under A's private prefix", p.myDocRef?.storageKey?.startsWith(`biz/${a.id}/trust/`) && p.myDocRef?.mimeType === "application/pdf", p.myDocRef);
      // Authority rules enforced by the database under the runtime role.
      ok("P3-A T7: approval without the private document is refused (NEEDS_DOCUMENT)", /NEEDS_DOCUMENT/.test(p.approveEarly ?? ""), p.approveEarly);
      ok("P3-A T6: a claim can never be INSERTed already public, even by raw SQL (RLS)", /row-level security/i.test(p.rawPublicInsert ?? ""), p.rawPublicInsert);
      ok("P3-A: a claim's wording is immutable for the runtime (column-scoped UPDATE)", /permission denied/i.test(p.rawWordingUpdate ?? ""), p.rawWordingUpdate);
      ok("P3-A: claims cannot be deleted by the runtime role", /permission denied/i.test(p.claimDelete ?? ""), p.claimDelete);
      ok("P3-A T10: with its document, A's claim is approved and appears in A's public read model",
        p.myApproved.business === a.id && p.myApproved.approved === true && p.ctxA.publicIds.includes(p.myClaimId), p);
      // Document lifecycle against the real database (row lock + RLS) and real local storage.
      const d = p.docs;
      const fileOf = (key: string | null) => (key ?? "").split("/").pop();
      ok("P3-A D1: upload + attach → the database points at the one stored object",
        d.d1.files.length === 1 && d.d1.files[0] === fileOf(d.d1.key) && d.d1.key?.startsWith(`biz/${a.id}/trust/claim-${p.myClaimId}/`), d.d1);
      ok("P3-A D3: replacement → the database points at NEW, OLD is deleted (one object left)",
        d.d3.old === "DELETED" && d.d3.key !== d.d3.replacedFrom && d.d3.files.length === 1 && d.d3.files[0] === fileOf(d.d3.key), d.d3);
      ok("P3-A D5: four concurrent replacements serialise on the row lock — exactly one object survives, it is the canonical one, no leak",
        d.race.fulfilled === 4 && d.race.files.length === 1 && d.race.files[0] === fileOf(d.race.key) && d.leaks === 0, d.race);
      ok("P3-A D5: a claim retired before the attach is refused and leaves no orphan",
        /TrustClaimNotFoundError/.test(d.stale ?? "") && d.staleFilesAfter === d.staleFilesBefore, { stale: d.stale, before: d.staleFilesBefore, after: d.staleFilesAfter });
      ok("P3-A D6: aiming the upload flow at another business's claim is refused by RLS and leaves no object anywhere",
        /TrustClaimNotFoundError/.test(d.crossTenant ?? "") && d.crossTenantFiles === 0, { crossTenant: d.crossTenant, files: d.crossTenantFiles });
      ok("P3-A: the claim returned to the route never carries the storage key or hash", !/verificationAttachmentKey|biz\/\d+\/trust|Sha256/.test(d.claimJson), d.claimJson);
      // P3-B · S16 tenant isolation of the landing strategy set; S20 read-only.
      const L = p.landing;
      ok("P3-B S16: B's landing strategy set requested from A's session is refused before anything is read", /IdentityTenantMismatchError/.test(L.landingBFromA ?? ""), L.landingBFromA);
      ok("P3-B S16 (positive control): B's own context really has a public asset, 12 demand signals, a featured service and a public trust claim",
        L.bOwn.assets.includes(L.ids.bAssetId) && L.bOwn.demand >= 12 && L.bOwn.featured.includes(L.ids.bServiceId) && L.bOwn.trust.includes(Number(claimBRow.id)) && L.bOwn.signals.includes("BOOKING_DEMAND"), L.bOwn);
      ok("P3-B S16: B's offerings never appear in A (context or any strategy)",
        !L.aOfferingIds.includes(L.ids.bServiceId) && !L.aStrategyOfferings.includes(L.ids.bServiceId) && L.ids.aServiceIds.every((id: number) => L.aOfferingIds.includes(id)), { a: L.aOfferingIds, s: L.aStrategyOfferings });
      ok("P3-B S16: B's evidence cannot influence A (no demand, no BOOKING_DEMAND signal)", L.aDemand === 0 && !L.aSignals.includes("BOOKING_DEMAND"), { d: L.aDemand, s: L.aSignals });
      ok("P3-B S16: B's trust never appears in A", !L.aTrust.includes(Number(claimBRow.id)) && !L.aStrategyTrust.includes(Number(claimBRow.id)));
      ok("P3-B S16: B's assets never appear in A; A's own unapproved asset is not publishable",
        !L.aPublicAssets.includes(L.ids.bAssetId) && !L.aStrategyAssets.includes(L.ids.bAssetId) && !L.aStrategyAssets.includes(L.ids.aAssetId) && L.aNotApproved === 1, L);
      ok("P3-B: A still gets its own strategies from its own catalog", L.aStrategies.includes("SERVICE_DISCOVERY_FIRST"), L.aStrategies);
      ok("P3-B S20: the strategy set is computed in a READ ONLY transaction (it writes nothing) and is a MACHINE_PROPOSAL",
        L.readOnlyRun === null && /read-only transaction/i.test(L.readOnlyBites ?? "") && L.aAuthority.every((x: string) => x === "MACHINE_PROPOSAL"), { ro: L.readOnlyRun, bites: L.readOnlyBites, auth: L.aAuthority });
      // P3-C · composition is server-revalidated and tenant-scoped.
      const C = p.composer;
      ok("P3-C: A composes from its own recomputed strategy (COMPOSED, blueprint bound to A)", C.status === "COMPOSED" && C.refs?.business === a.id, C);
      ok("P3-C: two simultaneous identical requests share ONE model call (single-flight)", C.calls === 1 && C.same === true, { calls: C.calls });
      ok("P3-C T17/S30: B's strategy id (absent from A's recomputed set) cannot be composed under A",
        C.bOnlyId !== null && /LandingStrategyNotAvailableError/.test(C.composeBOnly ?? ""), { id: C.bOnlyId, r: C.composeBOnly });
      ok("P3-C T17: a forged strategy id and a client-built strategy object are refused", /LandingStrategyNotAvailableError/.test(C.composeForged ?? "") && /LandingStrategyNotAvailableError/.test(C.composeObject ?? ""), C);
      ok("P3-C S30: A's blueprint and prompts never reference B's offerings, assets or trust claims",
        !C.promptHasB && !(C.refs?.offerings ?? []).includes(`offering:SERVICE:${L.ids.bServiceId}`) && !(C.refs?.assets ?? []).includes(`asset:${L.ids.bAssetId}`) && !(C.refs?.trust ?? []).includes(`trust:${claimBRow.id}`), C.refs);
      ok("P3-A T9: once retired, the claim leaves the context and public use", !p.afterRetire.claimIds.includes(p.myClaimId) && !p.afterRetire.publicIds.includes(p.myClaimId), p.afterRetire);
      ok("P3-A T9: a retired claim is frozen history (cannot be re-activated by the runtime)", p.retiredFrozen === 0, p.retiredFrozen);
      // T11 — served customers from completed work only, per tenant.
      ok("P3-A T11: served customers = DISTINCT COMPLETED-appointment ∪ WON-lead customers (2), not the 12 customer rows",
        p.servedA === 2 && p.ctxA.served === 2, { servedA: p.servedA, ctx: p.ctxA.served });
      ok("P3-A T11: B's served customers are invisible under A", p.servedBUnderA === 0, p.servedBUnderA);
    }
    const bClaim = await prisma.businessTrustClaim.findUniqueOrThrow({ where: { id: claimBRow.id } });
    ok("owner view: B's trust claim is untouched (ACTIVE, public, document kept)",
      bClaim.status === "ACTIVE" && bClaim.publicUseApproved && bClaim.verificationAttachmentKey === claimBRow.verificationAttachmentKey, bClaim);
    const bFacts = await prisma.businessIdentityFactAuthority.findMany({ where: { businessId: b.id } });
    ok("owner view: B's fact authority is untouched (one ACTIVE, still public)", bFacts.length === 1 && bFacts[0].status === "ACTIVE" && bFacts[0].publicUseApproved, bFacts);
    const bBusiness = await prisma.business.findUniqueOrThrow({ where: { id: b.id }, select: { name: true } });
    ok("owner view: B's Business row is untouched", bBusiness.name === b.name);

    // Static: the identity code never writes Business (B4 pins writes; P2 must not need any).
    const { readdirSync, readFileSync: read } = await import("node:fs");
    const srcFiles = [
      ...readdirSync(path.join(process.cwd(), "lib/services/identity")).filter((f) => f.endsWith(".ts") && !f.includes(".test.")).map((f) => `lib/services/identity/${f}`),
      "app/api/business/identity/route.ts", "app/api/business/identity/[id]/route.ts",
      "app/api/business/identity/suggestions/route.ts", "app/api/business/identity/facts/route.ts",
    ];
    const writers = srcFiles.filter((f) => /\.business\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\b|(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"Business"\b/.test(read(path.join(process.cwd(), f), "utf8")));
    ok("no identity code path writes Business", writers.length === 0, writers);

    const bRows = await prisma.businessIdentityStatement.findMany({ where: { businessId: b.id }, orderBy: { id: "asc" } });
    ok("owner view: B's two statements are untouched (still ACTIVE, same code, never approved)",
      bRows.length === 2 && bRows.every((row) => row.status === "ACTIVE" && !row.publicUseApproved) && bRows[0].code === "PROFESSIONAL", bRows);
    const aRows = await prisma.businessIdentityStatement.findMany({ where: { businessId: a.id } });
    ok("owner view: nothing of A's leaked into B and A's rows are all A's", aRows.every((row) => row.businessId === a.id) && aRows.length === 2, aRows.length);
  } finally {
    await prisma.businessTrustClaim.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.offeringDemandSignal.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessServiceAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessAsset.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.whatsAppConnection.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.appointment.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.lead.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.contentRun.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessIdentityFactAuthority.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessIdentityStatement.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessService.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.businessProfile.deleteMany({ where: { businessId: { in: [a.id, b.id] } } });
    await prisma.user.deleteMany({ where: { businessId: a.id } });
    await prisma.business.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await prisma.$disconnect();
  }

  if (failed > 0) {
    console.error(`P2 identity RLS: ${failed} failed`);
    process.exit(1);
  }
  console.log("P2 identity RLS: all checks passed");
}

(IS_CHILD ? child() : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
