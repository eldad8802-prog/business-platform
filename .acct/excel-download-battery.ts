/**
 * Monthly accountant workflow — the Excel report download (PR-A), through the REAL route, on the
 * Production-shaped lab (app_runtime_prod, NOBYPASSRLS; the auth plane reads User / AuthSession through
 * AUTH_DATABASE_URL, pointed at the owner in the lab).
 *
 *   1. ?format=xlsx hands out the workbook that is INSIDE the sealed ZIP, byte for byte.
 *   2. It is cached as a private sibling of the package, bound to the full package sha256; the second
 *      download is served from the cache even when the ZIP can no longer be read.
 *   3. A stored ZIP that does not hash to the sealed sha256 is refused (409 PACKAGE_INTEGRITY): nothing is
 *      cached and no download is recorded.
 *   4. Each successful download is recorded once, with its format; ?format=zip still hands out the ZIP.
 *   5. Isolation and gates: another business's package is 404; a business without the feature is 404;
 *      no session is 401; an unknown format is 400.
 *   6. The package itself never changes (status, version, sha256, storage key) and nothing is sent.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Synthetic only. ZERO network.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-xlsx-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
delete process.env.ACCOUNTANT_DELIVERY_ENABLED;

import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error("no network"); }) as typeof fetch;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const prep = await import("@/lib/accountant/prepare.service");
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const { signAuthToken } = await import("@/lib/auth-token");
  const { getStorageService } = await import("@/lib/storage");
  const route = await import("@/app/api/accountant/packages/[packageId]/download/route");
  const storage = getStorageService();

  for (const t of ["FinancialRecord", "Document", "BillingDocument", "BillingAuthoritySubmission", "Notification", "NotificationDelivery", "BusinessProfile", "BusinessFeatureAccess"]) {
    const on = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, t)) as { f: boolean }[];
    if (on[0]?.f) continue;
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY acct_lab_tenant ON "${t}" FOR ALL
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }

  // ── Fixtures: A and C enabled (each with September documents); B enabled with its own package; D off ──
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  let n = 0;
  const business = async (name: string, enabled: boolean) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}@xlsx.lab`, b);
    if (enabled) await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    for (const day of ["05", "18"]) {
      const basename = `doc-${Date.now()}${++n}-xlsx.pdf`;
      await putDocumentObject({ businessId: b, basename, body: Buffer.from(`%PDF-xlsx-${n}`), contentType: "application/pdf", source: "file" });
      const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp) RETURNING "id"`, b, basename, `2026-09-${day}T08:00:00`);
      await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, $3, $4::timestamp, 'ספק', 'expense', 'general')`, d, b, 100 + n, `2026-09-${day}T00:00:00`);
    }
    return { b, token: signAuthToken(u, 0) };
  };
  const A = await business("xa", true);
  const B = await business("xb", true);
  const C = await business("xc", true);
  const D = await business("xd", false);

  const clock = new Date("2026-10-02T06:00:00Z");
  const build = (b: number) => runWithTenantContext({ businessId: b }, () =>
    prep.preparePeriod({ businessId: b, periodKey: "2026-09", trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, { ...prep.defaultPrepareDeps, now: () => clock }));
  for (const x of [A, B, C]) await build(x.b);
  const pkgOf = async (b: number) => ((await owner.$queryRawUnsafe(`SELECT id, version, status, sha256, "storageKey" AS key FROM "AccountantPackage" WHERE "businessId" = $1 AND status = 'READY'`, b)) as { id: number; version: number; status: string; sha256: string; key: string }[])[0];
  const pA = await pkgOf(A.b), pB = await pkgOf(B.b), pC = await pkgOf(C.b);
  ok("setup: one READY package each for A, B and C", !!pA && !!pB && !!pC);

  const get = (pkgId: number, token: string | null, format?: string) =>
    route.GET(new Request(`https://app.example.com/api/accountant/packages/${pkgId}/download${format ? `?format=${format}` : ""}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      { params: Promise.resolve({ packageId: String(pkgId) }) });
  const events = async (pkgId: number) => (await owner.$queryRawUnsafe(`SELECT payload->>'format' AS f FROM "AccountantWorkflowEvent" WHERE "packageId" = $1 AND "eventType" = 'PACKAGE_DOWNLOADED_BY_OWNER' ORDER BY id`, pkgId)) as { f: string }[];
  const root = process.env.LOCAL_STORAGE_ROOT!;
  const localPath = (key: string) => path.join(root, ...key.split("/"));

  // ── 1. The workbook inside the ZIP, byte for byte ──────────────────────────────────────────────
  console.log("1. the workbook inside the sealed ZIP");
  const zipBytes = (await storage.getObject(pA.key)).body;
  const inner = await (await JSZip.loadAsync(zipBytes)).file("דוח_2026-09.xlsx")!.async("nodebuffer");
  let r = await get(pA.id, A.token, "xlsx");
  const first = Buffer.from(await r.arrayBuffer());
  ok("1a 200, served as an Excel file", r.status === 200 && (r.headers.get("content-type") ?? "").includes("spreadsheetml"), `${r.status} ${r.headers.get("content-type")}`);
  ok("1b the bytes are the workbook inside the package, unchanged", sha(first) === sha(inner) && first.length > 0, `${sha(first)} vs ${sha(inner)}`);
  ok("1c the file name says what it is", (r.headers.get("content-disposition") ?? "").includes("accountant-report-2026-09-v1.xlsx"));

  // ── 2. The private, version-bound cache ────────────────────────────────────────────────────────
  console.log("2. the cache");
  const cacheKey = pA.key.replace(/\/[^/]+$/, `/v${pA.version}-${pA.sha256}.report.xlsx`);
  const head = await storage.headObject(cacheKey);
  ok("2a cached next to the package, private, under the same business", head.exists && head.metadata?.visibility === "private" && head.metadata?.domain === "exports" && head.metadata?.businessId === A.b, JSON.stringify(head.metadata));
  ok("2b its metadata binds it to the sealed package sha256 and records its own", head.metadata?.custom?.sourceSha256 === pA.sha256 && head.metadata?.custom?.sha256 === sha(inner));
  renameSync(localPath(pA.key), localPath(pA.key) + ".moved"); // the ZIP can no longer be read
  r = await get(pA.id, A.token, "xlsx");
  ok("2c the second download is served from the cache (the ZIP is not read)", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(inner), String(r.status));
  renameSync(localPath(pA.key) + ".moved", localPath(pA.key));

  // ── 3. Integrity ───────────────────────────────────────────────────────────────────────────────
  console.log("3. a stored ZIP that does not match the sealed sha256");
  const meta = (await storage.getObject(pC.key)).metadata;
  await storage.putObject({ key: pC.key, body: Buffer.concat([zipBytes, Buffer.from("tampered")]), contentType: "application/zip", metadata: { businessId: meta.businessId, domain: "exports", visibility: "private" } });
  r = await get(pC.id, C.token, "xlsx");
  const body3 = (await r.json()) as { error?: string };
  ok("3a refused: 409 PACKAGE_INTEGRITY", r.status === 409 && body3.error === "PACKAGE_INTEGRITY", `${r.status} ${JSON.stringify(body3)}`);
  ok("3b nothing was cached", !(await storage.headObject(pC.key.replace(/\/[^/]+$/, `/v${pC.version}-${pC.sha256}.report.xlsx`))).exists);
  ok("3c no download was recorded", (await events(pC.id)).length === 0);

  // ── 4. The trail and the ZIP ───────────────────────────────────────────────────────────────────
  console.log("4. the trail, and the ZIP still");
  r = await get(pA.id, A.token);
  const zipServed = Buffer.from(await r.arrayBuffer());
  ok("4a without a format (and with ?format=zip) the ZIP itself is handed out", r.status === 200 && (r.headers.get("content-type") ?? "").includes("zip") && sha(zipServed) === pA.sha256);
  r = await get(pA.id, A.token, "zip");
  ok("4b ?format=zip is the same ZIP", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === pA.sha256);
  const ev = (await events(pA.id)).map((e) => e.f);
  ok("4c each successful download recorded once, with its format: xlsx, xlsx, zip, zip", JSON.stringify(ev) === JSON.stringify(["xlsx", "xlsx", "zip", "zip"]), JSON.stringify(ev));

  // ── 5. Isolation and gates ─────────────────────────────────────────────────────────────────────
  console.log("5. isolation and gates");
  r = await get(pA.id, B.token, "xlsx");
  ok("5a business B asking for A's package (Excel) → 404", r.status === 404, String(r.status));
  r = await get(pA.id, B.token);
  ok("5b business B asking for A's package (ZIP) → 404", r.status === 404, String(r.status));
  r = await get(pB.id, D.token, "xlsx");
  ok("5c a business without the feature → 404", r.status === 404, String(r.status));
  r = await get(pA.id, null, "xlsx");
  ok("5d no session → 401", r.status === 401, String(r.status));
  r = await get(pA.id, A.token, "pdf");
  ok("5e an unknown format (pdf is not part of PR-A) → 400 INVALID_FORMAT", r.status === 400 && ((await r.json()) as { error?: string }).error === "INVALID_FORMAT", String(r.status));
  ok("5f B's own package is untouched by A's downloads (no event)", (await events(pB.id)).length === 0);

  // ── 6. The package never changes; nothing is sent ──────────────────────────────────────────────
  console.log("6. the package never changes");
  const after = await pkgOf(A.b);
  ok("6a status, version, sha256 and storage key unchanged", after.id === pA.id && after.status === "READY" && after.version === pA.version && after.sha256 === pA.sha256 && after.key === pA.key);
  ok("6b the stored ZIP still hashes to the sealed sha256", sha(readFileSync(localPath(pA.key))) === pA.sha256 || sha((await storage.getObject(pA.key)).body) === pA.sha256);
  const deliveries = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantDelivery"`)) as { n: number }[];
  ok("6c zero deliveries, zero network calls", deliveries[0].n === 0 && networkCalls === 0, `${deliveries[0].n} | ${networkCalls}`);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
