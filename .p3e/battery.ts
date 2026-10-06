/**
 * P3-E — what migration 20261013090000_p3e_landing_persistence does, measured with the real tenant
 * runtime login (app_runtime_prod: NOSUPERUSER, NOBYPASSRLS) on a Production-shaped database.
 *
 *   1. tenant isolation: A cannot read, create, approve, re-point or supersede B's page or versions;
 *      no tenant context fails closed; no DELETE, no TRUNCATE; a cross-tenant pointer or lineage link
 *      is refused by the composite foreign keys;
 *   2. authority: a version enters as an owner-saved DRAFT, or APPROVED only as a rollback naming its
 *      source; never SUPERSEDED / RETIRED on insert; approval always says when and by whom;
 *   3. immutability: snapshot, strategy, engine versions, fingerprints, creator and tenant never change
 *      (column grants for the runtime; the guard trigger for every role); SUPERSEDED / RETIRED rows are
 *      frozen; the lifecycle graph is closed (no APPROVED → DRAFT, no un-supersede); no DELETE even for
 *      the table owner, except a cascade from the business;
 *   4. pointer integrity at commit: exactly one current draft / approved pointer naming the page's
 *      DRAFT / APPROVED version; one DRAFT and one APPROVED per page; the counter never moves back and
 *      no version number exceeds it; version numbers unique per page;
 *   5. the snapshot: an object with a CLOSED key set, bound to the row's business / strategy / versions,
 *      still a machine proposal inside; idempotency key unique per business;
 *   6. the full lifecycle: save → approve → save → approve (supersede) → rollback (new APPROVED version,
 *      old one SUPERSEDED, pointer moved) in one transaction each; Business deletion cascades.
 *
 * env: OWNER_URL, RUNTIME_URL. Synthetic only. ZERO network. Raw SQL only: PR-1 ships no
 * schema.prisma change (migration-first), so the generated client knows nothing of P3-E.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.RUNTIME_URL! });

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
type Tx = Prisma.TransactionClient;
/** One transaction as the runtime, committed — deferred constraint triggers fire at its COMMIT. */
async function rtTx<T>(guc: number | null, fn: (tx: Tx) => Promise<T>): Promise<T | string> {
  return runtime.$transaction(async (tx) => {
    if (guc !== null) await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', '${guc}', true)`);
    return fn(tx);
  }).catch((e: Error) => e.message);
}
const rt = (guc: number | null, sql: string, ...args: unknown[]) => rtTx(guc, (tx) => tx.$queryRawUnsafe(sql, ...args) as Promise<Rows>);
const n = (r: unknown) => (typeof r === "string" ? -1 : (r as Rows).length);
const refused = (r: unknown, re: RegExp) => typeof r === "string" && re.test(r);
const RLS = /row-level security/i;
const DENIED = /permission denied/i;
const UNIQUE = /Unique constraint|duplicate key|23505/i;
const CHECK = /check constraint|23514/i;
const FK = /foreign key|23503/i;
const IMMUTABLE = /P3E_IMMUTABLE/;
const LIFECYCLE = /P3E_LIFECYCLE/;
const POINTER = /P3E_POINTER/;
const ownerErr = (sql: string, ...args: unknown[]) => owner.$executeRawUnsafe(sql, ...args).then(() => "ok", (e: Error) => e.message);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const P = `"LandingPage"`;
const V = `"LandingPageVersion"`;
const STRATEGY = "p3b.strategy.v1:REQUEST_QUOTE:REQUEST_QUOTE:WHATSAPP_LINK";

function snapshot(business: number, extra: Record<string, unknown> = {}, strategyId = STRATEGY) {
  return {
    version: "p3c.blueprint.v1", composerVersion: "p3c.composer.v1", promptVersion: "p3c.composer-prompt.v1",
    composerContextVersion: "p3c.composer-context.v1", strategyEngineVersion: "p3b.strategy.v1",
    businessId: business, strategyId, strategyType: "REQUEST_QUOTE", authority: "MACHINE_PROPOSAL",
    pageIntent: "x", metadata: { title: "t", description: "d", language: "he" },
    hero: { headline: "h", subheadline: "s", asset: null, missingAsset: "HERO_IMAGE", action: null },
    sections: [], primaryAction: null, secondaryAction: null, surfaceOnly: false,
    offeringRefs: [], trustClaimRefs: [], assetRefs: [], factRefs: [], statementRefs: [], missingAssets: ["HERO_IMAGE"],
    publicationConstraints: [], authorityRefs: {}, readiness: { publishReady: false, missingForPublication: [], warnings: [] },
    ...extra,
  };
}

