/**
 * Accountant portal (R2–R4) — the accountant's link end to end, through the REAL routes, on the Production-shaped
 * lab (app_runtime_prod, NOBYPASSRLS), with migration 20261105090000_accountant_link_events applied.
 *
 *   1. The index of a delivered package: whose, which month, until when (14 days from the approval), every
 *      source and issued file with its sha256 and size and its row of the SEALED workbook, and the rows whose
 *      file is missing. No storage key, no signed URL, no path to storage in the answer. LINK_VIEWED recorded.
 *   2. One file: downloaded byte for byte (sha256 of the original stored document), inline for view /
 *      attachment for download, recorded as LINK_FILE_DOWNLOADED with kind, mode, document id and sha16.
 *   3. Nothing else in the ZIP is reachable: _meta, the reports, traversal, storage keys → 404.
 *   4. The Excel report (the ZIP's own workbook, byte for byte) and the PDF report; Excel cannot be "viewed".
 *   5. The ZIP still comes from the existing route, counted there only; the portal never counts a ZIP download.
 *   6. The sealed package, not live data: after the records change and an original is deleted from storage,
 *      the portal shows and serves exactly what was delivered.
 *   7. Refusals: no / forged / malformed secret, another business's link, a business without the feature →
 *      the same 404; an expired link → 410 LINK_EXPIRED; a revoked one → 410 LINK_REVOKED — both recorded.
 *   8. Integrity: a stored ZIP that no longer hashes to the sealed sha256 → 409, nothing served or recorded.
 *   9. Rate limit: one address is cut off on the file bucket (fail-closed rules, in-memory in the lab).
 *  10. Nothing else changes: the package row, the month's status, the emails sent.
 *
 * env: OWNER_URL, DATABASE_URL, DIRECT_URL (runtime). Synthetic only. ZERO network (the email provider is fake).
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Production runs in UTC; the workbook's date cells follow the process time zone (a known, separate issue).
process.env.TZ = "UTC";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-portal-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
process.env.RATE_LIMIT_BACKEND = "memory";

import JSZip from "jszip";
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
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");

type Json = Record<string, unknown>;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { getStorageService } = await import("@/lib/storage");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const { writeAtomic } = await import("@/lib/services/billing/pdf/billing-pdf-storage");
  const prep = await import("@/lib/accountant/prepare.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const del = await import("@/lib/accountant/delivery.service");
  const portal = await import("@/lib/accountant/portal");
  const portalRoute = await import("@/app/api/accountant/link/portal/route");
  const fileRoute = await import("@/app/api/accountant/link/file/route");
  const openRoute = await import("@/app/api/accountant/link/open/route");
  const storage = getStorageService();
  const KEY = "2026-09";

  for (const t of ["FinancialRecord", "Document", "BillingDocument", "BillingAuthoritySubmission", "Notification", "NotificationDelivery", "BusinessProfile", "BusinessFeatureAccess"]) {
    const on = (await owner.$queryRawUnsafe(`SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, t)) as { f: boolean }[];
    if (on[0]?.f) continue;
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await owner.$executeRawUnsafe(`CREATE POLICY acct_lab_tenant ON "${t}" FOR ALL
      USING ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)
      WITH CHECK ("businessId" = NULLIF(current_setting('app.current_business_id', true), '')::int)`);
  }

  // ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
  const one = async (sql: string, ...a: unknown[]) => Number(((await owner.$queryRawUnsafe(sql, ...a)) as { id: number }[])[0].id);
  const originals = new Map<string, Buffer>(); // `${biz}:${docId}` → the bytes the business uploaded
  let n = 0;
  const doc = async (b: number, body: Buffer, ext: string, mime: string, hashed: boolean) => {
    const basename = `doc-${Date.now()}${++n}-portal.${ext}`;
    await putDocumentObject({ businessId: b, basename, body, contentType: mime, source: "file" });
    const id = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt", "contentHashSha256") VALUES ($1, $2, 'file', $3, 'approved', '2026-09-10T08:00:00'::timestamp, $4) RETURNING "id"`,
      b, basename, mime, hashed ? sha(body) : null);
    originals.set(`${b}:${id}`, body);
    return { id, basename };
  };
  const record = (b: number, d: number, amount: number, day: string, vendor: string) =>
    owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, $3, $4::timestamp, $5, 'expense', 'general')`, d, b, amount, `2026-09-${day}T00:00:00`, vendor);

  const business = async (name: string) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}-${b}@portal.lab`, b);
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingTaxId", "updatedAt") VALUES ($1, $2, '515151515', now()) ON CONFLICT DO NOTHING`, b, `${name} בע"מ`);
    return { b, u };
  };

  const sent: { to: string; text: string }[] = [];
  const fake = {
    provider: () => ({
      name: "resend",
      async send(m: { to: string; subject: string; html: string; text: string; idempotencyKey: string }) {
        sent.push({ to: m.to, text: m.text });
        return { outcome: "sent" as const, providerMessageId: `msg_portal_${sent.length}` };
      },
    }),
  };
  /** Prepare September, approve (acknowledging open items) and send through the fake provider → the link. */
  const deliver = async (x: { b: number; u: number }, clock: Date) => {
    const inX = <T>(fn: () => Promise<T>) => runWithTenantContext({ businessId: x.b }, fn);
    await inX(() => prep.preparePeriod({ businessId: x.b, periodKey: KEY, trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, { ...prep.defaultPrepareDeps, now: () => clock }));
    await inX(() => setRecipient({ businessId: x.b, userId: x.u, name: "רו\"ח דנה", email: "dana@example.com", expectedVersion: null, confirm: true, now: clock }));
    const pkg = await owner.accountantPackage.findFirstOrThrow({ where: { businessId: x.b, status: "READY" } });
    const a = await inX(() => del.approveDelivery({
      businessId: x.b, userId: x.u, periodKey: KEY, packageId: pkg.id, packageSha256: pkg.sha256!, recipientVersion: 1,
      recipientEmail: "dana@example.com", acknowledgeIncomplete: true, idempotencyKey: `send:portal-${x.b}-${Date.now()}`, now: clock,
    }));
    await inX(() => del.attemptDelivery(x.b, a.deliveryId, clock, fake));
    const m = /https:\/\/app\.example\.com\/a\/([A-Za-z0-9_-]{32})#t=([A-Za-z0-9_-]{43})/.exec(sent[sent.length - 1].text)!;
    return { deliveryId: a.deliveryId, publicId: m[1], token: m[2], pkg };
  };

  const now = new Date();
  // A: a PDF without a recorded hash, a PNG with one, an original that will be missing, an issued receipt.
  const A = await business("מאפיית הלב");
  const a1 = await doc(A.b, Buffer.from("%PDF-1.4 portal source one"), "pdf", "application/pdf", false);
  await record(A.b, a1.id, 250.5, "04", "חברת החשמל");
  const a2 = await doc(A.b, PNG, "png", "image/png", true);
  await record(A.b, a2.id, 99.9, "12", "Office Depot ישראל");
  const a3 = await doc(A.b, Buffer.from("%PDF-gone"), "pdf", "application/pdf", true);
  await record(A.b, a3.id, 10, "20", "ספק שהקובץ שלו חסר");
  const root = process.env.LOCAL_STORAGE_ROOT!;
  const { unlinkSync, readdirSync } = await import("node:fs");
  const findFile = (dir: string, name: string): string | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
      else if (e.name === name) return p;
    }
    return null;
  };
  unlinkSync(findFile(root, a3.basename)!);
  const receipt = Buffer.from("%PDF-1.4 issued receipt portal");
  const rcpt = await one(`INSERT INTO "BillingDocument" ("businessId", "documentType", "status", "documentNumber", "documentNumberFormatted", "issuedAt", "subtotalAmount", "vatAmount", "totalAmount", "customerNameSnapshot", "pdfRenderStatus", "updatedAt")
    VALUES ($1, 'RECEIPT', 'ISSUED', 1, 'R-0001', '2026-09-12T09:00:00', 1180, 0, 1180, 'לקוח', 'RENDERED', now()) RETURNING "id"`, A.b);
  const rKey = `biz/${A.b}/billing/${rcpt}/${sha(receipt)}.pdf`;
  await writeAtomic(rKey, receipt);
  await owner.$executeRawUnsafe(`UPDATE "BillingDocument" SET "pdfStorageKey" = $1, "pdfHash" = $2 WHERE "id" = $3`, rKey, sha(receipt), rcpt);
  const LA = await deliver(A, now);

  const B = await business("acct-portal-B");
  const b1 = await doc(B.b, Buffer.from("%PDF-1.4 business B only"), "pdf", "application/pdf", true);
  await record(B.b, b1.id, 5, "05", "ספק של ב");
  const LB = await deliver(B, now);

  // F: untouched until the integrity checks.
  const F = await business("acct-portal-F");
  const f1 = await doc(F.b, Buffer.from("%PDF-1.4 F integrity"), "pdf", "application/pdf", true);
  await record(F.b, f1.id, 6, "06", "ספק של ו");
  const LF = await deliver(F, now);

  // E: approved 20 days ago → its link has expired.
  const E = await business("acct-portal-E");
  const e1 = await doc(E.b, Buffer.from("%PDF-1.4 E"), "pdf", "application/pdf", true);
  await record(E.b, e1.id, 7, "07", "ספק של ה");
  const LE = await deliver(E, new Date(now.getTime() - 20 * 86400_000));

  // D: delivered, then the feature is switched off for it.
  const D = await business("acct-portal-D");
  const d1 = await doc(D.b, Buffer.from("%PDF-1.4 D"), "pdf", "application/pdf", true);
  await record(D.b, d1.id, 8, "08", "ספק של ד");
  const LD = await deliver(D, now);
  await owner.$executeRawUnsafe(`UPDATE "BusinessFeatureAccess" SET "state" = 'DISABLED' WHERE "businessId" = $1 AND "featureKey" = 'accountant_month_close'`, D.b);

  let ipSeq = 0;
  const post = async (route: { POST: (r: Request) => Promise<Response> }, url: string, body: Json, ip?: string) =>
    route.POST(new Request(`https://app.example.com${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip ?? `198.51.100.${(++ipSeq % 200) + 1}` },
      body: JSON.stringify(body),
    }));
  const index = (l: { publicId: string; token: string }) => post(portalRoute, "/api/accountant/link/portal", { publicId: l.publicId, token: l.token });
  const file = (l: { publicId: string; token: string }, extra: Json) => post(fileRoute, "/api/accountant/link/file", { publicId: l.publicId, token: l.token, ...extra });
  const events = async (deliveryId: number, type: string) =>
    (await owner.$queryRawUnsafe(`SELECT payload FROM "AccountantWorkflowEvent" WHERE "deliveryId" = $1 AND "eventType" = $2 ORDER BY id`, deliveryId, type)) as { payload: Json }[];
  const pkgRowA = async () => owner.accountantPackage.findUniqueOrThrow({ where: { id: LA.pkg.id } });
  const before = { pkg: await pkgRowA(), period: await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: A.b, periodKey: KEY } }), sent: sent.length };

  // ── 1. The index ───────────────────────────────────────────────────────────────────────────────
  console.log("1. the index of the delivered package");
  let r = await index(LA);
  const ix = (await r.json()) as Json & { files: (Json & { path: string; sha256: string; size: number })[]; missing: Json[]; counts: Json };
  ok("1a 200", r.status === 200, `${r.status} ${JSON.stringify(ix).slice(0, 200)}`);
  ok("1b whose and which month", ix.businessName === "מאפיית הלב בע\"מ" && ix.periodKey === KEY && typeof ix.periodLabel === "string" && String(ix.periodLabel).includes("ספטמבר"), `${ix.businessName} ${ix.periodLabel}`);
  const dA = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: LA.deliveryId } });
  ok("1c valid for exactly 14 days from the approval", dA.linkExpiresAt.getTime() - dA.approvedAt.getTime() === 14 * 86400_000 && ix.expiresAt === dA.linkExpiresAt.toISOString());
  const paths = ix.files.map((f) => f.path).sort();
  ok("1d the files: both present originals and the issued receipt", JSON.stringify(paths) === JSON.stringify([`approved/doc-${a1.id}.pdf`, `approved/doc-${a2.id}.png`, "issued/receipt-R-0001.pdf"].sort()), paths.join(","));
  const fOf = (p: string) => ix.files.find((f) => f.path === p)!;
  ok("1e each file's sha256 and size are the uploaded bytes'",
    fOf(`approved/doc-${a1.id}.pdf`).sha256 === sha(originals.get(`${A.b}:${a1.id}`)!) && fOf(`approved/doc-${a2.id}.png`).sha256 === sha(PNG) &&
    fOf("issued/receipt-R-0001.pdf").sha256 === sha(receipt) && fOf(`approved/doc-${a2.id}.png`).size === PNG.length);
  ok("1f details from the sealed workbook (date, party, amount)",
    fOf(`approved/doc-${a1.id}.pdf`).date === "04/09/2026" && fOf(`approved/doc-${a1.id}.pdf`).party === "חברת החשמל" && fOf(`approved/doc-${a1.id}.pdf`).amount === "250.50",
    JSON.stringify(fOf(`approved/doc-${a1.id}.pdf`)));
  ok("1g verified: the PNG (hash recorded) yes, the PDF (no hash) no; issued yes",
    fOf(`approved/doc-${a2.id}.png`).verified === true && fOf(`approved/doc-${a1.id}.pdf`).verified === false && fOf("issued/receipt-R-0001.pdf").verified === true);
  ok("1h the missing original is listed, with the workbook's reason", ix.missing.length === 1 && ix.missing[0].party === "ספק שהקובץ שלו חסר" && String(ix.missing[0].reason).includes("חסר"), JSON.stringify(ix.missing));
  const raw = JSON.stringify(ix);
  ok("1i no storage key, storage path or URL in the answer", !raw.includes("biz/") && !raw.includes("exports/") && !/https?:\/\//.test(raw) && !raw.includes(a1.basename));
  ok("1j LINK_VIEWED recorded once (package version, file count)", (await events(LA.deliveryId, "LINK_VIEWED")).length === 1 && (await events(LA.deliveryId, "LINK_VIEWED"))[0].payload.files === 3);
  ok("1k answers are not cached by the browser or indexed", (r.headers.get("cache-control") ?? "").includes("no-store") && r.headers.get("x-robots-tag") === "noindex, nofollow");
  const ixHead = await storage.headObject(portal.portalIndexCacheKey({ businessId: A.b, periodKey: KEY, version: LA.pkg.version, storageKey: LA.pkg.storageKey!, sha256: LA.pkg.sha256! }));
  ok("1l the index is cached privately, bound to the package sha256", ixHead.exists && ixHead.metadata?.visibility === "private" && ixHead.metadata?.businessId === A.b && ixHead.metadata?.custom?.sourceSha256 === LA.pkg.sha256);

  // ── 2. One file ────────────────────────────────────────────────────────────────────────────────
  console.log("2. one file, byte for byte");
  for (const [p, orig, kind] of [[`approved/doc-${a1.id}.pdf`, originals.get(`${A.b}:${a1.id}`)!, "source"], [`approved/doc-${a2.id}.png`, PNG, "source"], ["issued/receipt-R-0001.pdf", receipt, "issued"]] as const) {
    r = await file(LA, { file: p, mode: "download" });
    const body = Buffer.from(await r.arrayBuffer());
    ok(`2a ${p}: downloaded byte for byte`, r.status === 200 && sha(body) === sha(orig), `${r.status} ${body.subarray(0, 60).toString()}`);
    ok(`2b ${p}: as an attachment, named by month and file`, (r.headers.get("content-disposition") ?? "").startsWith("attachment;") && (r.headers.get("content-disposition") ?? "").includes(`${KEY}-`));
    ok(`2c ${p}: nosniff, no-store`, r.headers.get("x-content-type-options") === "nosniff" && (r.headers.get("cache-control") ?? "").includes("no-store"));
    void kind;
  }
  r = await file(LA, { file: `approved/doc-${a1.id}.pdf`, mode: "view" });
  ok("2d view opens a PDF inline, as application/pdf", r.status === 200 && (r.headers.get("content-disposition") ?? "").startsWith("inline;") && r.headers.get("content-type") === "application/pdf");
  await r.arrayBuffer();
  r = await file(LA, { file: `approved/doc-${a2.id}.png`, mode: "view" });
  ok("2e view opens an image inline, as image/png", r.status === 200 && r.headers.get("content-type") === "image/png");
  await r.arrayBuffer();
  const fe = await events(LA.deliveryId, "LINK_FILE_DOWNLOADED");
  ok("2f every file access recorded: kind, mode, document id, sha16", fe.length === 5 &&
    fe.some((e) => e.payload.kind === "source" && e.payload.mode === "download" && e.payload.documentId === a1.id && e.payload.sha16 === sha(originals.get(`${A.b}:${a1.id}`)!).slice(0, 16)) &&
    fe.some((e) => e.payload.kind === "issued" && e.payload.documentId === undefined) && fe.filter((e) => e.payload.mode === "view").length === 2, JSON.stringify(fe.map((e) => e.payload)));
  const fileKey = portal.portalFileCacheKey({ businessId: A.b, periodKey: KEY, version: LA.pkg.version, storageKey: LA.pkg.storageKey!, sha256: LA.pkg.sha256! }, { path: `approved/doc-${a2.id}.png`, sha256: sha(PNG) });
  const fh = await storage.headObject(fileKey);
  ok("2g the extracted file is cached privately, bound to the package AND the file's sha256", fh.exists && fh.metadata?.visibility === "private" && fh.metadata?.custom?.sha256 === sha(PNG) && fh.metadata?.custom?.sourceSha256 === LA.pkg.sha256 && fileKey.startsWith(`biz/${A.b}/exports/accountant/`));

  // ── 3. Nothing else is reachable ───────────────────────────────────────────────────────────────
  console.log("3. nothing else in the package or storage is reachable");
  for (const bad of ["_meta/manifest.json", "_meta/missing-files.txt", `דוח_${KEY}.xlsx`, "סיכום.txt", `approved/../_meta/manifest.json`, `approved/doc-${a3.id}.pdf`, LA.pkg.storageKey!, rKey, `approved/doc-${b1.id}.pdf`, "", null]) {
    r = await file(LA, { file: bad, mode: "download" });
    const j = (await r.json()) as Json;
    ok(`3 ${String(bad).slice(0, 48) || "(empty)"} → 404 FILE_NOT_FOUND`, r.status === 404 && j.error === "FILE_NOT_FOUND", `${r.status} ${JSON.stringify(j)}`);
  }
  r = await file(LA, { file: `approved/doc-${a1.id}.pdf`, mode: "edit" });
  ok("3x only view / download exist (no edit, no delete)", r.status === 400);
  ok("3y no access was recorded for any of them", (await events(LA.deliveryId, "LINK_FILE_DOWNLOADED")).length === 5);

  // ── 4. Reports ─────────────────────────────────────────────────────────────────────────────────
  console.log("4. the Excel and PDF reports");
  r = await file(LA, { report: "xlsx", mode: "download" });
  const xlsx = Buffer.from(await r.arrayBuffer());
  const zipA = await JSZip.loadAsync((await storage.getObject(LA.pkg.storageKey!)).body);
  const inZip = await zipA.file(`דוח_${KEY}.xlsx`)!.async("nodebuffer");
  ok("4a the Excel report is the ZIP's own workbook, byte for byte", r.status === 200 && sha(xlsx) === sha(inZip));
  r = await file(LA, { report: "xlsx", mode: "view" });
  ok("4b the Excel report cannot be 'viewed' (400 NOT_VIEWABLE)", r.status === 400 && ((await r.json()) as Json).error === "NOT_VIEWABLE");
  r = await file(LA, { report: "pdf", mode: "view" });
  const pdf = Buffer.from(await r.arrayBuffer());
  ok("4c the PDF report: a real PDF, inline", r.status === 200 && pdf.subarray(0, 5).toString("latin1") === "%PDF-" && (await PDFDocument.load(pdf)).getPageCount() >= 1 && (r.headers.get("content-disposition") ?? "").startsWith("inline;"), String(r.status));
  r = await file(LA, { report: "csv", mode: "download" });
  ok("4d an unknown report → 400", r.status === 400);
  const re = (await events(LA.deliveryId, "LINK_FILE_DOWNLOADED")).filter((e) => String(e.payload.kind).startsWith("report_"));
  ok("4e the report downloads are recorded with their kind", re.length === 2 && re.some((e) => e.payload.kind === "report_xlsx") && re.some((e) => e.payload.kind === "report_pdf" && e.payload.mode === "view"));

  // ── 5. The ZIP ─────────────────────────────────────────────────────────────────────────────────
  console.log("5. the ZIP, from the existing route");
  ok("5a the portal never counted a ZIP download", (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: LA.deliveryId } })).downloadCount === 0);
  r = await post(openRoute, "/api/accountant/link/open", { publicId: LA.publicId, token: LA.token, mode: "download" });
  const zipBody = Buffer.from(await r.arrayBuffer());
  ok("5b the ZIP is the sealed package, byte for byte", r.status === 200 && sha(zipBody) === LA.pkg.sha256);
  ok("5c counted once, LINK_DOWNLOADED", (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: LA.deliveryId } })).downloadCount === 1 && (await events(LA.deliveryId, "LINK_DOWNLOADED")).length === 1);

  // ── 6. The sealed package, not live data ───────────────────────────────────────────────────────
  console.log("6. what was delivered, not what is live now");
  await owner.$executeRawUnsafe(`UPDATE "FinancialRecord" SET "amount" = 999999, "vendorName" = 'שונה אחרי המשלוח' WHERE "documentId" = $1`, a1.id);
  unlinkSync(findFile(root, a1.basename)!);
  r = await index(LA);
  const ix2 = (await r.json()) as typeof ix;
  const f2 = ix2.files.find((f) => f.path === `approved/doc-${a1.id}.pdf`);
  ok("6a the index still shows the delivered values", r.status === 200 && f2?.party === "חברת החשמל" && f2?.amount === "250.50", JSON.stringify(f2));
  r = await file(LA, { file: `approved/doc-${a1.id}.pdf`, mode: "download" });
  ok("6b the original still downloads byte for byte (from the sealed package)", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(originals.get(`${A.b}:${a1.id}`)!));

  // ── 7. Refusals ────────────────────────────────────────────────────────────────────────────────
  console.log("7. refusals");
  const code = async (res: Response) => ({ s: res.status, e: ((await res.json().catch(() => ({}))) as Json).error });
  let c = await code(await post(portalRoute, "/api/accountant/link/portal", { publicId: LA.publicId }));
  ok("7a no secret → 404 LINK_NOT_FOUND", c.s === 404 && c.e === "LINK_NOT_FOUND");
  c = await code(await post(portalRoute, "/api/accountant/link/portal", { publicId: LA.publicId, token: "A".repeat(43) }));
  ok("7b a forged secret → 404 LINK_NOT_FOUND", c.s === 404 && c.e === "LINK_NOT_FOUND");
  c = await code(await post(fileRoute, "/api/accountant/link/file", { publicId: LA.publicId, token: "short", file: `approved/doc-${a1.id}.pdf`, mode: "download" }));
  ok("7c a malformed secret → 404 LINK_NOT_FOUND", c.s === 404 && c.e === "LINK_NOT_FOUND");
  c = await code(await post(portalRoute, "/api/accountant/link/portal", { publicId: LB.publicId, token: LA.token }));
  ok("7d A's secret on B's link → 404", c.s === 404 && c.e === "LINK_NOT_FOUND");
  c = await code(await file(LB, { file: `approved/doc-${a1.id}.pdf`, mode: "download" }));
  ok("7e B's link cannot name A's file → 404", c.s === 404 && c.e === "FILE_NOT_FOUND");
  c = await code(await index(LD));
  ok("7f a business without the feature → the same 404", c.s === 404 && c.e === "LINK_NOT_FOUND");
  c = await code(await index(LE));
  ok("7g an expired link (approved 20 days ago) → 410 LINK_EXPIRED", c.s === 410 && c.e === "LINK_EXPIRED");
  c = await code(await file(LE, { file: `approved/doc-${e1.id}.pdf`, mode: "download" }));
  ok("7h …and its files → 410 LINK_EXPIRED", c.s === 410 && c.e === "LINK_EXPIRED");
  ok("7i the expired attempts are recorded as refusals", (await events(LE.deliveryId, "LINK_REFUSED")).filter((e) => e.payload.reason === "expired").length === 2);
  await runWithTenantContext({ businessId: A.b }, () => del.revokeLink(A.b, A.u, LA.deliveryId, new Date()));
  c = await code(await index(LA));
  ok("7j after the owner revokes: the portal → 410 LINK_REVOKED", c.s === 410 && c.e === "LINK_REVOKED");
  c = await code(await file(LA, { file: `approved/doc-${a2.id}.png`, mode: "download" }));
  ok("7k …a file (even a cached one) → 410 LINK_REVOKED", c.s === 410 && c.e === "LINK_REVOKED");
  c = await code(await file(LA, { report: "xlsx", mode: "download" }));
  ok("7l …a report → 410 LINK_REVOKED", c.s === 410 && c.e === "LINK_REVOKED");
  c = await code(await post(openRoute, "/api/accountant/link/open", { publicId: LA.publicId, token: LA.token, mode: "download" }));
  ok("7m …the ZIP → 410 LINK_REVOKED", c.s === 410 && c.e === "LINK_REVOKED");
  ok("7n the revoked attempts are recorded as refusals", (await events(LA.deliveryId, "LINK_REFUSED")).filter((e) => e.payload.reason === "revoked").length === 4);

  // ── 8. Integrity ───────────────────────────────────────────────────────────────────────────────
  console.log("8. integrity");
  const zipF = await storage.getObject(LF.pkg.storageKey!);
  const tamper = () => storage.putObject({ key: LF.pkg.storageKey!, body: Buffer.concat([zipF.body, Buffer.from("tampered")]), contentType: "application/zip", metadata: { businessId: F.b, domain: "exports", visibility: "private" } });
  const restore = () => storage.putObject({ key: LF.pkg.storageKey!, body: zipF.body, contentType: "application/zip", metadata: { businessId: F.b, domain: "exports", visibility: "private" } });
  await tamper();
  c = await code(await index(LF));
  ok("8a a ZIP that no longer hashes to the sealed sha256 → 409 PACKAGE_INTEGRITY", c.s === 409 && c.e === "PACKAGE_INTEGRITY", JSON.stringify(c));
  ok("8b nothing recorded as viewed, nothing cached", (await events(LF.deliveryId, "LINK_VIEWED")).length === 0 &&
    !(await storage.headObject(portal.portalIndexCacheKey({ businessId: F.b, periodKey: KEY, version: LF.pkg.version, storageKey: LF.pkg.storageKey!, sha256: LF.pkg.sha256! }))).exists);
  await restore();
  r = await index(LF);
  ok("8c restored: the index builds (and is cached)", r.status === 200);
  await r.arrayBuffer();
  // The cached index was built from the verified ZIP; a file not extracted yet is still read from the ZIP —
  // and refused if the ZIP no longer matches.
  await tamper();
  c = await code(await file(LF, { file: `approved/doc-${f1.id}.pdf`, mode: "download" }));
  ok("8d a file extracted after the ZIP stopped matching → 409 PACKAGE_INTEGRITY", c.s === 409 && c.e === "PACKAGE_INTEGRITY", JSON.stringify(c));
  ok("8e …nothing recorded as downloaded", (await events(LF.deliveryId, "LINK_FILE_DOWNLOADED")).length === 0);
  await restore();
  r = await file(LF, { file: `approved/doc-${f1.id}.pdf`, mode: "download" });
  ok("8f restored: the file downloads byte for byte", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(originals.get(`${F.b}:${f1.id}`)!));
  r = await file(LB, { file: `approved/doc-${b1.id}.pdf`, mode: "download" });
  ok("8g B's own file downloads on B's link", r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(originals.get(`${B.b}:${b1.id}`)!));

  // ── 9. Rate limit ──────────────────────────────────────────────────────────────────────────────
  console.log("9. rate limit");
  let limited = 0;
  for (let i = 0; i < 95; i++) {
    const res = await post(fileRoute, "/api/accountant/link/file", { publicId: "x", token: "y" }, "203.0.113.77");
    if (res.status === 429) limited++;
  }
  ok("9a one address is cut off after 90 file requests a minute", limited === 5, String(limited));
  r = await post(fileRoute, "/api/accountant/link/file", { publicId: "x", token: "y" }, "203.0.113.78");
  ok("9b another address is not", r.status === 404);

  // ── 10. Nothing else changed ───────────────────────────────────────────────────────────────────
  console.log("10. nothing else changed");
  const after = await pkgRowA();
  ok("10a the package row is unchanged (status, version, sha256, key, size)",
    after.status === before.pkg.status && after.version === before.pkg.version && after.sha256 === before.pkg.sha256 && after.storageKey === before.pkg.storageKey && after.sizeBytes === before.pkg.sizeBytes);
  const pAfter = await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: A.b, periodKey: KEY } });
  ok("10b the month's status is unchanged", pAfter.status === before.period.status);
  ok("10c no email was sent by the portal", sent.length === before.sent);
  ok("10d no network", networkCalls === 0);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
