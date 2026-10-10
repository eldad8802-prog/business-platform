/**
 * P3-E · Landing persistence / approval / versioning / rollback — the state machine, authority and tenant
 * isolation under REAL row-level security.
 *   TEST_DATABASE_URL="postgres://…test…" npx tsx lib/services/landing/persistence/landing-persistence.rls.db.test.ts
 *
 * Run AFTER identity.rls.db.test.ts on the same lab: it relies on the P2 / P3-A tables, the base-table RLS
 * and the Business column grants that suite replays, and on its `app_runtime` login.
 *
 *   1. drops what `db push` made for P3-E and replays migration 20261013090000_p3e_landing_persistence
 *      VERBATIM (its own guarded app_runtime grants included); replays LearningEvent's tenant RLS and gives
 *      the runtime the SELECT / INSERT it holds in Production (the audit events are written there);
 *   2. seeds two businesses (owner connection);
 *   3. runs the REAL P3-E service as app_runtime — NOSUPERUSER, NOBYPASSRLS — in a child process:
 *      S1–S14 state machine, A (database half) authority, T1–T8 tenant isolation, composer-off behaviour;
 *   4. damages two stored versions as the superuser (guard trigger disabled for the edit only) and proves
 *      every read / approve / rollback of them fails closed;
 *   5. proves no log line carried blueprint copy.
 * Deterministic fake models only; never a real model. Refuses Production.
 */
import { spawnSync } from "node:child_process";
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
const PHASE = process.env.P3E_CHILD ?? "";
if (!PHASE) process.env.DATABASE_URL = TEST_DB;

const ROLE = "app_runtime";
const P3E_MIGRATION = "20261013090000_p3e_landing_persistence";
const LEARNING_RLS_MIGRATION = "20260825150000_d2_p7_wave2_tenant_rls";
/** Copy the fake model writes; it must never reach a log line. */
const COPY_MARKERS = ["ברוכים הבאים", "פרטים נוספים כאן בדף", "גרסת בדיקה"];

let failed = 0;
let passed = 0;
function ok(name: string, condition: boolean, detail: unknown = "") {
  if (!condition) {
    console.error("FAIL:", name, typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 1500));
    failed += 1;
    return;
  }
  passed += 1;
  console.log("OK:", name);
}

/** Statements of a migration file. Dollar-quoted bodies stay whole (same splitter as the P2 suite). */
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

/* ───────────────────────── child: runs as app_runtime ───────────────────────── */

