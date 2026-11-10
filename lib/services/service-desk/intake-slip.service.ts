/**
 * Service Desk — the intake slip PDF. A CONFIRMED intake (the owner's CHECK_IN, owner decision 2026-11-11: no customer
 * signature) gets ONE stored slip: rendered through the shared Chromium launcher (lib/pdf/chromium) from
 * intake-slip-html, stored content-addressed in the private `service` domain (create-once), its key set on the intake
 * row once, and one RECORD_INTAKE event (SLIP_STORED: the PDF hash and the intake digest).
 *
 * Kept apart from intake.service so only the slip route carries the browser bundle (next.config.ts
 * outputFileTracingIncludes + scripts/ci/pdf-route-tracing-guard.mjs). Rendering and upload run BEFORE the command
 * transaction (no case lock held while Chromium works or bytes travel); the command re-checks under the lock.
 */
import { createHash } from "node:crypto";

import { launchChromium } from "@/lib/pdf/chromium";
import { hebrewFontVfs } from "@/lib/pdf/hebrew-font-vfs";
import { getStorageService, type StorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { buildIntakeSlipHtml, type IntakeSlipInput } from "./intake-slip-html";
import { ensureStoredUnderLock, intakeDigest } from "./intake.service";
import { appendRecord, isNonNegativeInt, isPositiveInt, prepare, recordCommand, type CommandResult, type ServiceDeskPrincipal, type Tx, type WriteRequest } from "./service-case.service";
import { ServiceDeskError } from "./service-desk-errors";
import { SERVICE_STORAGE_DOMAIN, intakeSlipKey, isServiceKeyOfBusiness, serviceBusinessPrefix } from "./storage/service-storage-keys";

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refused = (violations: string[]) => new ServiceDeskError("REFUSED", { violations });
const isPdf = (b: Uint8Array) => b.length > 5 && Buffer.from(b.subarray(0, 5)).toString("latin1") === "%PDF-";

export const fontDataUri = () => `data:font/ttf;base64,${hebrewFontVfs["NotoSansHebrew-Regular.ttf"]}`;

/** "dd.mm.yyyy, hh:mm" in Israel time — the slip shows the confirmation time as the business lived it. */
export function israelTime(d: Date): string {
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

type SlipState = { confirmed: boolean; hasSlip: boolean };

/** The intake is confirmed once the owner's CHECK_IN event exists (owner decision 2026-11-11 — no customer signature). */
async function slipState(tx: Tx, b: number, caseId: number): Promise<SlipState | null> {
  const r = (await tx.$queryRaw<{ slip: boolean; confirmed: boolean }[]>`
    SELECT i."slipPdfKey" IS NOT NULL AS slip,
           EXISTS (SELECT 1 FROM "ServiceCaseEvent" e WHERE e."businessId" = i."businessId" AND e."caseId" = i."caseId" AND e.action::text = 'CHECK_IN') AS confirmed
      FROM "ServiceCaseIntake" i WHERE i."businessId" = ${b}::int AND i."caseId" = ${caseId}::int`)[0];
  return r ? { confirmed: r.confirmed, hasSlip: r.slip } : null;
}

const slipViolations = (s: SlipState | null): string[] => (!s || !s.confirmed ? ["INTAKE_NOT_CONFIRMED"] : s.hasSlip ? ["SLIP_EXISTS"] : []);

/** Everything the slip shows, read in one tenant transaction: the documented intake and who confirmed it, when. */
export async function loadSlipInput(businessId: number, caseId: number): Promise<IntakeSlipInput> {
  const data = await tenantTx(businessId, async (tx) => {
    const c = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT c."caseNumber", c."problemDescription", cu.name AS "customerName", bz.name AS "businessName",
             d.category, d.brand, d.model, d."serialNumber"
        FROM "ServiceCase" c
        JOIN "Business" bz ON bz.id = c."businessId"
        LEFT JOIN "Customer" cu ON cu.id = c."customerId" AND cu."businessId" = c."businessId"
        LEFT JOIN "ServiceDevice" d ON d.id = c."deviceId" AND d."businessId" = c."businessId"
       WHERE c.id = ${caseId}::int AND c."businessId" = ${businessId}::int`)[0];
    if (!c) throw new ServiceDeskError("NOT_FOUND");
    const i = (await tx.$queryRaw<{ cn: string | null; an: string | null; cr: boolean; ar: boolean }[]>`
      SELECT "conditionNote" AS cn, "accessoriesNote" AS an, "conditionRecorded" AS cr, "accessoriesRecorded" AS ar FROM "ServiceCaseIntake"
       WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int`)[0];
    const conf = (await tx.$queryRaw<{ at: Date; name: string | null }[]>`
      SELECT e."occurredAt" AS at, COALESCE(NULLIF(btrim(u.name), ''), u.email) AS name
        FROM "ServiceCaseEvent" e LEFT JOIN "User" u ON u.id = e."actorUserId"
       WHERE e."businessId" = ${businessId}::int AND e."caseId" = ${caseId}::int AND e.action::text = 'CHECK_IN' ORDER BY e.seq DESC LIMIT 1`)[0];
    if (!i || !conf) throw refused(["INTAKE_NOT_CONFIRMED"]);
    const photos = await tx.$queryRaw<{ sha256: string }[]>`
      SELECT sha256 FROM "ServiceIntakePhoto" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND "erasedAt" IS NULL ORDER BY id`;
    return { c, i, conf, photos };
  });
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const photoShas = data.photos.map((p) => String(p.sha256).trim());
  return {
    business: { name: String(data.c.businessName ?? "") },
    caseNumber: Number(data.c.caseNumber),
    customerName: str(data.c.customerName),
    item: { category: str(data.c.category), brand: str(data.c.brand), model: str(data.c.model), serialNumber: str(data.c.serialNumber), problemDescription: str(data.c.problemDescription) },
    intake: { conditionNote: data.i.cn, accessoriesNote: data.i.an },
    photos: photoShas.map((sha256) => ({ sha256 })),
    confirmation: { byName: data.conf.name ?? null, atText: israelTime(new Date(data.conf.at)) },
    evidence: { intakeSha256: intakeDigest({ conditionNote: data.i.cn, accessoriesNote: data.i.an, conditionRecorded: data.i.cr, accessoriesRecorded: data.i.ar, photoShas }) },
    fontDataUri: fontDataUri(),
  };
}

/** A complete, self-contained slip HTML document → A4 PDF bytes (the shared Chromium launcher). */
export async function renderIntakeSlipPdf(html: string): Promise<Buffer> {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" } }));
  } finally {
    await browser.close();
  }
}

/** Render, store and record the slip of a signed intake — once. */
export async function createIntakeSlip(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { expectedVersion?: unknown },
  req: WriteRequest,
  deps: { storage?: StorageService; render?: (html: string) => Promise<Buffer> } = {},
): Promise<CommandResult & { slip?: { sha256: string } }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const storage = deps.storage ?? getStorageService();
  const render = deps.render ?? renderIntakeSlipPdf;
  const prepared = prepare(p, req, "service-desk/cases:intake-slip", { caseId, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  // Preflight, outside the command: a replayed key needs no render; a refused request renders and stores nothing.
  const replay = await tenantTx(b, async (tx) => {
    const prior = (await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "ServiceCaseEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${prepared.key}) AS ok`)[0]?.ok === true;
    if (prior) return true;
    const exists = (await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int) AS ok`)[0]?.ok;
    if (!exists) throw new ServiceDeskError("NOT_FOUND");
    const v = slipViolations(await slipState(tx, b, caseId));
    if (v.length > 0) throw refused(v);
    return false;
  });
  let key: string | null = null;
  let sha256: string | null = null;
  let intakeSha256: string | null = null;
  let pdfBytes: Buffer | null = null;
  if (!replay) {
    const input = await loadSlipInput(b, caseId);
    intakeSha256 = input.evidence.intakeSha256;
    const pdf = await render(buildIntakeSlipHtml(input));
    if (!isPdf(pdf)) throw new ServiceDeskError("REFUSED", { violations: ["SLIP_RENDER_FAILED"] });
    sha256 = sha256Hex(pdf);
    pdfBytes = pdf;
    key = intakeSlipKey({ businessId: b, caseId, sha256 });
    await storage.putObjectIfAbsent({ key, body: pdf, contentType: "application/pdf", metadata: { businessId: b, domain: SERVICE_STORAGE_DOMAIN, visibility: "private" } });
  }
  const r = await recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const v = slipViolations(await slipState(tx, b, caseId));
    if (v.length > 0 || !key || !sha256 || !pdfBytes) throw refused(v.length > 0 ? v : ["SLIP_RENDER_FAILED"]);
    await ensureStoredUnderLock(storage, b, key, pdfBytes, "application/pdf");
    // Set once: slipPdfKey NULL → key (updatedAt untouched; a legacy signed intake allows exactly this change).
    const n = await tx.$executeRaw`
      UPDATE "ServiceCaseIntake" SET "slipPdfKey" = ${key}
       WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND "slipPdfKey" IS NULL`;
    if (n !== 1) throw refused(["SLIP_EXISTS"]);
    await appendRecord(tx, b, caseId, locked.context, "RECORD_INTAKE", { step: "SLIP_STORED", slipSha256: sha256, ...(intakeSha256 ? { intakeSha256 } : {}) }, p.userId, prepared);
  });
  return { ...r, ...(sha256 ? { slip: { sha256 } } : {}) };
}

/** The stored slip's bytes, only through this case's own intake row (never a key from the request). */
export async function readIntakeSlip(businessId: number, caseId: unknown, storage: StorageService = getStorageService()): Promise<{ bytes: Buffer; caseNumber: number }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const row = await tenantTx(businessId, async (tx) => (await tx.$queryRaw<{ key: string | null; n: number }[]>`
    SELECT i."slipPdfKey" AS key, c."caseNumber" AS n FROM "ServiceCaseIntake" i
      JOIN "ServiceCase" c ON c.id = i."caseId" AND c."businessId" = i."businessId"
     WHERE i."businessId" = ${businessId}::int AND i."caseId" = ${caseId}::int AND i."erasedAt" IS NULL`)[0] ?? null);
  const folder = `${serviceBusinessPrefix(businessId)}cases/${caseId}/intake/slip/`;
  if (!row || !row.key || !isServiceKeyOfBusiness(row.key, businessId) || !row.key.startsWith(folder)) throw new ServiceDeskError("NOT_FOUND");
  let bytes: Buffer;
  try {
    bytes = Buffer.from((await storage.getObject(row.key)).body);
  } catch {
    throw new ServiceDeskError("NOT_FOUND");
  }
  if (!isPdf(bytes) || sha256Hex(bytes) !== row.key.slice(folder.length).split(".")[0]) throw new ServiceDeskError("NOT_FOUND");
  return { bytes, caseNumber: Number(row.n) };
}
