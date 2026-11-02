/**
 * Revenue report uploads — the application code on the lab database, as the RUNTIME role (app_runtime_prod:
 * NOSUPERUSER NOBYPASSRLS), through the same service and route handlers the app runs. docs/revenue-report-uploads.md
 *
 *   A. The role, and the feature rows: both OFF after the data migration; an override opens one kind for one business.
 *   B. The routes: 401 without a session; 404 while the kind is OFF (analyze, commit, list); with the SHIPPED (empty)
 *      registry every file is FORMAT_NOT_SUPPORTED (422, Hebrew), nothing written.
 *   C. Z through a TEST-ONLY fixture parser: analyze writes nothing; commit records POS / FILE_STRUCTURED /
 *      upload.z.<parser> rows with their tender + VAT lines, one ImportRun (z_report, the file's hash), no file.
 *   D. Replays: the same commit again, a fresh analyze + commit, the same Z in another file — nothing written twice.
 *   E. CONFLICT: the same Z with other numbers — refused without a decision, SKIP writes nothing, SUPERSEDE writes
 *      revision 2 naming revision 1; another Z of the same day — ADD records it separately; disallowed decisions refused.
 *   F. Settlement: ACQUIRER / FILE_STRUCTURED / upload.settlement.<parser>; replay; CONFLICT is SKIP-only.
 *   G. Tokens and files: forged, another kind, another business, another user, another file → refused.
 *   H. Tenant isolation: B sees none of A's rows, records its own; a raw cross-business insert is refused by RLS.
 *   I. Concurrency: one file committed four times at once → one run, rows once.
 *   J. No income: FinancialRecord / FinancialEvent / BillingDocument / PaymentTransaction / ExternalTransaction are
 *      byte-identical before and after; the list route answers reports only.
 *
 * The fixture parser lives in THIS FILE ONLY, under a TEST-ONLY name; it describes no real system.
 * env: OWNER_URL (fixtures, BYPASSRLS), RUNTIME_URL (the app). Synthetic only. ZERO network.
 */
const RUNTIME_URL = process.env.RUNTIME_URL?.trim();
const OWNER_URL = process.env.OWNER_URL?.trim();
if (!RUNTIME_URL || !OWNER_URL || !/^postgres(ql)?:\/\//i.test(RUNTIME_URL) || /neon\.tech|vercel/i.test(RUNTIME_URL + OWNER_URL)) {
  console.error("ABORT (DB safety guard): OWNER_URL and RUNTIME_URL must name the ephemeral lab database.");
  process.exit(1);
}
process.env.DATABASE_URL = RUNTIME_URL;
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "rru-lab-synthetic-token-secret-at-least-32-chars";
// Sessions are read through the separate auth plane (AUTH_DATABASE_URL), as in Production; the runtime role holds no
// privilege on "User". The lab points the auth plane at the owner, like the other route-level batteries.
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || OWNER_URL;

import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import type { ReportFile, SettlementDraft, SettlementParser, ZReportDraft, ZReportParser } from "@/lib/revenue-sources/uploads/contract";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ""; } catch (e) { return (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e)); }
}