async function child() {
  const a = Number(process.env.P3E_A);
  const b = Number(process.env.P3E_B);
  const userA = Number(process.env.P3E_USER_A);
  const userB = Number(process.env.P3E_USER_B);

  const { prisma } = await import("@/lib/prisma");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const svc = await import("./landing-page.service");
  const { resetComposerCacheForTests } = await import("../composer/landing-blueprint.service");
  const { fakeModel, goodDraft } = await import("../__fixtures__/composer-fakes");
  const { getLandingStrategySet } = await import("../landing-strategy.service");

  const errCode = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e instanceof svc.LandingPersistenceError ? e.code : `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
    }
  };
  /** A composition whose hero headline is unique per call — a different blueprint each save. */
  let variant = 0;
  const model = () => {
    variant += 1;
    const n = variant;
    return fakeModel((c) => ({ ...goodDraft(c), hero: { ...goodDraft(c).hero, headline: `גרסת בדיקה ${n}` } }));
  };
  const strategyOf = async (biz: number) => (await tenantTx(biz, (tx) => getLandingStrategySet(biz, tx))).strategies[0].id;
  const rows = async (biz: number) => tenantTx(biz, (tx) => tx.landingPageVersion.findMany({ where: { businessId: biz }, orderBy: { versionNumber: "asc" } }));
  const page = async (biz: number) => tenantTx(biz, (tx) => tx.landingPage.findFirst({ where: { businessId: biz } }));
  const save = async (biz: number, user: number, m: ReturnType<typeof model> | null) => {
    resetComposerCacheForTests();
    return svc.saveLandingVersion({ businessId: biz, userId: user, strategyId: await strategyOf(biz) }, { model: m });
  };

  const role = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  ok("the child runs as a NOSUPERUSER NOBYPASSRLS runtime login", !role[0].rolsuper && !role[0].rolbypassrls, role);

  if (PHASE === "tamper") return tamperPhase(a, userA, svc, errCode);

  // ── composer off ──
  const off = await errCode(() => save(a, userA, null));
  ok("composer OFF: saving a new version is refused (COMPOSER_UNAVAILABLE) and nothing is stored", off === "COMPOSER_UNAVAILABLE" && (await rows(a)).length === 0, off);

  // ── S1 first save ──
  const s1 = await save(a, userA, model());
  const p1 = await page(a);
  ok("S1 the first save creates the page and DRAFT v1 (OWNER_SAVED, created by the session user), pointer set",
    s1.version.versionNumber === 1 && s1.version.status === "DRAFT" && s1.version.authority === "OWNER_SAVED" && !s1.deduplicated &&
    p1?.currentDraftVersionId === s1.version.id && p1?.currentApprovedVersionId === null && p1?.lastVersionNumber === 1, { s1, p1 });
  const v1row = (await rows(a))[0];
  ok("S1 the stored snapshot is the validated server blueprint: MACHINE_PROPOSAL inside, versions + fingerprint recorded, createdBy = session user",
    (v1row.blueprintSnapshot as { authority?: string }).authority === "MACHINE_PROPOSAL" && v1row.rendererVersion === "p3d.renderer.v1" &&
    /^[0-9a-f]{64}$/.test(v1row.sourceFingerprint) && v1row.createdByUserId === userA && v1row.approvedAt === null, v1row);

  // ── S3 deduplication: identical composition, and a concurrent double save ──
  const again = await svc.persistDraft(a, userA, v1row.blueprintSnapshot as never, new Date());
  ok("S3 saving the identical composition again returns the current draft (deduplicated; no new version)", again.deduplicated && again.version.id === s1.version.id && (await rows(a)).length === 1);
  resetComposerCacheForTests();
  const dm = model();
  const sid = await strategyOf(a);
  const [d1, d2] = await Promise.all([
    svc.saveLandingVersion({ businessId: a, userId: userA, strategyId: sid }, { model: dm }),
    svc.saveLandingVersion({ businessId: a, userId: userA, strategyId: sid }, { model: dm }),
  ]);
  ok("S3 a concurrent double save stores ONE version (one model call; the other is deduplicated under the page lock)",
    d1.version.id === d2.version.id && [d1.deduplicated, d2.deduplicated].filter(Boolean).length === 1 && dm.calls === 1 && (await rows(a)).length === 2, { d1, d2, calls: dm.calls });

  // ── S2 a new save supersedes the previous draft ──
  const after = await rows(a);
  ok("S2 a new draft supersedes the previous draft (SUPERSEDED, names its successor; authority stays OWNER_SAVED)",
    after[0].status === "SUPERSEDED" && after[0].supersededByVersionId === d1.version.id && after[0].authority === "OWNER_SAVED" && after[1].supersedesVersionId === after[0].id);
  const v2 = d1.version;

  // ── S4 / S5 approve ──
  const ap = await svc.approveLandingVersion({ businessId: a, userId: userA, versionId: v2.id });
  const v2row = (await rows(a)).find((r) => r.id === v2.id)!;
  const p2 = await page(a);
  ok("S4 the owner approves the current draft: APPROVED, OWNER_APPROVED, approvedAt + approvedBy from the session; pointers moved",
    ap.version.status === "APPROVED" && v2row.authority === "OWNER_APPROVED" && v2row.approvedByUserId === userA && v2row.approvedAt !== null &&
    p2?.currentApprovedVersionId === v2.id && p2?.currentDraftVersionId === null, { ap, p2 });
  ok("S4 approval is allowed while not publish-ready; today's missing items are returned (approval ≠ publication)",
    ap.currentReadiness !== null && Array.isArray(ap.currentReadiness.blockers) && Array.isArray(ap.currentReadiness.fromSnapshot), ap.currentReadiness);
  const ap2 = await svc.approveLandingVersion({ businessId: a, userId: userA, versionId: v2.id });
  ok("S5 approving the current approved version again is a no-op", ap2.alreadyApproved && (await rows(a)).filter((r) => r.status === "APPROVED").length === 1);

  // ── S6 approve a non-current version ──
  ok("S6 a superseded draft cannot be approved (NOT_CURRENT_DRAFT)", (await errCode(() => svc.approveLandingVersion({ businessId: a, userId: userA, versionId: after[0].id }))) === "NOT_CURRENT_DRAFT");

  // ── S7 approve a newer draft: the previous approved version is superseded ──
  const v3 = (await save(a, userA, model())).version;
  await svc.approveLandingVersion({ businessId: a, userId: userA, versionId: v3.id });
  const r7 = await rows(a);
  const old = r7.find((r) => r.id === v2.id)!;
  ok("S7 approving v3 supersedes v2 — its approval record (approvedAt / approvedBy / OWNER_APPROVED) is kept, it names its successor",
    old.status === "SUPERSEDED" && old.authority === "OWNER_APPROVED" && old.approvedByUserId === userA && old.supersededByVersionId === v3.id &&
    r7.find((r) => r.id === v3.id)!.status === "APPROVED", old);

  // ── S8 rollback ──
  const key1 = "rollback-action-0001";
  const rb = await svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: v2.id, clientKey: key1 });
  const r8 = await rows(a);
  const created = r8.find((r) => r.id === rb.version.id)!;
  const p8 = await page(a);
  ok("S8 rollback creates a NEW version from the source snapshot (rollbackSource = v2, same fingerprint and snapshot), APPROVED atomically",
    !rb.deduplicated && rb.version.id !== v2.id && created.rollbackSourceVersionId === v2.id && created.status === "APPROVED" && created.authority === "OWNER_APPROVED" &&
    created.sourceFingerprint === old.sourceFingerprint && JSON.stringify(created.blueprintSnapshot) === JSON.stringify(old.blueprintSnapshot) &&
    created.approvedByUserId === userA && created.supersedesVersionId === v3.id && rb.version.rollbackSourceVersionNumber === old.versionNumber, { rb, created });
  ok("S8 the previous approved version (v3) becomes SUPERSEDED; the source (v2) is NOT reactivated; the pointer names the new version",
    r8.find((r) => r.id === v3.id)!.status === "SUPERSEDED" && r8.find((r) => r.id === v2.id)!.status === "SUPERSEDED" && p8?.currentApprovedVersionId === rb.version.id);

  // ── S9 rollback idempotency ──
  const rbAgain = await svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: v2.id, clientKey: key1 });
  ok("S9 a double submit of the same rollback action (same key) is ONE version", rbAgain.deduplicated && rbAgain.version.id === rb.version.id && (await rows(a)).length === r8.length);
  const rbNew = await svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: v3.id, clientKey: "rollback-action-0002" });
  ok("S9 a deliberate second rollback (a new action key) creates another new version", !rbNew.deduplicated && (await rows(a)).length === r8.length + 1 && (await page(a))?.currentApprovedVersionId === rbNew.version.id);

  // ── S10 rollback refusals ──
  ok("S10 a version that was never approved cannot be a rollback source", (await errCode(() => svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: after[0].id, clientKey: "rollback-action-0003" }))) === "ROLLBACK_SOURCE_NOT_APPROVED");
  ok("S10 rolling back to the CURRENT approved version is refused (ALREADY_CURRENT)", (await errCode(() => svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: rbNew.version.id, clientKey: "rollback-action-0004" }))) === "ALREADY_CURRENT");

  // ── S11 retire ──
  const v6 = (await save(a, userA, model())).version;
  const ret = await svc.retireLandingDraft({ businessId: a, userId: userA, versionId: v6.id });
  ok("S11 the owner discards the current draft: RETIRED (retiredBy = session user), pointer cleared, row kept",
    ret.version.status === "RETIRED" && (await page(a))?.currentDraftVersionId === null && (await rows(a)).find((r) => r.id === v6.id)?.retiredByUserId === userA);
  ok("S11 a retired version cannot be approved", (await errCode(() => svc.approveLandingVersion({ businessId: a, userId: userA, versionId: v6.id }))) === "NOT_CURRENT_DRAFT");

  // ── S12 concurrent approvals of one draft ──
  const v7 = (await save(a, userA, model())).version;
  const race = await Promise.allSettled([1, 2, 3].map(() => svc.approveLandingVersion({ businessId: a, userId: userA, versionId: v7.id })));
  const fresh = race.filter((x) => x.status === "fulfilled" && !x.value.alreadyApproved).length;
  const approvedNow = (await rows(a)).filter((r) => r.status === "APPROVED");
  ok("S12 three concurrent approvals: exactly one approves, the others see it already approved; exactly ONE current approved pointer",
    fresh === 1 && race.every((x) => x.status === "fulfilled") && approvedNow.length === 1 && approvedNow[0].id === v7.id && (await page(a))?.currentApprovedVersionId === v7.id,
    race.map((x) => (x.status === "fulfilled" ? x.value.alreadyApproved : String(x.reason))));

  // ── S13 a save and an approval race ──
  const v8 = (await save(a, userA, model())).version;
  resetComposerCacheForTests();
  const race2 = await Promise.allSettled([
    svc.saveLandingVersion({ businessId: a, userId: userA, strategyId: sid }, { model: model() }),
    svc.approveLandingVersion({ businessId: a, userId: userA, versionId: v8.id }),
  ]);
  const all = await rows(a);
  const p13 = await page(a);
  const drafts = all.filter((r) => r.status === "DRAFT");
  const approved = all.filter((r) => r.status === "APPROVED");
  ok("S13 a save racing an approval leaves a consistent page: ≤1 DRAFT, exactly 1 APPROVED, pointers name exactly them; a loser is refused cleanly",
    drafts.length <= 1 && approved.length === 1 && p13?.currentApprovedVersionId === approved[0].id && p13?.currentDraftVersionId === (drafts[0]?.id ?? null) &&
    race2.every((x) => x.status === "fulfilled" || /NOT_CURRENT_DRAFT|CONFLICT/.test(String((x.reason as { code?: string })?.code ?? x.reason))),
    { race2: race2.map((x) => x.status === "fulfilled" ? "ok" : String((x.reason as { code?: string })?.code ?? x.reason)), drafts: drafts.length, approved: approved.length });

  // ── S14 numbering ──
  const nums = all.map((r) => r.versionNumber);
  ok("S14 version numbers are unique, contiguous 1..n, and equal to the page counter (DB-safe allocation)",
    JSON.stringify(nums) === JSON.stringify(nums.map((_, i) => i + 1)) && p13?.lastVersionNumber === nums.length, { nums, counter: p13?.lastVersionNumber });

  // ── reads without the composer ──
  const ov = await svc.getLandingOverview(a);
  const det = await svc.getLandingVersionDetail(a, v2.id);
  ok("composer NOT required to view: the overview lists every version with the current approved / draft and today's readiness",
    ov.hasPage && ov.versions.length === all.length && ov.currentApproved?.id === approved[0].id && ov.currentApproved?.currentReadiness !== null);
  ok("composer NOT required to preview a saved version: integrity ok, snapshot + current readiness, a deterministic OWNER_PREVIEW render model",
    det.integrity.ok && det.renderModel?.mode === "OWNER_PREVIEW" && det.snapshotReadiness !== null && det.currentReadiness !== null && det.renderError === null, det.integrity);

  // ── A · database-enforced authority (the runtime, with a valid tenant context) ──
  const raw = (sql: string, ...args: unknown[]) => errCode(() => tenantTx(a, (tx) => tx.$executeRawUnsafe(sql, ...args)));
  ok("A · the runtime cannot rewrite a snapshot (no column privilege)", /permission denied/i.test((await raw(`UPDATE "LandingPageVersion" SET "blueprintSnapshot" = '{}'::jsonb WHERE id = $1`, approved[0].id)) ?? ""));
  ok("A · the runtime cannot mark a version APPROVED without the approval record (CHECK)",
    /check constraint|23514/i.test((await raw(`UPDATE "LandingPageVersion" SET status = 'APPROVED', authority = 'OWNER_APPROVED' WHERE id = $1`, drafts[0]?.id ?? all[all.length - 1].id)) ?? ""));
  ok("A · the runtime cannot insert an APPROVED version that is not a rollback, nor a SUPERSEDED / RETIRED one (insert policy)",
    /row-level security/i.test((await raw(`INSERT INTO "LandingPageVersion" ("businessId","landingPageId","versionNumber","status","authority","strategyId","strategyType","strategyEngineVersion","composerVersion","promptVersion","composerContextVersion","blueprintVersion","rendererVersion","blueprintSnapshot","sourceFingerprint","idempotencyKey","createdByUserId","approvedAt","approvedByUserId","updatedAt")
      SELECT "businessId","landingPageId",999,'APPROVED','OWNER_APPROVED',"strategyId","strategyType","strategyEngineVersion","composerVersion","promptVersion","composerContextVersion","blueprintVersion","rendererVersion","blueprintSnapshot","sourceFingerprint",repeat('e',64),"createdByUserId",now(),"createdByUserId",now() FROM "LandingPageVersion" WHERE id = $1`, v2.id)) ?? ""));
  ok("A · the runtime cannot delete a version or a page (no DELETE privilege)",
    /permission denied/i.test((await raw(`DELETE FROM "LandingPageVersion" WHERE id = $1`, v2.id)) ?? "") && /permission denied/i.test((await raw(`DELETE FROM "LandingPage" WHERE "businessId" = $1`, a)) ?? ""));
  ok("A · a superseded version is frozen (0 rows change)", (await tenantTx(a, (tx) => tx.$executeRawUnsafe(`UPDATE "LandingPageVersion" SET "updatedAt" = now() WHERE id = $1`, v2.id))) === 0);

  // ── T · tenant isolation ──
  const vb = (await save(b, userB, model())).version;
  ok("T1 A's overview holds none of B's versions; B's own save worked (positive control)",
    (await svc.getLandingOverview(a)).versions.every((x) => x.id !== vb.id) && (await svc.getLandingOverview(b)).versions.some((x) => x.id === vb.id));
  ok("T2 B's version cannot be previewed from A's session (not found)", (await errCode(() => svc.getLandingVersionDetail(a, vb.id))) === "VERSION_NOT_FOUND");
  ok("T3 B's draft cannot be approved from A's session; B's row is unchanged",
    (await errCode(() => svc.approveLandingVersion({ businessId: a, userId: userA, versionId: vb.id }))) === "VERSION_NOT_FOUND" && (await rows(b)).find((r) => r.id === vb.id)?.status === "DRAFT");
  const bApproved = await svc.approveLandingVersion({ businessId: b, userId: userB, versionId: vb.id });
  ok("T4 B's approved version cannot be a rollback source for A", bApproved.version.status === "APPROVED" &&
    (await errCode(() => svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: vb.id, clientKey: "rollback-action-cross" }))) === "VERSION_NOT_FOUND");
  const vb2 = (await save(b, userB, model())).version;
  ok("T5 B's draft cannot be retired from A's session", (await errCode(() => svc.retireLandingDraft({ businessId: a, userId: userA, versionId: vb2.id }))) === "VERSION_NOT_FOUND" && (await rows(b)).find((r) => r.id === vb2.id)?.status === "DRAFT");
  const cntUnderA = await tenantTx(a, (tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "LandingPageVersion" WHERE "businessId" = $1`, b));
  const cntNoCtx = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "LandingPageVersion"`);
  const pagesNoCtx = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM "LandingPage"`);
  ok("T6 under A's context none of B's versions is visible; without a tenant context nothing is (fails closed)",
    Number(cntUnderA[0].n) === 0 && Number(cntNoCtx[0].n) === 0 && Number(pagesNoCtx[0].n) === 0);
  const pointAtB = await raw(`UPDATE "LandingPage" SET "currentApprovedVersionId" = $1 WHERE "businessId" = $2`, vb.id, a);
  const movePage = await raw(`UPDATE "LandingPage" SET "businessId" = $1 WHERE "businessId" = $2`, b, a);
  ok("T7 A's page cannot point at B's version (composite foreign key), and A's page cannot be moved to B (no column privilege)",
    /foreign key|23503/i.test(pointAtB ?? "") && /permission denied/i.test(movePage ?? ""), { pointAtB, movePage });
  const events = await tenantTx(a, (tx) => tx.learningEvent.findMany({ where: { businessId: a, eventType: { startsWith: "LANDING_" } }, select: { eventType: true, payload: true, actorUserId: true, businessId: true } }));
  const bEventsUnderA = await tenantTx(a, (tx) => tx.learningEvent.count({ where: { businessId: b } }));
  const types = new Set(events.map((e) => e.eventType));
  ok("T8 audit events: A's own CREATED / APPROVED / SUPERSEDED / ROLLBACK_CREATED / RETIRED, by the owner, codes and numbers only; none of B's visible",
    ["LANDING_VERSION_CREATED", "LANDING_VERSION_APPROVED", "LANDING_VERSION_SUPERSEDED", "LANDING_ROLLBACK_CREATED", "LANDING_VERSION_RETIRED"].every((t) => types.has(t)) &&
    events.every((e) => e.actorUserId === userA && e.businessId === a && !COPY_MARKERS.some((m) => JSON.stringify(e.payload).includes(m))) && bEventsUnderA === 0,
    { types: [...types], bEventsUnderA });

  // Hand the parent what the tamper phase needs: A's current draft (if any) and current approved.
  const pEnd = await page(a);
  let draftId = pEnd?.currentDraftVersionId ?? null;
  if (!draftId) draftId = (await save(a, userA, model())).version.id;
  console.log(`@@TAMPER@@${JSON.stringify({ draftId, approvedId: pEnd?.currentApprovedVersionId, supersededApprovedId: v3.id })}@@END@@`);
}

