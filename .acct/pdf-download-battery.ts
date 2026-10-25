/**
 * Monthly accountant workflow — the PDF report download (R1), through the REAL route and Chromium, on the
 * Production-shaped lab (app_runtime_prod, NOBYPASSRLS; the auth plane reads User / AuthSession through
 * AUTH_DATABASE_URL, pointed at the owner in the lab).
 *
 *   1. ?format=pdf hands out a real PDF (A4, embedded Hebrew font) rendered from the sealed package's own
 *      workbook — its values are the workbook's (the model is proven cell by cell in
 *      lib/accountant/package-report-pdf.verify.test.ts).
 *   2. It is cached privately next to the package, bound to the full package sha256 AND the layout version;
 *      the second download is served from the cache even when the ZIP can no longer be read.
 *   3. A stored ZIP that does not hash to the sealed sha256 is refused (409): nothing cached, nothing recorded.
 *   4. A rendering failure is a clean 500 PDF_RENDER_FAILED: nothing cached.
 *   5. Each successful download is recorded once with format pdf; ZIP and Excel still work.
 *   6. Isolation and gates: another business → 404; feature off → 404; no session → 401.
 *   7. The package itself never changes, and nothing is sent.
 *
 * env: OWNER_URL, DATABASE_URL (runtime). Synthetic only. ZERO network (Chromium renders a data-only page).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-pdf-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
delete process.env.ACCOUNTANT_DELIVERY_ENABLED;

import { PrismaClient } from "@prisma/client";
import { PDFDocument } from "pdf-lib";

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
  const reports = await import("@/lib/accountant/package-reports");
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

  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  let n = 0;
  const business = async (name: string, enabled: boolean) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}@pdf.lab`, b);
    if (enabled) await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    for (const [day, vendor] of [["05", "חברת החשמל לישראל בע\"מ"], ["18", "סונול — תחנה 12"]] as const) {
      const basename = `doc-${Date.now()}${++n}-pdf.pdf`;
      await putDocumentObject({ businessId: b, basename, body: Buffer.from(`%PDF-pdf-${n}`), contentType: "application/pdf", source: "file" });
      const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp) RETURNING "id"`, b, basename, `2026-09-${day}T08:00:00`);
      await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, $3, $4::timestamp, $5, 'expense', 'general')`, d, b, 1000 + n + 0.5, `2026-09-${day}T00:00:00`, vendor);
    }
    return { b, token: signAuthToken(u, 0) };
  };
  const A = await business("pa", true);
  const B = await business("pb", true);
  const C = await business("pc", true);
  const D = await business("pd", false);

  const clock = new Date("2026-10-02T06:00:00Z");
  for (const x of [A, B, C]) {
    await runWithTenantContext({ businessId: x.b }, () =>
      prep.preparePeriod({ businessId: x.b, periodKey: "2026-09", trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, { ...prep.defaultPrepareDeps, now: () => clock }));
  }
  const pkgOf = async (b: number) => ((await owner.$queryRawUnsafe(`SELECT id, version, status, sha256, "storageKey" AS key FROM "AccountantPackage" WHERE "businessId" = $1 AND status = 'READY'`, b)) as { id: number; version: number; status: string; sha256: string; key: string }[])[0];
  const pA = await pkgOf(A.b), pB = await pkgOf(B.b), pC = await pkgOf(C.b);
  ok("setup: one READY package each for A, B and C", !!pA && !!pB && !!pC);

  const get = (pkgId: number, token: string | null, format?: string) =>
    route.GET(new Request(`https://app.example.com/api/accountant/packages/${pkgId}/download${format ? `?format=${format}` : ""}`, token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      { params: Promise.resolve({ packageId: String(pkgId) }) });
  const events = async (pkgId: number) => (await owner.$queryRawUnsafe(`SELECT payload->>'format' AS f FROM "AccountantWorkflowEvent" WHERE "packageId" = $1 AND "eventType" = 'PACKAGE_DOWNLOADED_BY_OWNER' ORDER BY id`, pkgId)) as { f: string }[];
  const root = process.env.LOCAL_STORAGE_ROOT!;
  const localPath = (key: string) => path.join(root, ...key.split("/"));
  const pdfKey = (p: { key: string; version: number; sha256: string }) => reports.packagePdfCacheKey(p.key, p.version, p.sha256);

  // ── 1. A real PDF ──────────────────────────────────────────────────────────────────────────────
  console.log("1. a real PDF from the sealed package");
  let r = await get(pA.id, A.token, "pdf");
  const first = Buffer.from(await r.arrayBuffer());
  ok("1a 200, served as a PDF", r.status === 200 && (r.headers.get("content-type") ?? "").includes("application/pdf"), `${r.status} ${r.headers.get("content-type")}`);
  ok("1b a well-formed PDF document", first.subarray(0, 5).toString("latin1") === "%PDF-" && (await PDFDocument.load(first)).getPageCount() >= 1);
  ok("1c the Hebrew font is embedded", /NotoSansHebrew/.test(first.toString("latin1")));
  ok("1d the file name says what it is", (r.headers.get("content-disposition") ?? "").includes("accountant-report-2026-09-v1.pdf"));
  const page = (await PDFDocument.load(first)).getPage(0).getSize();
  ok("1e A4 pages (595 x 842 pt, within 2 pt)", Math.abs(page.width - 595.28) <= 2 && Math.abs(page.height - 841.89) <= 2, JSON.stringify(page));

  // ── 2. The cache ───────────────────────────────────────────────────────────────────────────────
  console.log("2. the cache");
  const head = await storage.headObject(pdfKey(pA));
  ok("2a cached next to the package: private, exports, same business, layout r1", head.exists && head.metadata?.visibility === "private" && head.metadata?.domain === "exports" && head.metadata?.businessId === A.b && head.metadata?.custom?.template === "r1", JSON.stringify(head.metadata));
  ok("2b bound to the sealed package sha256, with its own sha256", head.metadata?.custom?.sourceSha256 === pA.sha256 && head.metadata?.custom?.sha256 === sha(first));
  ok("2c the key carries the full package sha256 and the layout version", pdfKey(pA).endsWith(`/v1-${pA.sha256}.report-r1.pdf`), pdfKey(pA));
  renameSync(localPath(pA.key), localPath(pA.key) + ".moved");
  r = await get(pA.id, A.token, "pdf");
  ok("2d the second download is served from the cache (the ZIP is not read)", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(first), String(r.status));
  renameSync(localPath(pA.key) + ".moved", localPath(pA.key));

  // ── 3. Integrity ───────────────────────────────────────────────────────────────────────────────
  console.log("3. integrity");
  const zipC = await storage.getObject(pC.key);
  await storage.putObject({ key: pC.key, body: Buffer.concat([zipC.body, Buffer.from("tampered")]), contentType: "application/zip", metadata: { businessId: C.b, domain: "exports", visibility: "private" } });
  r = await get(pC.id, C.token, "pdf");
  const b3 = (await r.json()) as { error?: string };
  ok("3a refused: 409 PACKAGE_INTEGRITY", r.status === 409 && b3.error === "PACKAGE_INTEGRITY", `${r.status} ${JSON.stringify(b3)}`);
  ok("3b nothing cached, nothing recorded", !(await storage.headObject(pdfKey(pC))).exists && (await events(pC.id)).length === 0);
  await storage.putObject({ key: pC.key, body: zipC.body, contentType: "application/zip", metadata: { businessId: C.b, domain: "exports", visibility: "private" } });

  // ── 4. A rendering failure ─────────────────────────────────────────────────────────────────────
  console.log("4. a rendering failure");
  let code = "";
  try {
    await reports.ensurePackagePdf({ businessId: C.b, periodKey: "2026-09", version: pC.version, storageKey: pC.key, sha256: pC.sha256 },
      { ...reports.defaultPdfDeps, renderPdf: async () => { throw new Error("lab: chromium unavailable"); } });
  } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok("4a a renderer failure is PDF_RENDER_FAILED", code === "PDF_RENDER_FAILED", code);
  ok("4b nothing was cached", !(await storage.headObject(pdfKey(pC))).exists);
  try {
    await reports.ensurePackagePdf({ businessId: C.b, periodKey: "2026-09", version: pC.version, storageKey: pC.key, sha256: pC.sha256 },
      { ...reports.defaultPdfDeps, renderPdf: async () => Buffer.from("<html>not a pdf</html>") });
    code = "";
  } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  ok("4c a renderer that returns something that is not a PDF is refused, not cached", code === "PDF_RENDER_FAILED" && !(await storage.headObject(pdfKey(pC))).exists, code);

  // ── 5. Trail; ZIP and Excel still work ─────────────────────────────────────────────────────────
  console.log("5. trail, ZIP and Excel");
  r = await get(pA.id, A.token, "xlsx");
  ok("5a Excel still works", r.status === 200 && (r.headers.get("content-type") ?? "").includes("spreadsheetml"));
  r = await get(pA.id, A.token);
  ok("5b the ZIP still works, unchanged", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === pA.sha256);
  const ev = (await events(pA.id)).map((e) => e.f);
  ok("5c each successful download recorded once with its format: pdf, pdf, xlsx, zip", JSON.stringify(ev) === JSON.stringify(["pdf", "pdf", "xlsx", "zip"]), JSON.stringify(ev));

  // ── 6. Isolation and gates ─────────────────────────────────────────────────────────────────────
  console.log("6. isolation and gates");
  r = await get(pA.id, B.token, "pdf");
  ok("6a business B asking for A's PDF → 404", r.status === 404, String(r.status));
  r = await get(pB.id, D.token, "pdf");
  ok("6b a business without the feature → 404", r.status === 404, String(r.status));
  r = await get(pA.id, null, "pdf");
  ok("6c no session → 401", r.status === 401, String(r.status));
  r = await get(pA.id, A.token, "docx");
  ok("6d an unknown format → 400", r.status === 400, String(r.status));
  ok("6e B's package untouched (no event, no PDF cached)", (await events(pB.id)).length === 0 && !(await storage.headObject(pdfKey(pB))).exists);

  // ── 7. The package never changes; nothing is sent ──────────────────────────────────────────────
  console.log("7. the package never changes");
  const after = await pkgOf(A.b);
  ok("7a status, version, sha256 and storage key unchanged", after.id === pA.id && after.status === "READY" && after.version === pA.version && after.sha256 === pA.sha256 && after.key === pA.key);
  ok("7b the stored ZIP still hashes to the sealed sha256", sha((await storage.getObject(pA.key)).body) === pA.sha256);
  const deliveries = (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantDelivery"`)) as { n: number }[];
  ok("7c zero deliveries, zero network calls", deliveries[0].n === 0 && networkCalls === 0, `${deliveries[0].n} | ${networkCalls}`);

  await owner.$disconnect();
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