/* ── TEST-ONLY fixture formats (made up; no real vendor) ──────────────────────────────────────────────────────── */
const B = (s: string) => BigInt(s);
/** "TEST-ONLY-FIXTURE-Z" then lines: day,register,zNumber,gross,discount,refund,void,total,vat,cash,card */
const TEST_ONLY_Z_PARSER: ZReportParser = {
  kind: "z", key: "test_only_fixture", version: 1, label: "קובץ בדיקה", capture: "FILE_STRUCTURED",
  detect: (f) => (f.bytes.toString("utf8").startsWith("TEST-ONLY-FIXTURE-Z") ? 1 : 0),
  parse: (f: ReportFile) => {
    const drafts: ZReportDraft[] = [];
    const errors: { row: number; code: string }[] = [];
    f.bytes.toString("utf8").split("\n").slice(1).forEach((line, i) => {
      if (!line.trim() || line.startsWith("#")) return;
      const c = line.split(",");
      if (c.length !== 11) { errors.push({ row: i + 2, code: "UNREADABLE_ROW" }); return; }
      drafts.push({
        businessDay: c[0], registerKey: c[1], zNumber: c[2] ? B(c[2]) : null,
        grossMinor: B(c[3]), discountMinor: B(c[4]), refundMinor: B(c[5]), voidMinor: B(c[6]), totalMinor: B(c[7]), vatMinor: B(c[8]),
        tenders: [{ method: "CASH", amountMinor: B(c[9]) }, { method: "CARD", label: "visa", amountMinor: B(c[10]) }],
        vatLines: [{ category: "STANDARD", rateBasisPoints: 1800, taxableMinor: B(c[7]) - B(c[8]), vatMinor: B(c[8]) }],
        sourceRow: i + 2,
      });
    });
    return { drafts, errors };
  },
};
/** "TEST-ONLY-FIXTURE-S" then lines: externalId,valueDate,gross,fee,other,net */
const TEST_ONLY_S_PARSER: SettlementParser = {
  kind: "settlement", key: "test_only_fixture", version: 1, label: "קובץ בדיקה", capture: "FILE_STRUCTURED", sourceKind: "ACQUIRER",
  detect: (f) => (f.bytes.toString("utf8").startsWith("TEST-ONLY-FIXTURE-S") ? 1 : 0),
  parse: (f: ReportFile) => {
    const drafts: SettlementDraft[] = [];
    f.bytes.toString("utf8").split("\n").slice(1).forEach((line, i) => {
      if (!line.trim()) return;
      const c = line.split(",");
      drafts.push({ acquirer: "test_only_acq", externalId: c[0], valueDate: c[1], grossMinor: B(c[2]), feeMinor: B(c[3]), otherDeductionsMinor: B(c[4]), netMinor: B(c[5]), sourceRow: i + 2 });
    });
    return { drafts, errors: [] };
  },
};

const zFile = (...lines: string[]) => Buffer.from(["TEST-ONLY-FIXTURE-Z", ...lines].join("\n"), "utf8");
const sFile = (...lines: string[]) => Buffer.from(["TEST-ONLY-FIXTURE-S", ...lines].join("\n"), "utf8");
// gross − discount − refund − void = total; cash + card = total.
const Z1 = "2026-10-01,1,101,100000,5000,2000,1000,92000,14034,30000,62000";
const Z2 = "2026-10-02,1,102,50000,0,0,0,50000,7627,10000,40000";
const Z3 = "2026-10-01,2,201,20000,0,0,0,20000,3051,20000,0";
const Z1_CHANGED = "2026-10-01,1,101,100000,5000,2000,1000,92000,14034,31000,61000";
const Z1_SECOND_SHIFT = "2026-10-01,1,103,8000,0,0,0,8000,1220,8000,0";
const S1 = "ACQ-1,2026-10-03,62000,930,0,61070";
const S2 = "ACQ-2,2026-10-04,40000,600,100,39300";