async function tamperPhase(
  a: number,
  userA: number,
  svc: typeof import("./landing-page.service"),
  errCode: (fn: () => Promise<unknown>) => Promise<string | null>,
) {
  const draftId = Number(process.env.P3E_TAMPERED_DRAFT);
  const futureId = Number(process.env.P3E_FUTURE_RENDERER);
  const det = await svc.getLandingVersionDetail(a, draftId);
  ok("a damaged snapshot (fingerprint mismatch) fails closed on preview: no render model, the integrity problem instead",
    !det.integrity.ok && det.integrity.problems.includes("FINGERPRINT_MISMATCH") && det.renderModel === null && det.renderError === "SNAPSHOT_INVALID", det.integrity);
  ok("a damaged snapshot cannot be approved (SNAPSHOT_INVALID)", (await errCode(() => svc.approveLandingVersion({ businessId: a, userId: userA, versionId: draftId }))) === "SNAPSHOT_INVALID");
  const fut = await svc.getLandingVersionDetail(a, futureId);
  ok("a version saved under a renderer this code does not support fails closed on preview",
    !fut.integrity.ok && fut.integrity.problems.includes("UNSUPPORTED_RENDERER_VERSION") && fut.renderModel === null, fut.integrity);
  ok("…and cannot be a rollback source", (await errCode(() => svc.rollbackLandingVersion({ businessId: a, userId: userA, sourceVersionId: futureId, clientKey: "rollback-action-future" }))) === "SNAPSHOT_INVALID");
}