const INS_VERSION = `INSERT INTO ${V} ("id","businessId","landingPageId","versionNumber","status","authority",
  "strategyId","strategyType","strategyEngineVersion","composerVersion","promptVersion","composerContextVersion",
  "blueprintVersion","rendererVersion","blueprintSnapshot","sourceFingerprint","idempotencyKey",
  "supersedesVersionId","rollbackSourceVersionId","createdByUserId","approvedAt","approvedByUserId","updatedAt")
  VALUES ($1,$2,$3,$4,$5::"LandingVersionStatus",$6::"LandingVersionAuthority",$7,'REQUEST_QUOTE','p3b.strategy.v1','p3c.composer.v1',
  'p3c.composer-prompt.v1','p3c.composer-context.v1','p3c.blueprint.v1','p3d.renderer.v1',$8::jsonb,$9,$10,$11,$12,$13,$14,$15,now())
  RETURNING id`;

type VersionInput = {
  id?: number; business: number; page: number; number: number; status?: string; authority?: string; strategyId?: string;
  snap?: unknown; key?: string; supersedes?: number | null; rollbackSource?: number | null; user: number;
  approvedAt?: Date | null; approvedBy?: number | null;
};
async function nextId(tx: Tx): Promise<number> {
  const [r] = (await tx.$queryRawUnsafe(`SELECT nextval(pg_get_serial_sequence('"LandingPageVersion"', 'id'))::int AS id`)) as Array<{ id: number }>;
  return r.id;
}
async function insertVersion(tx: Tx, v: VersionInput): Promise<number> {
  const id = v.id ?? (await nextId(tx));
  const snap = v.snap ?? snapshot(v.business, {}, v.strategyId ?? STRATEGY);
  const json = JSON.stringify(snap);
  await tx.$queryRawUnsafe(INS_VERSION, id, v.business, v.page, v.number, v.status ?? "DRAFT", v.authority ?? "OWNER_SAVED",
    v.strategyId ?? STRATEGY, json, sha(json), v.key ?? sha(`${v.business}|${id}|${Math.random()}`),
    v.supersedes ?? null, v.rollbackSource ?? null, v.user, v.approvedAt ?? null, v.approvedBy ?? null);
  return id;
}
/** The service's save: lock the page, advance the counter, supersede the current draft, insert, re-point. */
async function saveDraft(tx: Tx, business: number, page: number, user: number): Promise<number> {
  const [pg] = (await tx.$queryRawUnsafe(`SELECT "currentDraftVersionId" AS d FROM ${P} WHERE id = $1 FOR UPDATE`, page)) as Array<{ d: number | null }>;
  const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1, "updatedAt" = now() WHERE id = $1 RETURNING "lastVersionNumber" AS num`, page)) as Array<{ num: number }>;
  const id = await nextId(tx);
  if (pg.d !== null) await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2, "updatedAt" = now() WHERE id = $1`, pg.d, id);
  await insertVersion(tx, { id, business, page, number: num, supersedes: pg.d, user });
  await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = $2, "updatedAt" = now() WHERE id = $1`, page, id);
  return id;
}
async function approve(tx: Tx, page: number, version: number, user: number): Promise<void> {
  const [pg] = (await tx.$queryRawUnsafe(`SELECT "currentApprovedVersionId" AS a FROM ${P} WHERE id = $1 FOR UPDATE`, page)) as Array<{ a: number | null }>;
  if (pg.a !== null) await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2, "updatedAt" = now() WHERE id = $1`, pg.a, version);
  await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'APPROVED', authority = 'OWNER_APPROVED', "approvedAt" = now(), "approvedByUserId" = $2, "updatedAt" = now() WHERE id = $1`, version, user);
  await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = NULL, "currentApprovedVersionId" = $2, "updatedAt" = now() WHERE id = $1`, page, version);
}
async function rollback(tx: Tx, business: number, page: number, source: number, user: number): Promise<number> {
  const [pg] = (await tx.$queryRawUnsafe(`SELECT "currentApprovedVersionId" AS a FROM ${P} WHERE id = $1 FOR UPDATE`, page)) as Array<{ a: number | null }>;
  const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1, "updatedAt" = now() WHERE id = $1 RETURNING "lastVersionNumber" AS num`, page)) as Array<{ num: number }>;
  const [src] = (await tx.$queryRawUnsafe(`SELECT "blueprintSnapshot" AS s FROM ${V} WHERE id = $1`, source)) as Array<{ s: unknown }>;
  const id = await nextId(tx);
  if (pg.a !== null) await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2, "updatedAt" = now() WHERE id = $1`, pg.a, id);
  await insertVersion(tx, { id, business, page, number: num, status: "APPROVED", authority: "OWNER_APPROVED", snap: src.s, supersedes: pg.a, rollbackSource: source, user, approvedAt: new Date(), approvedBy: user });
  await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentApprovedVersionId" = $2, "updatedAt" = now() WHERE id = $1`, page, id);
  return id;
}
const createPage = (business: number, user: number) =>
  rt(business, `INSERT INTO ${P} ("businessId","createdByUserId","updatedAt") VALUES ($1,$2,now()) RETURNING id`, business, user);
