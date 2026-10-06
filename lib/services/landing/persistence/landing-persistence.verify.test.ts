/**
 * P3-E · Landing persistence, owner approval, versioning, rollback — pure + static verification.
 *   npx tsx lib/services/landing/persistence/landing-persistence.verify.test.ts
 *
 * P1–P30   persistence: snapshot, fingerprint, integrity, saved-version render, migration / schema / route /
 *          client / log / registry contracts (pure and static — no database, no model).
 * C1–C6    current readiness: today's deterministic re-check of a saved snapshot (no AI, no mutation).
 * A1–A9    authority (static half): who can approve / set status / name the approver / reach the service.
 * The state machine (S1–S14), the database-enforced authority and tenant isolation (T1–T8) run against a
 * real database as app_runtime in landing-persistence.rls.db.test.ts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimRow, ctxFor, NAME, PHONE, svcs, type Fx } from "../__fixtures__/landing-fixtures";
import { good } from "../__fixtures__/composer-fakes";
import type { LandingBlueprint } from "../composer/blueprint-assembly";
import { composeBlueprint } from "../composer/landing-composer";
import type { LandingBusinessContext } from "../landing-business-context";
import { buildLandingStrategySet } from "../landing-strategy-engine";
import { RENDERER_VERSION } from "../renderer/render-model";
import { SENSORS } from "@/lib/sensors/catalogue";
import { validateSensorInput } from "@/lib/sensors/record-sensor";
import {
  blueprintShapeProblems,
  canonicalJson,
  checkSnapshotIntegrity,
  computeCurrentReadiness,
  idempotencyKey,
  renderSavedVersion,
  savedVersionRenderView,
  snapshotFingerprint,
  snapshotReadiness,
  type SavedVersionRow,
} from "./landing-version-model";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 1500));
  }
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION_RAW = read("prisma/migrations/20261013090000_p3e_landing_persistence/migration.sql");
/** The migration without its comments: the checks below read statements, not prose. */
const MIGRATION = MIGRATION_RAW.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const SERVICE = read("lib/services/landing/persistence/landing-page.service.ts");
const MODEL_SRC = read("lib/services/landing/persistence/landing-version-model.ts");
const ROUTES: Record<string, string> = {
  overview: read("app/api/business/landing/route.ts"),
  versions: read("app/api/business/landing/versions/route.ts"),
  detail: read("app/api/business/landing/versions/[id]/route.ts"),
  approve: read("app/api/business/landing/versions/[id]/approve/route.ts"),
  rollback: read("app/api/business/landing/versions/[id]/rollback/route.ts"),
  retire: read("app/api/business/landing/versions/[id]/retire/route.ts"),
};
const CLIENT_API = read("components/business/landing/landing-versions-api.ts");
const UI = read("components/business/landing/LandingVersionsScreen.tsx") + read("components/business/landing/LandingPreviewScreen.tsx") + read("components/business/landing/landing-labels.ts");

/** The body of one exported function of the service (up to the next top-level export). */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/* ─── businesses (the renderer suite's verticals) ─── */

const ADDRESS = { fact: "PUBLIC_ADDRESS" as const, value: "הרצל 1, חיפה", authority: "PUBLIC" as const };
const HOURS = { fact: "OPENING_HOURS" as const, value: "א׳–ה׳ 9:00–19:00", authority: "PUBLIC" as const };
const QUOTE: Fx = {
  facts: [NAME, PHONE, ADDRESS, HOURS], webForm: true, services: svcs(6, { priceMode: "QUOTE_REQUIRED" }),
  claims: [claimRow("FOUNDED_YEAR", { foundedYear: 2001 }, { approved: true }), claimRow("LICENSED", { licenseType: "קבלן שיפוצים", issuer: "רשם הקבלנים" }, { approved: true, verified: true })],
  statements: [{ dimension: "PRIMARY_OBJECTIVE", code: "REQUEST_QUOTE" }, { dimension: "DESCRIPTION", text: "שיפוצים כלליים", publicUseApproved: true }, { dimension: "SERVICE_AREA", text: "חיפה והקריות", publicUseApproved: true }],
  assets: [{ id: 1, approved: true, services: [1] }, { id: 2, approved: false, services: [2] }],
};
const HOME: Fx = { facts: [NAME, PHONE], services: svcs(3, { fulfillment: "AT_CUSTOMER" }), statements: [{ dimension: "SERVICE_AREA", text: "הקריות", publicUseApproved: true }, { dimension: "PRIMARY_OBJECTIVE", code: "CALL" }] };
const SURFACE: Fx = { facts: [NAME, { fact: "PUBLIC_PHONE", value: "03-1" }], services: svcs(4) };