/* ───────────────────────── parent: owner connection ───────────────────────── */

function runChild(phase: string, env: Record<string, string>): { stdout: string; ok: boolean } {
  const url = new URL(TEST_DB!);
  url.username = ROLE;
  url.password = process.env.P3E_RUNTIME_PASSWORD!;
  const run = spawnSync("npx", ["tsx", process.argv[1]], {
    shell: process.platform === "win32",
    encoding: "utf8",
    env: { ...process.env, ...env, P3E_CHILD: phase, DATABASE_URL: url.toString() },
    timeout: 300_000,
  });
  const stdout = run.stdout ?? "";
  for (const line of stdout.split("\n")) {
    const m = /^(OK|FAIL):\s(.*)$/.exec(line.trim());
    if (m) ok(`[app_runtime] ${m[2]}`, m[1] === "OK");
  }
  if (run.status !== 0 && !/^FAIL:/m.test(stdout)) console.error((run.stderr ?? "").slice(-3000));
  return { stdout: stdout + (run.stderr ?? ""), ok: run.status === 0 };
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { randomBytes } = await import("node:crypto");

  const identityReplayed = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_policies WHERE tablename = 'BusinessIdentityStatement'`);
  if (Number(identityReplayed[0].n) === 0) {
    console.error("ABORT: run lib/services/identity/identity.rls.db.test.ts on this database first (it replays P2 / P3-A and the base RLS).");
    process.exit(1);
  }

  console.log(`\n1 · replay ${P3E_MIGRATION} verbatim with app_runtime present`);
  const password = randomBytes(18).toString("hex");
  await prisma.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
  process.env.P3E_RUNTIME_PASSWORD = password;
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "LandingPageVersion", "LandingPage" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "LandingVersionStatus", "LandingVersionAuthority" CASCADE`);
  const statements = migrationStatements(P3E_MIGRATION);
  let applied = 0;
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
    applied += 1;
  }
  ok(`applied all ${applied} statements of ${P3E_MIGRATION} verbatim, none tolerated`, applied === statements.length && applied >= 40, applied);
  const grants = await prisma.$queryRawUnsafe<Array<{ t: string; p: string }>>(
    `SELECT table_name::text AS t, privilege_type::text AS p FROM information_schema.role_table_grants WHERE grantee = $1 AND table_name IN ('LandingPage','LandingPageVersion') ORDER BY 1, 2`, ROLE);
  ok("the migration's own grant block gave app_runtime exactly SELECT + INSERT on both tables (no DELETE / TRUNCATE / table-wide UPDATE)",
    JSON.stringify(grants.map((g) => `${g.t}:${g.p}`)) === JSON.stringify(["LandingPage:INSERT", "LandingPage:SELECT", "LandingPageVersion:INSERT", "LandingPageVersion:SELECT"]), grants);

  // LearningEvent: tenant RLS from the migration that owns it, and the runtime's SELECT / INSERT (Production default privileges).
  for (const statement of migrationStatements(LEARNING_RLS_MIGRATION)) {
    if (/"LearningEvent"/.test(statement)) await prisma.$executeRawUnsafe(statement);
  }
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT ON "LearningEvent" TO ${ROLE}`);
  await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON SEQUENCE "LearningEvent_id_seq" TO ${ROLE}`);

  console.log("\n2 · fixtures (owner connection)");
  const tag = `qa-p3e-${Date.now()}`;
  const a = await prisma.business.create({ data: { name: `${tag}-A` } });
  const b = await prisma.business.create({ data: { name: `${tag}-B` } });
  const userA = await prisma.user.create({ data: { email: `${tag}-a@example.test`, password: "not-a-real-password", businessId: a.id } });
  const userB = await prisma.user.create({ data: { email: `${tag}-b@example.test`, password: "not-a-real-password", businessId: b.id } });
  for (const biz of [a.id, b.id]) {
    for (let i = 0; i < 3; i += 1) await prisma.businessService.create({ data: { businessId: biz, name: `${tag}-svc-${biz}-${i}`, type: "SERVICE" } });
  }
  const env = { P3E_A: String(a.id), P3E_B: String(b.id), P3E_USER_A: String(userA.id), P3E_USER_B: String(userB.id) };

  console.log("\n3 · the real P3-E service as app_runtime (NOSUPERUSER NOBYPASSRLS)");
  const main1 = runChild("main", env);
  ok("child (state machine, authority, tenant) completed", main1.ok);
  const handoff = /@@TAMPER@@(.*)@@END@@/s.exec(main1.stdout);

  if (handoff) {
    const h = JSON.parse(handoff[1]) as { draftId: number; approvedId: number; supersededApprovedId: number };
    console.log("\n4 · damage two stored versions (superuser, guard disabled for the edit only) — every path must fail closed");
    await prisma.$executeRawUnsafe(`ALTER TABLE "LandingPageVersion" DISABLE TRIGGER "LandingPageVersion_guard"`);
    try {
      await prisma.$executeRawUnsafe(`UPDATE "LandingPageVersion" SET "blueprintSnapshot" = jsonb_set("blueprintSnapshot", '{pageIntent}', '"נערך בלי אישור"') WHERE id = $1`, h.draftId);
      await prisma.$executeRawUnsafe(`UPDATE "LandingPageVersion" SET "rendererVersion" = 'p3d.renderer.v9' WHERE id = $1`, h.supersededApprovedId);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "LandingPageVersion" ENABLE TRIGGER "LandingPageVersion_guard"`);
    }
    const guard = await prisma.$queryRawUnsafe<Array<{ tgenabled: string }>>(`SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'LandingPageVersion_guard'`);
    ok("the guard trigger is enabled again", guard[0]?.tgenabled === "O", guard);
    const tamper = runChild("tamper", { ...env, P3E_TAMPERED_DRAFT: String(h.draftId), P3E_FUTURE_RENDERER: String(h.supersededApprovedId) });
    ok("child (fail-closed) completed", tamper.ok);
    ok("no log line carried blueprint copy (headline, blurbs, intent) in either child", !COPY_MARKERS.some((m) => main1.stdout.includes(m) || tamper.stdout.includes(m)));
  } else {
    ok("the main child handed over the tamper targets", false);
  }

  console.log("\n5 · the owner connection sees the history intact");
  const counts = await prisma.$queryRawUnsafe<Array<{ s: string; n: bigint }>>(
    `SELECT status::text AS s, count(*)::bigint AS n FROM "LandingPageVersion" WHERE "businessId" = $1 GROUP BY 1 ORDER BY 1`, a.id);
  ok("A's history: exactly one APPROVED, superseded and retired versions kept (nothing deleted)",
    counts.find((c) => c.s === "APPROVED")?.n === 1n && Number(counts.find((c) => c.s === "SUPERSEDED")?.n ?? 0) >= 3 && Number(counts.find((c) => c.s === "RETIRED")?.n ?? 0) === 1,
    counts.map((c) => ({ s: c.s, n: Number(c.n) })));

  console.log(`\nP3-E landing persistence (real RLS): ${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  if (failed) process.exit(1);
}

(PHASE ? child() : main()).then(
  async () => {
    if (PHASE) {
      const { prisma } = await import("@/lib/prisma");
      await prisma.$disconnect();
      if (failed) process.exit(1);
    }
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