const statusOf = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT status::text AS s FROM ${V} WHERE id = $1`, id)) as Array<{ s: string }>)[0]?.s;
const pageOf = async (id: number) =>
  ((await owner.$queryRawUnsafe(`SELECT "currentDraftVersionId" AS d, "currentApprovedVersionId" AS a, "lastVersionNumber" AS n FROM ${P} WHERE id = $1`, id)) as Array<{ d: number | null; a: number | null; n: number }>)[0];

async function main() {
  const tag = `p3e-${Date.now()}`;
  const [{ id: A }] = (await owner.$queryRawUnsafe(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `${tag}-A`)) as Array<{ id: number }>;
  const [{ id: B }] = (await owner.$queryRawUnsafe(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `${tag}-B`)) as Array<{ id: number }>;
  const userA = 101, userB = 202;

  const [role] = (await runtime.$queryRawUnsafe(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)) as Array<{ rolsuper: boolean; rolbypassrls: boolean }>;
  ok("the runtime login is NOSUPERUSER NOBYPASSRLS", !role.rolsuper && !role.rolbypassrls, JSON.stringify(role));

  console.log("\n-- 1. pages: one per business, born empty, tenant-pinned --");
  const pa = await createPage(A, userA);
  ok("GUC = A: A creates its landing page", n(pa) === 1, String(pa));
  const pageA = Number((pa as Rows)[0]?.id);
  ok("a second page for A is refused (one per business)", refused(await createPage(A, userA), UNIQUE));
  ok("GUC = A: a page for B is refused (WITH CHECK)", refused(await rt(A, `INSERT INTO ${P} ("businessId","createdByUserId","updatedAt") VALUES ($1,$2,now())`, B, userA), RLS));
  ok("no tenant context: creating a page is refused", refused(await rt(null, `INSERT INTO ${P} ("businessId","createdByUserId","updatedAt") VALUES ($1,$2,now())`, A, userA), RLS));
  ok("a page cannot be born with a counter or pointer", refused(await rt(A, `INSERT INTO ${P} ("businessId","createdByUserId","lastVersionNumber","updatedAt") VALUES ($1,$2,5,now())`, A, userA), RLS));
  const pb = await createPage(B, userB);
  const pageB = Number((pb as Rows)[0]?.id);
  ok("GUC = B: B creates its own page", pageB > 0, String(pb));

  console.log("\n-- 2. the lifecycle: save → approve → save → approve → rollback --");
  const v1 = await rtTx(A, (tx) => saveDraft(tx, A, pageA, userA));
  ok("save v1 as DRAFT (one transaction, pointer integrity at commit)", typeof v1 === "number", String(v1));
  let pg = await pageOf(pageA);
  ok("after save: draft pointer = v1, no approved, counter 1", pg.d === v1 && pg.a === null && pg.n === 1, JSON.stringify(pg));
  const ap1 = await rtTx(A, (tx) => approve(tx, pageA, v1 as number, userA));
  ok("approve v1", typeof ap1 !== "string", String(ap1));
  pg = await pageOf(pageA);
  ok("after approve: approved pointer = v1, draft pointer cleared", pg.a === v1 && pg.d === null, JSON.stringify(pg));
  const v2 = await rtTx(A, (tx) => saveDraft(tx, A, pageA, userA));
  ok("save v2 while v1 is approved", typeof v2 === "number", String(v2));
  const v3 = await rtTx(A, (tx) => saveDraft(tx, A, pageA, userA));
  ok("save v3: the previous draft v2 becomes SUPERSEDED (never approved)", typeof v3 === "number" && (await statusOf(v2 as number)) === "SUPERSEDED", String(v3));
  const ap3 = await rtTx(A, (tx) => approve(tx, pageA, v3 as number, userA));
  ok("approve v3: v1 becomes SUPERSEDED, v3 APPROVED", typeof ap3 !== "string" && (await statusOf(v1 as number)) === "SUPERSEDED" && (await statusOf(v3 as number)) === "APPROVED", String(ap3));
  const v1row = ((await owner.$queryRawUnsafe(`SELECT authority::text AS a, "approvedAt" IS NOT NULL AS has, "supersededByVersionId" AS by FROM ${V} WHERE id = $1`, v1)) as Array<{ a: string; has: boolean; by: number }>)[0];
  ok("a superseded approved version keeps its approval record and names its successor", v1row.a === "OWNER_APPROVED" && v1row.has && v1row.by === v3, JSON.stringify(v1row));
  const v4 = await rtTx(A, (tx) => rollback(tx, A, pageA, v1 as number, userA));
  ok("rollback to v1 creates a NEW version", typeof v4 === "number" && v4 !== v1, String(v4));
  const v4row = ((await owner.$queryRawUnsafe(`SELECT status::text AS s, "versionNumber" AS num, "rollbackSourceVersionId" AS src, "supersedesVersionId" AS sup,
      "blueprintSnapshot" = (SELECT "blueprintSnapshot" FROM ${V} WHERE id = $2) AS same FROM ${V} WHERE id = $1`, v4, v1)) as Array<Record<string, unknown>>)[0];
  ok("the rollback version is APPROVED, number 4, source v1, supersedes v3, same snapshot", v4row.s === "APPROVED" && v4row.num === 4 && v4row.src === v1 && v4row.sup === v3 && v4row.same === true, JSON.stringify(v4row));
  ok("v1 stays SUPERSEDED (nothing old is reactivated); v3 is SUPERSEDED", (await statusOf(v1 as number)) === "SUPERSEDED" && (await statusOf(v3 as number)) === "SUPERSEDED");
  pg = await pageOf(pageA);
  ok("after rollback: approved pointer = v4, counter 4", pg.a === v4 && pg.n === 4, JSON.stringify(pg));
  const v5 = await rtTx(A, (tx) => saveDraft(tx, A, pageA, userA));
  const retired = await rtTx(A, async (tx) => {
    await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'RETIRED', "retiredAt" = now(), "retiredByUserId" = $2, "updatedAt" = now() WHERE id = $1`, v5, userA);
    await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = NULL, "updatedAt" = now() WHERE id = $1`, pageA);
  });
  ok("the owner retires the draft v5; the pointer clears", typeof retired !== "string" && (await statusOf(v5 as number)) === "RETIRED", String(retired));

  console.log("\n-- 3. pointer integrity (deferred, at commit) --");
  ok("approving without moving the pointer is refused at commit", refused(await rtTx(A, async (tx) => {
    const d = await saveDraft(tx, A, pageA, userA);
    await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2, "updatedAt" = now() WHERE id = $1`, v4, d);
    await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'APPROVED', authority = 'OWNER_APPROVED', "approvedAt" = now(), "approvedByUserId" = $2, "updatedAt" = now() WHERE id = $1`, d, userA);
  }), POINTER));
  ok("a pointer at a SUPERSEDED version is refused at commit", refused(await rtTx(A, (tx) =>
    tx.$executeRawUnsafe(`UPDATE ${P} SET "currentApprovedVersionId" = $2 WHERE id = $1`, pageA, v1)), POINTER));
  ok("clearing the approved pointer while a version is APPROVED is refused", refused(await rtTx(A, (tx) =>
    tx.$executeRawUnsafe(`UPDATE ${P} SET "currentApprovedVersionId" = NULL WHERE id = $1`, pageA)), POINTER));
  ok("a second APPROVED version on a page is refused (partial unique)", refused(await rtTx(A, async (tx) => {
    const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "lastVersionNumber" AS num`, pageA)) as Array<{ num: number }>;
    await insertVersion(tx, { business: A, page: pageA, number: num, status: "APPROVED", authority: "OWNER_APPROVED", rollbackSource: v1 as number, user: userA, approvedAt: new Date(), approvedBy: userA });
  }), UNIQUE));
  ok("a second DRAFT on a page is refused (partial unique)", refused(await rtTx(A, async (tx) => {
    await saveDraft(tx, A, pageA, userA);
    const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "lastVersionNumber" AS num`, pageA)) as Array<{ num: number }>;
    await insertVersion(tx, { business: A, page: pageA, number: num, user: userA });
  }), UNIQUE));
  ok("a version number above the page counter is refused at commit", refused(await rtTx(A, async (tx) => {
    const id = await insertVersion(tx, { business: A, page: pageA, number: 999, user: userA });
    await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = $2 WHERE id = $1`, pageA, id);
  }), POINTER));
  ok("a duplicate version number on the page is refused", refused(await rtTx(A, async (tx) => {
    const id = await insertVersion(tx, { business: A, page: pageA, number: 1, user: userA });
    await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = $2 WHERE id = $1`, pageA, id);
  }), UNIQUE));
  ok("the counter never moves back", refused(await rt(A, `UPDATE ${P} SET "lastVersionNumber" = 1 WHERE id = $1`, pageA), LIFECYCLE));

  console.log("\n-- 4. tenant isolation --");
  const vb = await rtTx(B, (tx) => saveDraft(tx, B, pageB, userB));
  ok("B saves its own draft", typeof vb === "number", String(vb));
  ok("GUC = A sees only A's page", n(await rt(A, `SELECT id FROM ${P}`)) === 1);
  ok("GUC = A sees only A's versions", n(await rt(A, `SELECT id FROM ${V} WHERE "businessId" <> $1`, A)) === 0);
  ok("no tenant context sees no page and no version (fails closed)", n(await rt(null, `SELECT id FROM ${P}`)) === 0 && n(await rt(null, `SELECT id FROM ${V}`)) === 0);
  ok("A cannot read B's version by id", n(await rt(A, `SELECT id FROM ${V} WHERE id = $1`, vb)) === 0);
  ok("A cannot approve B's draft (0 rows)", n(await rt(A, `UPDATE ${V} SET status = 'APPROVED', authority = 'OWNER_APPROVED', "approvedAt" = now(), "approvedByUserId" = $2 WHERE id = $1 RETURNING id`, vb, userA)) === 0);
  ok("A cannot move B's pointers (0 rows)", n(await rt(A, `UPDATE ${P} SET "currentDraftVersionId" = NULL WHERE id = $1 RETURNING id`, pageB)) === 0);
  ok("A's page cannot point at B's version (composite FK)", refused(await rt(A, `UPDATE ${P} SET "currentApprovedVersionId" = $2 WHERE id = $1`, pageA, vb), FK));
  ok("A cannot insert a version into B's page (WITH CHECK)", refused(await rtTx(A, (tx) => insertVersion(tx, { business: B, page: pageB, number: 50, user: userA })), RLS));
  { const r = await rtTx(A, (tx) => insertVersion(tx, { business: A, page: pageB, number: 50, user: userA })); ok("A's version cannot hang off B's page (composite FK)", refused(r, FK), JSON.stringify(r)); }
  ok("A cannot even read B's version to roll back from it", refused(await rtTx(A, (tx) => rollback(tx, A, pageA, vb as number, userA)), /undefined/));
  { const r = await rtTx(A, async (tx) => {
      const [{ a, num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "currentApprovedVersionId" AS a, "lastVersionNumber" AS num`, pageA)) as Array<{ a: number; num: number }>;
      const id = await nextId(tx);
      await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2 WHERE id = $1`, a, id);
      await insertVersion(tx, { id, business: A, page: pageA, number: num, status: "APPROVED", authority: "OWNER_APPROVED", rollbackSource: vb as number, supersedes: a, user: userA, approvedAt: new Date(), approvedBy: userA });
      await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentApprovedVersionId" = $2 WHERE id = $1`, pageA, id);
    });
    ok("a rollback naming B's version as its source is refused (composite FK)", refused(r, FK), JSON.stringify(r)); }
  ok("A's version cannot claim to supersede B's (composite FK)", refused(await rtTx(A, async (tx) => {
    const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "lastVersionNumber" AS num`, pageA)) as Array<{ num: number }>;
    const id = await insertVersion(tx, { business: A, page: pageA, number: num, supersedes: vb as number, user: userA });
    await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = $2 WHERE id = $1`, pageA, id);
  }), FK));
  ok("re-pointing a version to B is refused (no column grant)", refused(await rt(A, `UPDATE ${V} SET "businessId" = $1 WHERE id = $2`, B, v4), DENIED));
  ok("re-pointing a page to B is refused (no column grant)", refused(await rt(A, `UPDATE ${P} SET "businessId" = $1 WHERE id = $2`, B, pageA), DENIED));
  ok("DELETE of a version is refused (no grant)", refused(await rt(A, `DELETE FROM ${V} WHERE id = $1`, v2), DENIED));
  ok("DELETE of a page is refused (no grant)", refused(await rt(A, `DELETE FROM ${P} WHERE id = $1`, pageA), DENIED));
  ok("TRUNCATE is refused", refused(await rt(A, `TRUNCATE ${V}`), DENIED) && refused(await rt(A, `TRUNCATE ${P}`), DENIED));

  console.log("\n-- 5. authority and immutability --");
  const insNew = (extra: Partial<VersionInput>) => rtTx(A, async (tx) => {
    const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "lastVersionNumber" AS num`, pageA)) as Array<{ num: number }>;
    return insertVersion(tx, { business: A, page: pageA, number: num, user: userA, ...extra });
  });
  ok("a version cannot be inserted SUPERSEDED", refused(await insNew({ status: "SUPERSEDED", authority: "OWNER_SAVED" }), RLS));
  ok("a version cannot be inserted RETIRED", refused(await insNew({ status: "RETIRED" }), RLS));
  ok("a version cannot be inserted APPROVED without a rollback source", refused(await insNew({ status: "APPROVED", authority: "OWNER_APPROVED", approvedAt: new Date(), approvedBy: userA }), RLS));
  ok("a DRAFT cannot carry approval", refused(await insNew({ approvedAt: new Date(), approvedBy: userA }), CHECK));
  ok("a DRAFT cannot claim OWNER_APPROVED authority", refused(await insNew({ authority: "OWNER_APPROVED" }), CHECK));
  ok("an approval without approvedBy is refused", refused(await insNew({ status: "APPROVED", authority: "OWNER_APPROVED", rollbackSource: v1 as number, approvedAt: new Date(), approvedBy: null }), CHECK));
  ok("the snapshot cannot change (no column grant)", refused(await rt(A, `UPDATE ${V} SET "blueprintSnapshot" = '{}'::jsonb WHERE id = $1`, v4), DENIED));
  ok("the strategy / fingerprint / creator cannot change (no column grant)",
    refused(await rt(A, `UPDATE ${V} SET "strategyId" = 'x' WHERE id = $1`, v4), DENIED)
    && refused(await rt(A, `UPDATE ${V} SET "sourceFingerprint" = repeat('0',64) WHERE id = $1`, v4), DENIED)
    && refused(await rt(A, `UPDATE ${V} SET "createdByUserId" = 7 WHERE id = $1`, v4), DENIED));
  ok("even the table owner cannot change a snapshot (guard)", IMMUTABLE.test(await ownerErr(`UPDATE ${V} SET "blueprintSnapshot" = "blueprintSnapshot" || '{"pageIntent":"y"}'::jsonb WHERE id = $1`, v4)));
  ok("even the table owner cannot delete a version (guard)", IMMUTABLE.test(await ownerErr(`DELETE FROM ${V} WHERE id = $1`, v2)));
  ok("a SUPERSEDED version is frozen for the runtime (0 rows)", n(await rt(A, `UPDATE ${V} SET "updatedAt" = now() WHERE id = $1 RETURNING id`, v1)) === 0);
  ok("a RETIRED version is frozen for the runtime (0 rows)", n(await rt(A, `UPDATE ${V} SET "updatedAt" = now() WHERE id = $1 RETURNING id`, v5)) === 0);
  ok("APPROVED → DRAFT is not a transition (guard, even for the owner)", LIFECYCLE.test(await ownerErr(`UPDATE ${V} SET status = 'DRAFT', authority = 'OWNER_SAVED', "approvedAt" = NULL, "approvedByUserId" = NULL WHERE id = $1`, v4)));
  ok("SUPERSEDED → APPROVED is not a transition (guard, even for the owner)", LIFECYCLE.test(await ownerErr(`UPDATE ${V} SET status = 'APPROVED', "supersededAt" = NULL, "supersededByVersionId" = NULL WHERE id = $1`, v1)));
  ok("an approval record cannot be rewritten while approved", refused(await rt(A, `UPDATE ${V} SET "approvedByUserId" = 999 WHERE id = $1`, v4), LIFECYCLE));

  console.log("\n-- 6. the snapshot shape --");
  ok("a snapshot carrying a raw model response is refused (closed key set)", refused(await insNew({ snap: snapshot(A, { rawModelOutput: "…" }) }), CHECK));
  ok("a snapshot carrying the composer context / prompt is refused", refused(await insNew({ snap: snapshot(A, { composerContext: {} }) }), CHECK) && refused(await insNew({ snap: snapshot(A, { prompt: "p" }) }), CHECK));
  ok("a snapshot of another business is refused", refused(await insNew({ snap: snapshot(B) }), CHECK));
  ok("a snapshot of another strategy than the row's is refused", refused(await insNew({ snap: snapshot(A, {}, "p3b.strategy.v1:TRUST:REQUEST_QUOTE:PHONE") }), CHECK));
  ok("a snapshot claiming owner authority inside is refused", refused(await insNew({ snap: snapshot(A, { authority: "OWNER_APPROVED" }) }), CHECK));
  ok("a non-object snapshot is refused", refused(await insNew({ snap: [1, 2] }), CHECK));
  ok("a malformed strategy id is refused", refused(await insNew({ strategyId: "free text", snap: snapshot(A, {}, "free text") }), CHECK));
  const dupKey = sha(`dup-${tag}`);
  const firstDup = await rtTx(A, async (tx) => {
    const [{ d }] = (await tx.$queryRawUnsafe(`SELECT "currentDraftVersionId" AS d FROM ${P} WHERE id = $1`, pageA)) as Array<{ d: number | null }>;
    const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "lastVersionNumber" AS num`, pageA)) as Array<{ num: number }>;
    const id = await nextId(tx);
    if (d !== null) await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2 WHERE id = $1`, d, id);
    await insertVersion(tx, { id, business: A, page: pageA, number: num, key: dupKey, user: userA });
    await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = $2 WHERE id = $1`, pageA, id);
    return id;
  });
  ok("a version with an idempotency key is saved", typeof firstDup === "number", String(firstDup));
  ok("the same idempotency key cannot be used twice in a business", refused(await insNew({ key: dupKey }), UNIQUE));
  const otherBiz = await rtTx(B, async (tx) => {
    const [{ num }] = (await tx.$queryRawUnsafe(`UPDATE ${P} SET "lastVersionNumber" = "lastVersionNumber" + 1 WHERE id = $1 RETURNING "lastVersionNumber" AS num`, pageB)) as Array<{ num: number }>;
    const [{ d }] = (await tx.$queryRawUnsafe(`SELECT "currentDraftVersionId" AS d FROM ${P} WHERE id = $1`, pageB)) as Array<{ d: number | null }>;
    const id = await nextId(tx);
    if (d !== null) await tx.$executeRawUnsafe(`UPDATE ${V} SET status = 'SUPERSEDED', "supersededAt" = now(), "supersededByVersionId" = $2 WHERE id = $1`, d, id);
    await insertVersion(tx, { id, business: B, page: pageB, number: num, key: dupKey, user: userB });
    await tx.$executeRawUnsafe(`UPDATE ${P} SET "currentDraftVersionId" = $2 WHERE id = $1`, pageB, id);
    return id;
  });
  ok("idempotency keys are per business (B may use the same key)", typeof otherBiz === "number", String(otherBiz));

  console.log("\n-- 7. concurrency: two approvals race, exactly one current approved pointer --");
  const d1 = await rtTx(A, (tx) => saveDraft(tx, A, pageA, userA));
  const race = await Promise.all([1, 2].map(() => rtTx(A, async (tx) => {
    const [row] = (await tx.$queryRawUnsafe(`SELECT "currentDraftVersionId" AS d FROM ${P} WHERE id = $1 FOR UPDATE`, pageA)) as Array<{ d: number | null }>;
    if (row.d !== d1) return "STALE";
    await approve(tx, pageA, d1 as number, userA);
    return "APPROVED";
  })));
  const approvedCount = ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM ${V} WHERE "landingPageId" = $1 AND status = 'APPROVED'`, pageA)) as Array<{ c: number }>)[0].c;
  pg = await pageOf(pageA);
  ok("one approval wins, the other sees the stale draft", race.filter((r) => r === "APPROVED").length === 1 && race.filter((r) => r === "STALE").length === 1, JSON.stringify(race));
  ok("exactly one APPROVED version and the pointer names it", approvedCount === 1 && pg.a === d1, JSON.stringify({ approvedCount, pg }));

  console.log("\n-- 8. privileges --");
  const grants = (await owner.$queryRawUnsafe(`SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
     WHERE grantee = 'app_runtime' AND table_name IN ('LandingPage','LandingPageVersion') ORDER BY 1, 2`)) as Array<{ t: string; p: string }>;
  ok("app_runtime table privileges are exactly SELECT, INSERT on both", JSON.stringify(grants.map((g) => `${g.t}:${g.p}`)) === JSON.stringify(["LandingPage:INSERT", "LandingPage:SELECT", "LandingPageVersion:INSERT", "LandingPageVersion:SELECT"]), JSON.stringify(grants));
  const cols = (await owner.$queryRawUnsafe(`SELECT table_name AS t, string_agg(column_name, ',' ORDER BY column_name) AS c FROM information_schema.column_privileges
     WHERE grantee = 'app_runtime' AND privilege_type = 'UPDATE' AND table_name IN ('LandingPage','LandingPageVersion') GROUP BY 1 ORDER BY 1`)) as Array<{ t: string; c: string }>;
  ok("UPDATE is column-scoped to pointers / counter and lifecycle columns",
    cols[0]?.c === "currentApprovedVersionId,currentDraftVersionId,lastVersionNumber,updatedAt"
    && cols[1]?.c === "approvedAt,approvedByUserId,authority,retiredAt,retiredByUserId,status,supersededAt,supersededByVersionId,updatedAt", JSON.stringify(cols));
  const pub = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS c FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_name IN ('LandingPage','LandingPageVersion')`)) as Array<{ c: number }>;
  ok("PUBLIC holds nothing", pub[0].c === 0);

  console.log("\n-- 9. Business deletion cascades (the only removal path) --");
  const del = await ownerErr(`DELETE FROM "Business" WHERE id = $1`, B);
  const left = ((await owner.$queryRawUnsafe(`SELECT (SELECT count(*) FROM ${P} WHERE "businessId" = $1) + (SELECT count(*) FROM ${V} WHERE "businessId" = $1) AS c`, B)) as Array<{ c: bigint }>)[0].c;
  ok("deleting business B removes its page and versions", del === "ok" && Number(left) === 0, `${del} left=${left}`);

  console.log(`\nP3-E battery: ${pass} passed, ${failures.length} failed`);
  await owner.$disconnect();
  await runtime.$disconnect();
  if (failures.length) { console.log("FAILED:\n - " + failures.join("\n - ")); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await owner.$disconnect(); await runtime.$disconnect(); process.exit(1); });