async function compose(fx: Fx, pick?: (bp: LandingBlueprint) => boolean): Promise<{ landing: LandingBusinessContext; bp: LandingBlueprint }> {
  const landing = ctxFor(fx);
  for (const strategy of buildLandingStrategySet(landing).strategies) {
    const r = await composeBlueprint({ landing, strategy, model: good() });
    if (r.blueprint && (!pick || pick(r.blueprint))) return { landing, bp: JSON.parse(JSON.stringify(r.blueprint)) as LandingBlueprint };
  }
  throw new Error("no composable strategy matched");
}

const rowOf = (bp: LandingBlueprint, extra: Partial<SavedVersionRow> = {}): SavedVersionRow => ({
  id: 7, businessId: bp.businessId, versionNumber: 3, status: "APPROVED", authority: "OWNER_APPROVED",
  strategyId: bp.strategyId, strategyType: bp.strategyType, blueprintVersion: bp.version, rendererVersion: RENDERER_VERSION,
  blueprintSnapshot: bp, sourceFingerprint: snapshotFingerprint(bp), ...extra,
});

/** A jsonb round trip reorders keys; the fingerprint must not care. */
function reorder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorder(x)]));
  return v;
}

async function main(): Promise<void> {
  const quote = await compose(QUOTE, (bp) => bp.assetRefs.length > 0 && bp.trustClaimRefs.length > 0);
  const home = await compose(HOME, (bp) => bp.primaryAction?.channel === "PHONE");
  const surface = await compose(SURFACE, (bp) => bp.surfaceOnly);

  /* ─────────────── P · snapshot, fingerprint, integrity ─────────────── */
  ok("P1 canonical JSON sorts keys at every level (the fingerprint survives a jsonb round trip)",
    canonicalJson(reorder(quote.bp)) === canonicalJson(quote.bp) && snapshotFingerprint(reorder(quote.bp)) === snapshotFingerprint(quote.bp));
  const edited = JSON.parse(JSON.stringify(quote.bp)) as LandingBlueprint;
  edited.hero.headline += "!";
  ok("P2 any change of copy changes the fingerprint", snapshotFingerprint(edited) !== snapshotFingerprint(quote.bp) && /^[0-9a-f]{64}$/.test(snapshotFingerprint(quote.bp)));
  ok("P3 a server composition is a well-formed snapshot (shape check passes, still a MACHINE_PROPOSAL inside)",
    blueprintShapeProblems(quote.bp).length === 0 && quote.bp.authority === "MACHINE_PROPOSAL", blueprintShapeProblems(quote.bp));
  ok("P4 an intact stored row passes integrity", checkSnapshotIntegrity(rowOf(quote.bp)).ok, checkSnapshotIntegrity(rowOf(quote.bp)));
  ok("P5 a tampered snapshot fails closed (FINGERPRINT_MISMATCH)", checkSnapshotIntegrity(rowOf(quote.bp, { blueprintSnapshot: edited })).problems.includes("FINGERPRINT_MISMATCH"));
  const futureBp = { ...quote.bp, version: "p3c.blueprint.v9" } as unknown as LandingBlueprint;
  ok("P6 an unsupported blueprint version fails closed",
    checkSnapshotIntegrity(rowOf(futureBp, { blueprintVersion: "p3c.blueprint.v9" })).problems.includes("UNSUPPORTED_BLUEPRINT_VERSION"));
  ok("P7 an unsupported renderer version fails closed",
    checkSnapshotIntegrity(rowOf(quote.bp, { rendererVersion: "p3d.renderer.v9" })).problems.includes("UNSUPPORTED_RENDERER_VERSION"));
  ok("P8 a snapshot of another business / strategy than its row fails closed",
    checkSnapshotIntegrity(rowOf(quote.bp, { businessId: 99 })).problems.includes("SNAPSHOT_BUSINESS_MISMATCH") &&
    checkSnapshotIntegrity(rowOf(quote.bp, { strategyId: "p3b.strategy.v1:X:Y" })).problems.includes("SNAPSHOT_ROW_MISMATCH"));
  ok("P9 snapshot readiness is exactly what the snapshot recorded (never recomputed)",
    JSON.stringify(snapshotReadiness(quote.bp)) === JSON.stringify(quote.bp.readiness));
  const k = (o: Partial<Parameters<typeof idempotencyKey>[0]>) => idempotencyKey({ businessId: 1, operation: "SAVE_DRAFT", strategyId: "s", fingerprint: "f", scope: "draft:0|approved:0", ...o });
  ok("P10 the durable idempotency key is deterministic and separates business, operation, strategy, blueprint and page state",
    k({}) === k({}) && new Set([k({}), k({ businessId: 2 }), k({ operation: "ROLLBACK" }), k({ strategyId: "t" }), k({ fingerprint: "g" }), k({ scope: "draft:5|approved:0" })]).size === 6 && /^[0-9a-f]{64}$/.test(k({})));

  /* ─────────────── P · saved-version render (no composer, no model) ─────────────── */
  const model = good();
  const rm = renderSavedVersion(quote.bp, quote.landing);
  ok("P11 a saved version renders deterministically without the composer (no model call, OWNER_PREVIEW)",
    model.calls === 0 && rm.mode === "OWNER_PREVIEW" && rm.strategyId === quote.bp.strategyId && JSON.stringify(renderSavedVersion(quote.bp, quote.landing)) === JSON.stringify(rm));
  const frozen = JSON.stringify(quote.bp);
  const withoutAsset = ctxFor({ ...QUOTE, assets: [{ id: 1, approved: false, services: [1] }] });
  const rmNoAsset = renderSavedVersion(quote.bp, withoutAsset);
  const view = savedVersionRenderView(quote.bp, new Set());
  ok("P12 an image no longer approved is dropped from the RENDER VIEW (typographic fallback); the snapshot itself is untouched",
    rmNoAsset.hero.image === null && !JSON.stringify(rmNoAsset).includes("/asset/1") && view.assetRefs.length === 0 && JSON.stringify(quote.bp) === frozen);
  const homeNewPhone = ctxFor({ ...HOME, facts: [NAME, { fact: "PUBLIC_PHONE", value: "04-8889999", authority: "PUBLIC" }] });
  const rmHome = renderSavedVersion(home.bp, homeNewPhone);
  ok("P13 a CTA destination is re-derived from TODAY's approved facts — never taken from the snapshot",
    rmHome.primaryAction?.destinationDisplay === "04-8889999" && rmHome.primaryAction?.href === "tel:048889999" && !JSON.stringify(home.bp).includes("tel:"));
  const rmSurface = renderSavedVersion(surface.bp, surface.landing);
  ok("P14 a SURFACE_ONLY saved version renders with no action anywhere", rmSurface.surfaceOnly && rmSurface.primaryAction === null && rmSurface.secondaryAction === null);

  /* ─────────────── P · the migration and the schema ─────────────── */
  ok("P15 RLS ENABLE + FORCE on both tables; per-command policies only; no FOR ALL, no DELETE policy",
    /ALTER TABLE "LandingPage" FORCE ROW LEVEL SECURITY/.test(MIGRATION) && /ALTER TABLE "LandingPageVersion" FORCE ROW LEVEL SECURITY/.test(MIGRATION) &&
    !/FOR ALL/.test(MIGRATION) && !/FOR DELETE/.test(MIGRATION) && (MIGRATION.match(/CREATE POLICY/g) ?? []).length === 6);
  const grantBlock = MIGRATION.slice(MIGRATION.indexOf("DO $do$"), MIGRATION.indexOf("$do$;"));
  ok("P16 the runtime gets SELECT, INSERT and column-scoped UPDATE only — never DELETE / TRUNCATE / a table-wide UPDATE; PUBLIC revoked",
    (grantBlock.match(/GRANT SELECT, INSERT ON/g) ?? []).length === 2 && !/GRANT[^;]*\b(DELETE|TRUNCATE|ALL)\b/.test(grantBlock) &&
    !/GRANT UPDATE ON/.test(grantBlock) && /REVOKE ALL ON "LandingPageVersion" FROM PUBLIC/.test(MIGRATION));
  ok("P17 pointers and lineage are composite (businessId, id) foreign keys (cross-tenant pointers impossible in the database)",
    ["currentDraftVersionId", "currentApprovedVersionId", "supersedesVersionId", "supersededByVersionId", "rollbackSourceVersionId"].every((c) =>
      new RegExp(`FOREIGN KEY \\("businessId", "${c}"\\) REFERENCES "LandingPageVersion"\\("businessId", "id"\\)`).test(MIGRATION)));
  const enumSql = /CREATE TYPE "LandingVersionStatus" AS ENUM \(([^)]*)\)/.exec(MIGRATION)?.[1].replace(/['\s]/g, "");
  const schema = read("prisma/schema.prisma");
  const enumPrisma = /enum LandingVersionStatus \{([^}]*)\}/.exec(schema)?.[1].trim().split(/\s+/).join(",");
  ok("P18 the status vocabulary is closed (DRAFT, APPROVED, SUPERSEDED, RETIRED) and identical in SQL and Prisma",
    enumSql === "DRAFT,APPROVED,SUPERSEDED,RETIRED" && enumPrisma === enumSql, { enumSql, enumPrisma });
  const allowedKeys = /"blueprintSnapshot" - ARRAY\[([\s\S]*?)\]/.exec(MIGRATION)?.[1].match(/'([A-Za-z]+)'/g)?.map((x) => x.replace(/'/g, "")).sort() ?? [];
  ok("P19 the snapshot's CLOSED key set is exactly the validated blueprint's keys — no prompt, raw output, composer context, evidence or meta",
    JSON.stringify(Object.keys(quote.bp).sort()) === JSON.stringify(allowedKeys) &&
    !allowedKeys.filter((x) => !x.endsWith("Version")).some((x) => /prompt|raw|output|context|evidence|demand|token|provider|model/i.test(x)), { allowedKeys, keys: Object.keys(quote.bp).sort() });
  ok("P20 version numbers are DB-safe: a counter advanced under the page row lock + a unique index; never max + 1",
    /FOR UPDATE/.test(SERVICE) && /"lastVersionNumber" = "lastVersionNumber" \+ 1/.test(SERVICE) && !/_max|aggregate\(|versionNumber \+ 1|max\(/.test(SERVICE) &&
    /"LandingPageVersion"\("businessId", "landingPageId", "versionNumber"\)/.test(MIGRATION));
  ok("P21 a version is never updated in place: content is immutable for every role (guard trigger + column grants); no hard delete of a version exists",
    /p3e_landing_version_guard/.test(MIGRATION) && /P3E_IMMUTABLE/.test(MIGRATION) && !/\.delete\(|deleteMany|DELETE FROM/.test(SERVICE));

  /* ─────────────── P · routes, client, logs, registries ─────────────── */
  ok("P22 save reads ONLY strategyId from the body; approve / rollback / retire / reads never read a body",
    /\(\(await req\.json\(\)\) as \{ strategyId\?: unknown \}\)\?\.strategyId/.test(ROUTES.versions) && (ROUTES.versions.match(/req\.json\(/g) ?? []).length === 1 &&
    ["overview", "detail", "approve", "rollback", "retire"].every((r) => !/req\.(json|formData|text)\(/.test(ROUTES[r])));
  ok("P23 no route reads businessId / approvedBy / status / authority / a pointer from the request; the business and the actor are the session's",
    Object.values(ROUTES).every((src) => !/searchParams|body\.(businessId|approvedBy|status|authority|currentApprovedVersionId)/.test(src) && /user\.businessId/.test(src)));
  ok("P24 the client API sends only a strategy id (save) and an action key (rollback) — never a blueprint, status, authority or approver",
    /JSON\.stringify\(\{ strategyId \}\)/.test(CLIENT_API) && (CLIENT_API.match(/JSON\.stringify\(/g) ?? []).length === 1 &&
    (CLIENT_API.match(/\bbody:/g) ?? []).length === 1 &&
    !/blueprint|authority|approvedBy|businessId|currentApproved|currentDraft/.test(CLIENT_API.replace(/^\s*(\*|\/\/|\/\*\*).*$/gm, "").replace(/import[^;]*;/g, "")) &&
    [...CLIENT_API.matchAll(/headers: \{ "([^"]+)"/g)].every((m) => m[1] === "Content-Type" || m[1] === "Idempotency-Key"));
  const logLines = [...SERVICE.matchAll(/console\.(info|warn|error)\([^;]*;/g), ...MODEL_SRC.matchAll(/console\.(info|warn|error)\([^;]*;/g)].map((m) => m[0]);
  ok("P25 logs carry codes, ids, numbers and statuses only — never the snapshot, copy, refs, facts or keys",
    logLines.length > 0 && logLines.every((l) => !/blueprintSnapshot|bp\.(hero|sections|metadata|pageIntent)|headline|\bbp\)|JSON\.stringify|storageKey|facts/.test(l)) &&
    /const log = \(event: string, fields: Record<string, string \| number \| boolean \| null>\)/.test(SERVICE), logLines);
  const landingSensors = Object.values(SENSORS).filter((s) => s.domain === "landing");
  ok("P26 the five audit events exist, duplicate the version ledger, and carry no copy-shaped key",
    JSON.stringify(landingSensors.map((s) => s.eventType).sort()) === JSON.stringify(["LANDING_ROLLBACK_CREATED", "LANDING_VERSION_APPROVED", "LANDING_VERSION_CREATED", "LANDING_VERSION_RETIRED", "LANDING_VERSION_SUPERSEDED"]) &&
    landingSensors.every((s) => s.learning.role === "LEDGER_DUPLICATE" && s.payloadKeys.every((key) => !/headline|copy|text|blueprint|snapshot|fact|asset|wording|prompt/i.test(key))));
  ok("P27 an audit event with copy in its payload is refused by the sensor contract",
    validateSensorInput({ businessId: 1, sensor: "LANDING_VERSION_CREATED", actor: { type: "OWNER_USER", userId: 1 }, source: "OWNER_UI", payload: { headline: "x" } as never }) === "payload_key_not_allowed" &&
    validateSensorInput({ businessId: 1, sensor: "LANDING_VERSION_CREATED", actor: { type: "OWNER_USER", userId: 1 }, source: "OWNER_UI", payload: { versionNumber: 1, strategyType: "CALL_FIRST", status: "DRAFT" } }) === null);
  const erasure = read("scripts/ci/erasure/erasure-model-coverage.ts") + read("scripts/ci/erasure/erasure-contract-debt.ts");
  const coverage = read("lib/knowledge/coverage/feature-coverage.ts");
  ok("P28 the erasure contract and the learning coverage name both new models",
    /LandingPage: unmanaged\(/.test(erasure) && /LandingPageVersion: unmanaged\(/.test(erasure) && /key: "LandingPage", why: "E2"/.test(erasure) && /key: "LandingPageVersion", why: "E2"/.test(erasure) &&
    /"LandingPage", "LandingPageVersion"/.test(coverage));
  ok("P29 the owner UI never says published / live / on air; badges are מאושרת / טיוטה / גרסה קודמת",
    !/פורסם|באוויר|\bחי\b|בשידור/.test(UI) && /APPROVED: "מאושרת"/.test(UI) && /DRAFT: "טיוטה"/.test(UI) && /SUPERSEDED: "גרסה קודמת"/.test(UI) &&
    UI.includes("לאשר את גרסה ${") && UI.includes("ניצור גרסה חדשה המבוססת על גרסה ${") && UI.includes("ונגדיר אותה כגרסה המאושרת."));
  const appDirs = readdirSync(join(ROOT, "app"));
  ok("P30 no public landing route, no anonymous endpoint: every P3-E route is under the authenticated owner API / business area",
    !appDirs.includes("l") && !appDirs.includes("public") && !appDirs.includes("p") &&
    Object.values(ROUTES).every((src) => /getCurrentUser\(req\)/.test(src) && /authRequiredResponse\(req\)/.test(src)));

  /* ─────────────── C · current readiness (deterministic, no AI) ─────────────── */
  const cSame = computeCurrentReadiness(quote.bp, quote.landing, RENDERER_VERSION);
  ok("C1 nothing changed → no current blocker; the snapshot's own missing items are reported separately",
    cSame.blockers.length === 0 && Object.values(cSame.checks).every(Boolean) && JSON.stringify(cSame.fromSnapshot) === JSON.stringify(quote.bp.readiness.missingForPublication) &&
    cSame.publishReady === quote.bp.readiness.publishReady, cSame);
  const cAsset = computeCurrentReadiness(quote.bp, withoutAsset, RENDERER_VERSION);
  ok("C2 ASSET authority re-checked: an asset no longer public-approved blocks", cAsset.blockers.includes("ASSET_NOT_PUBLIC_APPROVED:asset:1") && !cAsset.checks.assets && !cAsset.publishReady, cAsset);
  const trustRef = quote.bp.trustClaimRefs[0];
  const trustGone = ctxFor({ ...QUOTE, claims: (QUOTE.claims ?? []).map((c) => (`trust:${c.id}` === trustRef ? { ...c, publicUseApproved: false, publicUseApprovedAt: null } : c)) });
  const cTrust = computeCurrentReadiness(quote.bp, trustGone, RENDERER_VERSION);
  ok("C3 TRUST authority re-checked: a claim no longer public-effective blocks", cTrust.blockers.includes(`TRUST_CLAIM_NOT_PUBLIC_EFFECTIVE:${trustRef}`) && !cTrust.checks.trust, cTrust);
  const noPhone = ctxFor({ ...HOME, facts: [NAME, { fact: "PUBLIC_PHONE", value: "03-5550000", authority: "CONFIRMED" }] });
  const cConv = computeCurrentReadiness(home.bp, noPhone, RENDERER_VERSION);
  ok("C4 CONVERSION authority re-checked: the action's destination no longer approved blocks", cConv.blockers.includes("CONVERSION_DESTINATION_MISSING:PRIMARY:PUBLIC_PHONE") && !cConv.checks.conversion, cConv);
  const offeringRef = quote.bp.offeringRefs[0];
  const fewer = ctxFor({ ...QUOTE, services: (QUOTE.services ?? []).map((s) => (`offering:SERVICE:${s.id}` === offeringRef ? { ...s, active: false } : s)) });
  const cOff = computeCurrentReadiness(quote.bp, fewer, RENDERER_VERSION);
  const cRenderer = computeCurrentReadiness(quote.bp, quote.landing, "p3d.renderer.v9");
  ok("C5 offering and renderer compatibility re-checked (an offering no longer active; a renderer this code does not support)",
    cOff.blockers.includes(`OFFERING_NOT_AVAILABLE:${offeringRef}`) && cRenderer.blockers.includes("UNSUPPORTED_RENDERER_VERSION") && !cRenderer.checks.renderer, { cOff, cRenderer });
  const before = JSON.stringify(quote.bp);
  const again = computeCurrentReadiness(quote.bp, trustGone, RENDERER_VERSION);
  ok("C6 the re-check is pure: deterministic, no model, and it never changes the snapshot (approval is never revoked by it)",
    JSON.stringify(again) === JSON.stringify(cTrust) && JSON.stringify(quote.bp) === before && model.calls === 0 &&
    !/approvedAt|status\s*=|update\(|revoke/i.test(MODEL_SRC.slice(MODEL_SRC.indexOf("export function computeCurrentReadiness"), MODEL_SRC.indexOf("/* ───────────────────────────── rendering a saved version"))));

  /* ─────────────── A · authority (static half) ─────────────── */
  ok("A1 the client cannot set approval: approve reads no body; approvedAt / approvedBy come from the server clock and session",
    !/req\.json/.test(ROUTES.approve) && /userId: user\.id/.test(ROUTES.approve) && /approvedAt: now, approvedByUserId: userId/.test(SERVICE));
  ok("A2 the client cannot set a status, authority or pointer: no route or client call carries one",
    Object.values(ROUTES).every((src) => !/authority|currentApprovedVersionId|currentDraftVersionId|status: (body|input|req|json)/.test(src.replace(/^\s*(\*|\/\/|\/\*\*).*$/gm, ""))));
  ok("A3 approvedBy is the session user, always (never a parameter of the HTTP layer)", /approvedByUserId: userId/.test(SERVICE) && !Object.values(ROUTES).some((s) => /approvedBy/.test(s)));
  const sources = walk(join(ROOT, "lib")).concat(walk(join(ROOT, "app")));
  const importers = sources.filter((f) => /from "[^"]*persistence\/landing-page\.service"|from "\.\/landing-page\.service"/.test(readFileSync(f, "utf8"))).map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"));
  ok("A4 AI cannot approve: only the owner routes (and the persistence helpers) import the persistence service — never the composer, renderer or strategy engine",
    importers.every((f) => f.startsWith("app/api/business/landing/") || f.startsWith("lib/services/landing/persistence/")), importers);
  ok("A5 no job, cron, webhook or worker can reach it", !importers.some((f) => /cron|jobs?|worker|webhook|queue/i.test(f)));
  ok("A6 every write takes the actor from the session and records it (createdBy / approvedBy / retiredBy)",
    ["approve", "rollback", "retire"].every((r) => /userId: user\.id/.test(ROUTES[r])) && /userId: user\.id/.test(ROUTES.versions) &&
    /createdByUserId: userId/.test(SERVICE) && /retiredByUserId: userId/.test(SERVICE));
  ok("A7 a machine proposal is never stored as owner authority: the stored authority vocabulary is OWNER_SAVED / OWNER_APPROVED only",
    /CREATE TYPE "LandingVersionAuthority" AS ENUM \('OWNER_SAVED', 'OWNER_APPROVED'\)/.test(MIGRATION) && /'authority' = 'MACHINE_PROPOSAL'/.test(MIGRATION));
  ok("A8 composer NOT required to view, preview, approve or roll back: those paths never call the composer",
    ["approveLandingVersion", "rollbackLandingVersion", "retireLandingDraft", "getLandingOverview", "getLandingVersionDetail"].every((n) => { const b = fnBody(SERVICE, n); return b.length > 0 && !/composeLanding|ComposerModel|deps\.model|openAiComposerProvider|composerEnabled/.test(b); }));
  ok("A9 every owner route requires an authenticated session (401 otherwise); the save path is rate-limited with the composer",
    Object.values(ROUTES).every((src) => /if \(!user\) return authRequiredResponse\(req\)/.test(src)) && /bucket: "LANDING_COMPOSE"/.test(ROUTES.versions));

  console.log(`\nP3-E landing persistence: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