async function main() {
  const owner = new PrismaClient({ datasourceUrl: OWNER_URL });
  const runtime = new PrismaClient({ datasourceUrl: RUNTIME_URL });
  const svc = await import("@/lib/revenue-sources/uploads/service");
  const { createParserRegistry } = await import("@/lib/revenue-sources/uploads/registry");
  const { revenueReportUploadEnabled } = await import("@/lib/revenue-sources/uploads/http");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { signAuthToken } = await import("@/lib/auth-token");
  const routes = {
    list: await import("@/app/api/money/revenue-reports/route"),
    zAnalyze: await import("@/app/api/money/revenue-reports/z/analyze/route"),
    zCommit: await import("@/app/api/money/revenue-reports/z/commit/route"),
    sAnalyze: await import("@/app/api/money/revenue-reports/settlement/analyze/route"),
    sCommit: await import("@/app/api/money/revenue-reports/settlement/commit/route"),
  };
  const registry = createParserRegistry([TEST_ONLY_Z_PARSER, TEST_ONLY_S_PARSER]);
  const opts = { registry };

  const one = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as { id: number }[])[0].id);
  const count = async (sql: string, ...args: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...args)) as { n: number }[])[0].n);
  const business = (name: string) => one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
  const user = (biz: number, tag: string) => one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${tag}-${Date.now()}@rru.lab`, biz);
  const enable = (biz: number, key: string) => owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'ENABLED', now())`, biz, key);
  const closes = (biz: number) => count(`SELECT count(*)::int AS n FROM "RevenueDailyClose" WHERE "businessId" = $1`, biz);
  const settlements = (biz: number) => count(`SELECT count(*)::int AS n FROM "RevenueSettlement" WHERE "businessId" = $1`, biz);
  const runs = (biz: number, domain: string) => count(`SELECT count(*)::int AS n FROM "ImportRun" WHERE "businessId" = $1 AND "domain" = $2`, biz, domain);
  const snapshot = async () => JSON.stringify(await owner.$queryRawUnsafe(
    `SELECT (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialEvent" t) AS fe,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "FinancialRecord" t) AS fr,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "BillingDocument" t) AS bd,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "PaymentTransaction" t) AS pt,
            (SELECT coalesce(md5(string_agg(t::text, '|' ORDER BY t."id")), '-') FROM "ExternalTransaction" t) AS et,
            (SELECT count(*)::int FROM "FinancialRecord") AS fr_n`));

  // ── A. role and flags ──────────────────────────────────────────────────────────────────────────
  console.log("A. role and flags");
  const [role] = (await runtime.$queryRawUnsafe(`SELECT current_user::text AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)) as { who: string; rolsuper: boolean; rolbypassrls: boolean }[];
  ok(`the app runs as ${role.who}: NOSUPERUSER NOBYPASSRLS`, role.who === "app_runtime_prod" && !role.rolsuper && !role.rolbypassrls);
  const rows = (await owner.$queryRawUnsafe(
    `SELECT d."key", d."defaultEnabled", p."globalEnabled", p."emergencyDisabled" FROM "PlatformFeatureDefinition" d
       JOIN "PlatformFeaturePolicy" p ON p."featureKey" = d."key" WHERE d."key" IN ('z_report_upload', 'settlement_report_upload') ORDER BY 1`)) as { key: string; defaultEnabled: boolean; globalEnabled: boolean }[];
  ok("the data migration: both definitions + policies, all OFF (applied twice: idempotent)", rows.length === 2 && rows.every((r) => !r.defaultEnabled && !r.globalEnabled), JSON.stringify(rows));

  const bizA = await business("rru-A");
  const bizB = await business("rru-B");
  const bizOff = await business("rru-OFF");
  const userA = await user(bizA, "a");
  const userA2 = await user(bizA, "a2");
  const userB = await user(bizB, "b");
  const userOff = await user(bizOff, "off");
  ok("no override: OFF for every business and kind", !(await revenueReportUploadEnabled(bizA, "z")) && !(await revenueReportUploadEnabled(bizA, "settlement")));
  await enable(bizA, "z_report_upload");
  ok("an override opens ONE kind for ONE business", (await revenueReportUploadEnabled(bizA, "z")) && !(await revenueReportUploadEnabled(bizA, "settlement")) && !(await revenueReportUploadEnabled(bizB, "z")));
  await enable(bizA, "settlement_report_upload");
  await enable(bizB, "z_report_upload");
  await enable(bizB, "settlement_report_upload");

  const before = await snapshot();

  // ── B. routes ──────────────────────────────────────────────────────────────────────────────────
  console.log("B. routes (session, flag, shipped registry)");
  const tokenOf = (uid: number) => signAuthToken(uid, 0);
  const form = (bytes: Buffer, extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.set("file", new File([bytes], "report.csv", { type: "text/csv" }));
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const post = (url: string, auth: string | null, body: FormData) =>
    new NextRequest(`http://lab${url}`, { method: "POST", body, headers: auth ? { Authorization: `Bearer ${auth}` } : {} } as never);
  const get = (url: string, auth: string | null) => new NextRequest(`http://lab${url}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} } as never);

  ok("no session → 401", (await routes.zAnalyze.POST(post("/api/money/revenue-reports/z/analyze", null, form(zFile(Z1))))).status === 401);
  const offStatuses = [
    (await routes.zAnalyze.POST(post("/api/money/revenue-reports/z/analyze", tokenOf(userOff), form(zFile(Z1))))).status,
    (await routes.zCommit.POST(post("/api/money/revenue-reports/z/commit", tokenOf(userOff), form(zFile(Z1), { token: "x" })))).status,
    (await routes.sAnalyze.POST(post("/api/money/revenue-reports/settlement/analyze", tokenOf(userOff), form(sFile(S1))))).status,
    (await routes.sCommit.POST(post("/api/money/revenue-reports/settlement/commit", tokenOf(userOff), form(sFile(S1), { token: "x" })))).status,
    (await routes.list.GET(get("/api/money/revenue-reports", tokenOf(userOff)))).status,
  ];
  ok("feature OFF → 404 on analyze, commit and list, both kinds", offStatuses.every((s) => s === 404), offStatuses.join(","));
  const unsupported = await routes.zAnalyze.POST(post("/api/money/revenue-reports/z/analyze", tokenOf(userA), form(zFile(Z1))));
  const ub = (await unsupported.json()) as { error: string; message: string };
  ok("feature ON + the SHIPPED registry (no parsers): 422 FORMAT_NOT_SUPPORTED, in Hebrew, asking for a sample",
    unsupported.status === 422 && ub.error === "FORMAT_NOT_SUPPORTED" && ub.message.startsWith("עדיין לא תומכים בקובץ מהמערכת הזו"), `${unsupported.status} ${JSON.stringify(ub)}`);
  ok("…and private, no-store", unsupported.headers.get("cache-control") === "private, no-store");
  const sUnsupported = await routes.sAnalyze.POST(post("/api/money/revenue-reports/settlement/analyze", tokenOf(userA), form(sFile(S1))));
  ok("settlement route: the same", sUnsupported.status === 422);
  ok("nothing was written by an unsupported file", (await closes(bizA)) === 0 && (await settlements(bizA)) === 0 && (await runs(bizA, "z_report")) === 0);
  const listOk = await routes.list.GET(get("/api/money/revenue-reports", tokenOf(userA)));
  const listBody = (await listOk.json()) as { enabled: string[]; z: unknown[]; settlement: unknown[] };
  ok("list: 200 with both kinds, empty", listOk.status === 200 && listBody.enabled.length === 2 && listBody.z.length === 0 && listBody.settlement.length === 0);

  // ── C. Z through the fixture parser ────────────────────────────────────────────────────────────
  console.log("C. Z: analyze writes nothing, commit records evidence");
  const zIn = (biz: number, uid: number, bytes: Buffer) => ({ businessId: biz, userId: uid, kind: "z" as const, filename: "z.csv", bytes, mime: "text/csv" });
  const sIn = (biz: number, uid: number, bytes: Buffer) => ({ businessId: biz, userId: uid, kind: "settlement" as const, filename: "s.csv", bytes, mime: "text/csv" });
  const fileZ = zFile(Z1, Z2, Z3, "bad,row");
  const p1 = await svc.analyzeRevenueReport(zIn(bizA, userA, fileZ), opts);
  ok("analyze: 3 NEW, 1 invalid row, no conflicts", p1.counts.reports === 3 && p1.counts.new === 3 && p1.counts.invalid === 1 && p1.counts.conflicts === 0, JSON.stringify(p1.counts));
  ok("analyze wrote nothing", (await closes(bizA)) === 0 && (await runs(bizA, "z_report")) === 0);
  ok("analyze says the file is not stored", p1.sourceFileStored === false);
  const c1 = await svc.commitRevenueReport({ ...zIn(bizA, userA, fileZ), token: p1.token }, opts);
  ok("commit: 3 recorded, 1 invalid", !c1.replayed && c1.recorded === 3 && c1.invalid === 1, JSON.stringify(c1));
  const zRows = (await owner.$queryRawUnsafe(
    `SELECT "id", "sourceKind"::text AS sk, "capture"::text AS cap, "sourceScope" AS scope, "externalId" AS ext, "revision", "ingestRef" AS ref,
            "sourcePayloadHash" AS h, "totalMinor"::text AS total, "validation"::text AS v, "connectionId" AS conn, "documentId" AS doc
       FROM "RevenueDailyClose" WHERE "businessId" = $1 ORDER BY "id"`, bizA)) as Array<{ id: number; sk: string; cap: string; scope: string; ext: string; revision: number; ref: string; h: string; total: string; v: string; conn: number | null; doc: number | null }>;
  ok("rows: POS / FILE_STRUCTURED / upload.z.test_only_fixture / revision 1 / no connection, no document",
    zRows.length === 3 && zRows.every((r) => r.sk === "POS" && r.cap === "FILE_STRUCTURED" && r.scope === "upload.z.test_only_fixture" && r.revision === 1 && r.conn === null && r.doc === null), JSON.stringify(zRows));
  ok("each row names its run (ingestRef) and its facts hash", zRows.every((r) => r.ref === `importrun:${c1.importRunId}` && /^[0-9a-f]{64}$/.test(r.h)));
  ok("Z identity = its Z number", zRows.map((r) => r.ext).join(",") === "z:101,z:102,z:201");
  ok("tender and VAT lines written with each Z", (await count(`SELECT count(*)::int AS n FROM "RevenueDailyCloseTender" WHERE "businessId" = $1`, bizA)) === 6
    && (await count(`SELECT count(*)::int AS n FROM "RevenueDailyCloseVat" WHERE "businessId" = $1`, bizA)) === 3);
  const [run] = (await owner.$queryRawUnsafe(`SELECT "domain", "contentHash", "status"::text AS status, "createdCount", "skippedCount", "failedCount", "totalRows", "sheetName" FROM "ImportRun" WHERE "id" = $1`, c1.importRunId)) as Array<Record<string, unknown>>;
  ok("one ImportRun: z_report, the file's sha256 (not the file), COMPLETED 3 / 0 / 1 of 4",
    run.domain === "z_report" && run.contentHash === createHash("sha256").update(fileZ).digest("hex") && run.status === "COMPLETED"
      && run.createdCount === 3 && run.skippedCount === 0 && run.failedCount === 1 && run.totalRows === 4, JSON.stringify(run));

  // ── D. replays ─────────────────────────────────────────────────────────────────────────────────
  console.log("D. replays");
  const c1b = await svc.commitRevenueReport({ ...zIn(bizA, userA, fileZ), token: p1.token }, opts);
  ok("the same commit again: replayed, same run, nothing written", c1b.replayed && c1b.importRunId === c1.importRunId && (await closes(bizA)) === 3);
  const p1c = await svc.analyzeRevenueReport(zIn(bizA, userA, fileZ), opts);
  ok("a fresh analyze: all EXISTING, 'already imported' date shown", p1c.counts.existing === 3 && p1c.counts.new === 0 && p1c.previouslyImportedAt !== null);
  const c1c = await svc.commitRevenueReport({ ...zIn(bizA, userA, fileZ), token: p1c.token }, opts);
  ok("…its commit is a replay of the first run", c1c.replayed && c1c.importRunId === c1.importRunId && (await runs(bizA, "z_report")) === 1);
  const other = zFile("# exported again", Z2);
  const p2 = await svc.analyzeRevenueReport(zIn(bizA, userA, other), opts);
  const c2 = await svc.commitRevenueReport({ ...zIn(bizA, userA, other), token: p2.token }, opts);
  ok("the same Z inside another file: EXISTING, a new run recording 0", p2.counts.existing === 1 && !c2.replayed && c2.recorded === 0 && c2.existing === 1 && (await closes(bizA)) === 3);

  // ── E. conflicts ───────────────────────────────────────────────────────────────────────────────
  console.log("E. conflicts — never silently overwritten");
  const changed = zFile(Z1_CHANGED);
  const pc = await svc.analyzeRevenueReport(zIn(bizA, userA, changed), opts);
  const row0 = pc.rows[0] as { status: string; conflict: { conflict: string; allowed: string[] } | null };
  ok("same Z, other numbers: CONFLICT SAME_Z, SKIP / SUPERSEDE", row0.status === "CONFLICT" && row0.conflict?.conflict === "SAME_Z" && row0.conflict.allowed.join() === "SKIP,SUPERSEDE");
  ok("commit without a decision: DECISIONS_REQUIRED, nothing written",
    (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, changed), token: pc.token }, opts))) === "DECISIONS_REQUIRED" && (await closes(bizA)) === 3);
  ok("a decision the conflict does not allow (ADD on SAME_Z): DECISIONS_INVALID",
    (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, changed), token: pc.token, decisions: { 0: "ADD" } }, opts))) === "DECISIONS_INVALID");
  ok("a decision on a row that is not a conflict: DECISIONS_INVALID",
    (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, changed), token: pc.token, decisions: { 0: "SKIP", 5: "SKIP" } }, opts))) === "DECISIONS_INVALID");
  const skip = await svc.commitRevenueReport({ ...zIn(bizA, userA, changed), token: pc.token, decisions: { 0: "SKIP" } }, opts);
  ok("SKIP: nothing written, the recorded Z unchanged", skip.recorded === 0 && skip.skippedByDecision === 1 && (await closes(bizA)) === 3);
  const sup = await svc.commitRevenueReport({ ...zIn(bizA, userA, changed), token: pc.token, decisions: { 0: "SUPERSEDE" } }, opts);
  const chain = (await owner.$queryRawUnsafe(`SELECT "id", "revision", "supersedesId" FROM "RevenueDailyClose" WHERE "businessId" = $1 AND "externalId" = 'z:101' ORDER BY "revision"`, bizA)) as Array<{ id: number; revision: number; supersedesId: number | null }>;
  ok("SUPERSEDE (a re-decision = a new run): revision 2 naming revision 1; revision 1 kept as recorded",
    !sup.replayed && sup.recorded === 1 && sup.superseded === 1 && chain.length === 2 && chain[1].revision === 2 && chain[1].supersedesId === chain[0].id, JSON.stringify(chain));
  const pAfter = await svc.analyzeRevenueReport(zIn(bizA, userA, changed), opts);
  ok("the corrected file again: EXISTING (the chain's latest revision)", pAfter.counts.existing === 1 && pAfter.counts.conflicts === 0);
  const pOrig = await svc.analyzeRevenueReport(zIn(bizA, userA, zFile(Z1)), opts);
  ok("the ORIGINAL numbers again: a CONFLICT with revision 2, never a silent revert", pOrig.counts.conflicts === 1);
  const shift = zFile(Z1_SECOND_SHIFT);
  const ps = await svc.analyzeRevenueReport(zIn(bizA, userA, shift), opts);
  const rs = ps.rows[0] as { status: string; conflict: { conflict: string; allowed: string[] } | null };
  ok("another Z of the same register and day: CONFLICT SAME_DAY, SKIP / ADD", rs.status === "CONFLICT" && rs.conflict?.conflict === "SAME_DAY" && rs.conflict.allowed.join() === "SKIP,ADD");
  ok("SUPERSEDE refused on SAME_DAY", (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, shift), token: ps.token, decisions: { 0: "SUPERSEDE" } }, opts))) === "DECISIONS_INVALID");
  const add = await svc.commitRevenueReport({ ...zIn(bizA, userA, shift), token: ps.token, decisions: { 0: "ADD" } }, opts);
  ok("ADD: recorded as its own Z (revision 1)", add.recorded === 1 && (await count(`SELECT count(*)::int AS n FROM "RevenueDailyClose" WHERE "businessId" = $1 AND "externalId" = 'z:103' AND "revision" = 1`, bizA)) === 1);
  const listed = await svc.listUploadedZReports(bizA);
  ok("list: 5 rows, revision 1 of z:101 marked superseded", listed.length === 5 && listed.filter((r) => r.superseded).length === 1 && listed.find((r) => r.superseded)?.zNumber === "101");

  // ── F. settlement ──────────────────────────────────────────────────────────────────────────────
  console.log("F. settlement");
  const fileS = sFile(S1, S2);
  const sp = await svc.analyzeRevenueReport(sIn(bizA, userA, fileS), opts);
  const sc = await svc.commitRevenueReport({ ...sIn(bizA, userA, fileS), token: sp.token }, opts);
  const sRows = (await owner.$queryRawUnsafe(`SELECT "sourceKind"::text AS sk, "capture"::text AS cap, "sourceScope" AS scope, "netMinor"::text AS net, "acquirer" FROM "RevenueSettlement" WHERE "businessId" = $1 ORDER BY "id"`, bizA)) as Array<{ sk: string; cap: string; scope: string; net: string; acquirer: string }>;
  ok("2 settlements: ACQUIRER / FILE_STRUCTURED / upload.settlement.test_only_fixture; net as reported",
    sc.recorded === 2 && sRows.length === 2 && sRows.every((r) => r.sk === "ACQUIRER" && r.cap === "FILE_STRUCTURED" && r.scope === "upload.settlement.test_only_fixture") && sRows.map((r) => r.net).join() === "61070,39300", JSON.stringify(sRows));
  ok("one ImportRun of domain settlement_report", (await runs(bizA, "settlement_report")) === 1);
  const sReplay = await svc.commitRevenueReport({ ...sIn(bizA, userA, fileS), token: sp.token }, opts);
  ok("replay: nothing written", sReplay.replayed && (await settlements(bizA)) === 2);
  const sChanged = sFile("ACQ-1,2026-10-03,62000,1000,0,61000");
  const spc = await svc.analyzeRevenueReport(sIn(bizA, userA, sChanged), opts);
  const sr = spc.rows[0] as { status: string; conflict: { allowed: string[] } | null };
  ok("same settlement id, other amounts: CONFLICT, SKIP only", sr.status === "CONFLICT" && sr.conflict?.allowed.join() === "SKIP");
  ok("SUPERSEDE refused for a settlement", (await errorCode(() => svc.commitRevenueReport({ ...sIn(bizA, userA, sChanged), token: spc.token, decisions: { 0: "SUPERSEDE" } }, opts))) === "DECISIONS_INVALID");
  const sSkip = await svc.commitRevenueReport({ ...sIn(bizA, userA, sChanged), token: spc.token, decisions: { 0: "SKIP" } }, opts);
  ok("SKIP: the recorded settlement stays as it was", sSkip.recorded === 0 && (await count(`SELECT count(*)::int AS n FROM "RevenueSettlement" WHERE "businessId" = $1 AND "netMinor" = 61070`, bizA)) === 1);

  // ── G. tokens and files ────────────────────────────────────────────────────────────────────────
  console.log("G. tokens and files");
  const fresh = zFile("2026-10-05,1,105,1000,0,0,0,1000,153,1000,0");
  const pf = await svc.analyzeRevenueReport(zIn(bizA, userA, fresh), opts);
  ok("a forged token", (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, fresh), token: "forged" }, opts))) === "TOKEN_INVALID");
  ok("a token of another user of the same business", (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA2, fresh), token: pf.token }, opts))) === "TOKEN_INVALID");
  ok("a Z token used for a settlement", (await errorCode(() => svc.commitRevenueReport({ ...sIn(bizA, userA, fresh), token: pf.token }, opts))) === "TOKEN_INVALID");
  ok("the token with other bytes: FILE_CHANGED", (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, zFile("2026-10-05,1,105,1001,0,0,0,1001,153,1001,0")), token: pf.token }, opts))) === "FILE_CHANGED");
  ok("the token after the parser changed version: FILE_CHANGED",
    (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizA, userA, fresh), token: pf.token }, { registry: createParserRegistry([{ ...TEST_ONLY_Z_PARSER, version: 2 }]) }))) === "FILE_CHANGED");
  ok("…none of it wrote anything", (await count(`SELECT count(*)::int AS n FROM "RevenueDailyClose" WHERE "businessId" = $1 AND "externalId" = 'z:105'`, bizA)) === 0);

  // ── H. tenant isolation ────────────────────────────────────────────────────────────────────────
  console.log("H. tenant isolation");
  ok("B cannot use A's token (another business)", (await errorCode(() => svc.commitRevenueReport({ ...zIn(bizB, userB, fresh), token: pf.token }, opts))) === "TOKEN_INVALID");
  const pb = await svc.analyzeRevenueReport(zIn(bizB, userB, fileZ), opts);
  ok("B analyzing A's file sees NONE of A's rows: all NEW", pb.counts.new === 3 && pb.counts.existing === 0 && pb.previouslyImportedAt === null);
  const cb = await svc.commitRevenueReport({ ...zIn(bizB, userB, fileZ), token: pb.token }, opts);
  ok("B records its own (A's rows untouched)", cb.recorded === 3 && (await closes(bizB)) === 3 && (await closes(bizA)) === 5);
  ok("B's list shows only B's rows; A's only A's", (await svc.listUploadedZReports(bizB)).length === 3 && (await svc.listUploadedSettlements(bizB)).length === 0 && (await svc.listUploadedSettlements(bizA)).length === 2);
  const bListRoute = (await (await routes.list.GET(get("/api/money/revenue-reports", tokenOf(userB)))).json()) as { z: Array<{ id: number }> };
  const aIds = new Set((await svc.listUploadedZReports(bizA)).map((r) => r.id));
  ok("the list ROUTE for B carries no row of A", bListRoute.z.length === 3 && bListRoute.z.every((r) => !aIds.has(r.id)));
  const peek = await tenantTx(bizA, (tx) => tx.revenueDailyClose.count({ where: { businessId: bizB } }));
  ok("as A, a query naming B's businessId sees 0 rows (RLS)", peek === 0);
  const crossInsert = await errorCode(() => tenantTx(bizA, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO "RevenueDailyClose" ("businessId","sourceKind","capture","sourceScope","registerKey","externalId","businessDay","currency","grossMinor","totalMinor","vatMinor","validation")
     VALUES ($1,'POS','FILE_STRUCTURED','upload.z.x','1','z:9','2026-10-01','ILS',1,1,0,'PASSED')`, bizB)));
  ok("as A, inserting a row for B is refused by RLS", /row-level security|42501|P2010/i.test(crossInsert), crossInsert);
  const crossRun = await errorCode(() => tenantTx(bizA, (tx) => tx.importRun.create({ data: { businessId: bizB, userId: userA, domain: "z_report", contentHash: "x", mappingHash: "x", decisionsHash: "x", retryKey: `x-${Date.now()}`, totalRows: 0 } })));
  ok("as A, opening a run for B is refused by RLS", crossRun !== "", crossRun);
  const update = await errorCode(() => tenantTx(bizA, (tx) => tx.$executeRawUnsafe(`UPDATE "RevenueDailyClose" SET "totalMinor" = 0 WHERE "businessId" = $1`, bizA)));
  ok("the runtime cannot UPDATE a recorded Z (SELECT / INSERT only)", /permission denied|42501|P2010/i.test(update), update);

  // ── I. concurrency ─────────────────────────────────────────────────────────────────────────────
  console.log("I. concurrency");
  const cc = zFile("2026-10-07,1,107,7000,0,0,0,7000,1068,7000,0", "2026-10-08,1,108,8000,0,0,0,8000,1220,8000,0");
  const pcc = await svc.analyzeRevenueReport(zIn(bizA, userA, cc), opts);
  const results = await Promise.allSettled([0, 1, 2, 3].map(() => svc.commitRevenueReport({ ...zIn(bizA, userA, cc), token: pcc.token }, opts)));
  const okResults = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.commitRevenueReport>>> => r.status === "fulfilled").map((r) => r.value);
  ok("four concurrent commits: all answer, one run, the others replay it", okResults.length === 4 && new Set(okResults.map((r) => r.importRunId)).size === 1 && okResults.filter((r) => !r.replayed).length === 1,
    JSON.stringify(results.map((r) => (r.status === "fulfilled" ? r.value.replayed : String((r as PromiseRejectedResult).reason)))));
  ok("…and the two Z reports exist once", (await count(`SELECT count(*)::int AS n FROM "RevenueDailyClose" WHERE "businessId" = $1 AND "externalId" IN ('z:107','z:108')`, bizA)) === 2);

  // ── J. no income ───────────────────────────────────────────────────────────────────────────────
  console.log("J. no income, no documents, no bank lines");
  const after = await snapshot();
  ok("FinancialRecord / FinancialEvent / BillingDocument / PaymentTransaction / ExternalTransaction byte-identical", before === after, `${before} vs ${after}`);
  ok("no FinancialRecord exists for either business", (await count(`SELECT count(*)::int AS n FROM "FinancialRecord" WHERE "businessId" IN ($1, $2)`, bizA, bizB)) === 0);

  await runtime.$disconnect();
  await owner.$disconnect();
  console.log(`\n[revenue-report-uploads battery] PASS=${pass} FAIL=${failures.length}`);
  if (failures.length) { console.log("FAILURES:\n  " + failures.join("\n  ")); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
