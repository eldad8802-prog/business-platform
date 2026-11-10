/**
 * Service Desk 1.3b — the intake signature path (server). Decisions are pure (intake.core); this module reads the facts
 * under the case lock, writes, stores objects and journals — through the same command pipeline as every case record
 * (recordCommand: tenant transaction → case lock → P4 journal present → earlier answer by idempotency key → expected
 * version → work → one RECORD_INTAKE event that bumps the case version).
 *
 *   presentTerms   freeze the business's active terms + statutory notice for this case (once). The database accepts only
 *                  LEGALLY_APPROVED texts with their own hash (service_intake_terms_guard). Nothing here approves a text.
 *   addIntakePhoto one photo (JPEG / PNG / WebP by its bytes), content-addressed in the private `service` domain.
 *   signIntake     the customer's signature PNG, content-addressed; the intake row becomes signed — what CHECK_IN demands.
 *
 * Objects are written create-once (putObjectIfAbsent) INSIDE the command, after the decision and before the row, so a
 * refused request stores nothing. A transaction that fails after the upload leaves an object with no row under the
 * business's prefix; the account-erasure job lists and deletes the whole prefix (ServiceStorageErasure), and the key is
 * the content hash, so a retry reuses it (EXISTS = the same bytes are already there).
 *
 * Journal payloads are tokens, numbers and booleans only (ServiceCaseEvent_payload_closed) — never a text body.
 */
import { createHash } from "node:crypto";

import { getStorageService, type StorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { evaluateAddPhoto, evaluatePresentTerms, evaluateSign, sniffImage, type IntakeFacts, type IntakeViolation, type TextFact } from "./intake.core";
import {
  appendRecord,
  isPositiveInt,
  prepare,
  recordCommand,
  type CommandResult,
  type Locked,
  type ServiceDeskPrincipal,
  type Tx,
  type WriteRequest,
} from "./service-case.service";
import { ServiceDeskError } from "./service-desk-errors";
import { SERVICE_STORAGE_DOMAIN, intakePhotoKey, intakeSignatureKey, isServiceKeyOfBusiness } from "./storage/service-storage-keys";

/** Vercel caps a request body at 4.5 MB: the screen downsizes photos; the server refuses more than this. */
export const PHOTO_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refused = (violations: IntakeViolation[]) => new ServiceDeskError("REFUSED", { violations });

// ── Facts (read under the case lock) ────────────────────────────────────────────────────────────────────────

async function intakeFacts(tx: Tx, b: number, caseId: number, locked: Locked): Promise<IntakeFacts> {
  const intake = (await tx.$queryRaw<{ cr: boolean; ar: boolean; signed: boolean }[]>`
    SELECT "conditionRecorded" AS cr, "accessoriesRecorded" AS ar, "signedAt" IS NOT NULL AS signed
      FROM "ServiceCaseIntake" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int`)[0];
  const snap = (await tx.$queryRaw<{ tv: number; sv: number }[]>`
    SELECT t.version AS tv, s.version AS sv
      FROM "ServiceIntakeTermsSnapshot" x
      JOIN "ServiceTextVersion" t ON t."businessId" = x."businessId" AND t.id = x."termsVersionId"
      JOIN "ServiceTextVersion" s ON s."businessId" = x."businessId" AND s.id = x."statutoryNoticeVersionId"
     WHERE x."businessId" = ${b}::int AND x."caseId" = ${caseId}::int`)[0];
  const photos = Number((await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ServiceIntakePhoto" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int`)[0]?.n ?? 0);
  return {
    kind: locked.context.kind,
    status: locked.context.status,
    intake: intake ? { conditionRecorded: intake.cr, accessoriesRecorded: intake.ar, signed: intake.signed } : null,
    termsSnapshot: snap ? { termsVersion: Number(snap.tv), statutoryVersion: Number(snap.sv) } : null,
    photoCount: photos,
  };
}

async function textFact(tx: Tx, b: number, id: number | null): Promise<TextFact> {
  if (id === null) return null;
  const r = (await tx.$queryRaw<{ id: number; kind: string; version: number; legalStatus: string; bodySha256: string }[]>`
    SELECT id, kind::text AS kind, version, "legalStatus"::text AS "legalStatus", "bodySha256"
      FROM "ServiceTextVersion" WHERE "businessId" = ${b}::int AND id = ${id}::int AND "erasedAt" IS NULL`)[0];
  return r ? { id: Number(r.id), kind: r.kind as never, version: Number(r.version), legalStatus: r.legalStatus as never, bodySha256: String(r.bodySha256) } : null;
}

async function storeCreateOnce(storage: StorageService, b: number, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (!isServiceKeyOfBusiness(key, b)) throw new ServiceDeskError("INVALID_INPUT", { field: "key" }); // never: keys are built here
  // CREATED, or EXISTS: under a content-addressed key that means these very bytes are already stored (a retry, or a
  // transaction that failed after its upload). Never an overwrite: the domain accepts create-once writes only.
  await storage.putObjectIfAbsent({ key, body: Buffer.from(bytes), contentType, metadata: { businessId: b, domain: SERVICE_STORAGE_DOMAIN, visibility: "private" } });
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────

/** Freeze the active approved terms + statutory notice for this case. Refused without approved texts. */
export async function presentTerms(p: ServiceDeskPrincipal, caseId: unknown, body: { expectedVersion?: unknown }, req: WriteRequest): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const prepared = prepare(p, req, "service-desk/cases:intake-terms", { caseId, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const f = await intakeFacts(tx, b, caseId, locked);
    const s = (await tx.$queryRaw<{ t: number | null; s: number | null }[]>`
      SELECT "activeTermsVersionId" AS t, "activeStatutoryNoticeVersionId" AS s FROM "ServiceSettings" WHERE "businessId" = ${b}::int`)[0];
    const d = evaluatePresentTerms(f, await textFact(tx, b, s?.t ?? null), await textFact(tx, b, s?.s ?? null));
    if (!d.ok) throw refused(d.violations);
    await tx.$executeRaw`
      INSERT INTO "ServiceIntakeTermsSnapshot" ("businessId", "caseId", "termsVersionId", "termsSha256", "statutoryNoticeVersionId", "statutorySha256", "presentedByUserId")
      VALUES (${b}::int, ${caseId}::int, ${d.termsVersionId}::int, ${d.termsSha256}::char(64), ${d.statutoryVersionId}::int, ${d.statutorySha256}::char(64), ${p.userId}::int)`;
    await appendRecord(tx, b, caseId, locked.context, "RECORD_INTAKE",
      { step: "TERMS_PRESENTED", termsVersion: d.termsVersion, statutoryVersion: d.statutoryVersion, termsSha256: d.termsSha256, statutorySha256: d.statutorySha256 }, p.userId, prepared);
  });
}

/** One intake photo. The bytes decide the type; the key is the content hash. */
export async function addIntakePhoto(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { bytes: Uint8Array; declaredMime: unknown; expectedVersion?: unknown },
  req: WriteRequest,
  storage: StorageService = getStorageService(),
): Promise<CommandResult & { photo?: { sha256: string } }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!(body.bytes instanceof Uint8Array) || body.bytes.length === 0) throw new ServiceDeskError("INVALID_INPUT", { field: "body" });
  if (body.bytes.length > PHOTO_UPLOAD_MAX_BYTES) throw refused(["PHOTO_TOO_LARGE"]);
  const sha256 = sha256Hex(body.bytes);
  const prepared = prepare(p, req, "service-desk/cases:intake-photo", { caseId, sha256, declaredMime: body.declaredMime ?? null, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  const r = await recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const d = evaluateAddPhoto(await intakeFacts(tx, b, caseId, locked), { declaredMime: body.declaredMime, bytes: body.bytes });
    if (!d.ok) throw refused(d.violations);
    const key = intakePhotoKey({ businessId: b, caseId, sha256, mimeType: d.mimeType });
    const dup = (await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "ServiceIntakePhoto" WHERE "businessId" = ${b}::int AND "storageKey" = ${key}) AS ok`)[0]?.ok === true;
    if (dup) throw refused(["PHOTO_DUPLICATE"]);
    await storeCreateOnce(storage, b, key, body.bytes, d.mimeType);
    await tx.$executeRaw`
      INSERT INTO "ServiceIntakePhoto" ("businessId", "caseId", "storageKey", sha256, "mimeType", "byteSize", "createdByUserId")
      VALUES (${b}::int, ${caseId}::int, ${key}, ${sha256}::char(64), ${d.mimeType}, ${d.byteSize}::int, ${p.userId}::int)`;
    await appendRecord(tx, b, caseId, locked.context, "RECORD_INTAKE", { step: "PHOTO_ADDED", photoNumber: d.photoNumber, sha256 }, p.userId, prepared);
  });
  return { ...r, photo: { sha256 } };
}

/** The customer's signature: intake data recorded, approved terms frozen, a plausible PNG. Freezes the intake. */
export async function signIntake(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { signaturePng: Uint8Array; expectedVersion?: unknown },
  req: WriteRequest,
  storage: StorageService = getStorageService(),
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!(body.signaturePng instanceof Uint8Array) || body.signaturePng.length === 0) throw new ServiceDeskError("INVALID_INPUT", { field: "signature" });
  const sha256 = sha256Hex(body.signaturePng);
  const prepared = prepare(p, req, "service-desk/cases:intake-sign", { caseId, sha256, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const f = await intakeFacts(tx, b, caseId, locked);
    const d = evaluateSign(f, body.signaturePng);
    if (!d.ok || !f.termsSnapshot) throw refused(d.ok ? ["TERMS_NOT_PRESENTED"] : d.violations);
    const key = intakeSignatureKey({ businessId: b, caseId, sha256 });
    await storeCreateOnce(storage, b, key, body.signaturePng, "image/png");
    const n = await tx.$executeRaw`
      UPDATE "ServiceCaseIntake" SET "customerSigned" = true, "signedAt" = now(), "signatureKey" = ${key}, "termsVersion" = ${d.termsVersionLabel}, "updatedAt" = now()
       WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND "signedAt" IS NULL`;
    if (n !== 1) throw refused(["INTAKE_SIGNED"]);
    await appendRecord(tx, b, caseId, locked.context, "RECORD_INTAKE",
      { step: "SIGNED", termsVersion: f.termsSnapshot.termsVersion, statutoryVersion: f.termsSnapshot.statutoryVersion, signatureSha256: sha256 }, p.userId, prepared);
  });
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────────────────

export type IntakeView = {
  intake: {
    conditionNote: string | null; accessoriesNote: string | null; conditionRecorded: boolean; accessoriesRecorded: boolean;
    signed: boolean; signedAt: string | null; termsVersion: string | null; hasSignature: boolean; hasSlip: boolean;
  } | null;
  terms: { presentedAt: string; termsVersion: number; statutoryVersion: number; termsSha256: string; statutorySha256: string; termsBody: string; statutoryBody: string } | null;
  /** What would be presented now: the active versions and whether both are approved (no body until presented). */
  activeTerms: { termsVersion: number | null; statutoryVersion: number | null; approved: boolean };
  photos: { id: number; sha256: string; mimeType: string; byteSize: number; createdAt: string }[];
  history: { seq: number; step: string | null; occurredAt: string }[];
};

const iso = (d: unknown) => (d === null || d === undefined ? null : new Date(d as string).toISOString());

/** The intake of one case: its data, the frozen texts, photos and the intake journal (its steps, never text). */
export async function getIntake(businessId: number, caseId: unknown): Promise<IntakeView> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const exists = (await tx.$queryRaw<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int) AS ok`)[0]?.ok;
    if (!exists) throw new ServiceDeskError("NOT_FOUND");
    const i = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT "conditionNote", "accessoriesNote", "conditionRecorded", "accessoriesRecorded", "signedAt", "termsVersion", "signatureKey", "slipPdfKey"
        FROM "ServiceCaseIntake" WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int`)[0];
    const t = (await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT x."presentedAt", x."termsSha256", x."statutorySha256", t.version AS tv, t.body AS tb, s.version AS sv, s.body AS sb
        FROM "ServiceIntakeTermsSnapshot" x
        JOIN "ServiceTextVersion" t ON t."businessId" = x."businessId" AND t.id = x."termsVersionId"
        JOIN "ServiceTextVersion" s ON s."businessId" = x."businessId" AND s.id = x."statutoryNoticeVersionId"
       WHERE x."businessId" = ${businessId}::int AND x."caseId" = ${caseId}::int`)[0];
    const a = (await tx.$queryRaw<{ tv: number | null; sv: number | null; ok: boolean }[]>`
      SELECT t.version AS tv, s.version AS sv,
             (t."legalStatus" = 'LEGALLY_APPROVED' AND s."legalStatus" = 'LEGALLY_APPROVED') IS TRUE AS ok
        FROM "ServiceSettings" st
        LEFT JOIN "ServiceTextVersion" t ON t."businessId" = st."businessId" AND t.id = st."activeTermsVersionId" AND t.kind = 'TERMS'
        LEFT JOIN "ServiceTextVersion" s ON s."businessId" = st."businessId" AND s.id = st."activeStatutoryNoticeVersionId" AND s.kind = 'STATUTORY_NOTICE'
       WHERE st."businessId" = ${businessId}::int`)[0];
    const photos = await tx.$queryRaw<{ id: number; sha256: string; mimeType: string; byteSize: number; createdAt: Date }[]>`
      SELECT id, sha256, "mimeType", "byteSize", "createdAt" FROM "ServiceIntakePhoto"
       WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND "erasedAt" IS NULL ORDER BY id`;
    const history = await tx.$queryRaw<{ seq: number; step: string | null; occurredAt: Date }[]>`
      SELECT seq, payload->>'step' AS step, "occurredAt" FROM "ServiceCaseEvent"
       WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND action::text = 'RECORD_INTAKE' ORDER BY seq`;
    return {
      intake: i ? {
        conditionNote: (i.conditionNote as string | null) ?? null, accessoriesNote: (i.accessoriesNote as string | null) ?? null,
        conditionRecorded: i.conditionRecorded === true, accessoriesRecorded: i.accessoriesRecorded === true,
        signed: i.signedAt !== null, signedAt: iso(i.signedAt), termsVersion: (i.termsVersion as string | null) ?? null,
        hasSignature: i.signatureKey !== null, hasSlip: i.slipPdfKey !== null,
      } : null,
      terms: t ? {
        presentedAt: iso(t.presentedAt) as string, termsVersion: Number(t.tv), statutoryVersion: Number(t.sv),
        termsSha256: String(t.termsSha256), statutorySha256: String(t.statutorySha256), termsBody: String(t.tb), statutoryBody: String(t.sb),
      } : null,
      activeTerms: { termsVersion: a?.tv === null || a?.tv === undefined ? null : Number(a.tv), statutoryVersion: a?.sv === null || a?.sv === undefined ? null : Number(a.sv), approved: a?.ok === true },
      photos: photos.map((r) => ({ id: Number(r.id), sha256: String(r.sha256), mimeType: String(r.mimeType), byteSize: Number(r.byteSize), createdAt: iso(r.createdAt) as string })),
      history: history.map((r) => ({ seq: Number(r.seq), step: r.step ?? null, occurredAt: iso(r.occurredAt) as string })),
    };
  });
}

/** The bytes of one intake photo or of the signature, only through this case's own row (never a key from the request). */
export async function readIntakeObject(
  businessId: number,
  caseId: unknown,
  what: { kind: "photo"; photoId: unknown } | { kind: "signature" },
  storage: StorageService = getStorageService(),
): Promise<{ bytes: Buffer; contentType: string }> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const row = await tenantTx(businessId, async (tx) => {
    if (what.kind === "photo") {
      if (!isPositiveInt(what.photoId)) return null;
      return (await tx.$queryRaw<{ key: string; mime: string }[]>`
        SELECT "storageKey" AS key, "mimeType" AS mime FROM "ServiceIntakePhoto"
         WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND id = ${what.photoId}::int AND "erasedAt" IS NULL`)[0] ?? null;
    }
    return (await tx.$queryRaw<{ key: string | null; mime: string }[]>`
      SELECT "signatureKey" AS key, 'image/png' AS mime FROM "ServiceCaseIntake"
       WHERE "businessId" = ${businessId}::int AND "caseId" = ${caseId}::int AND "erasedAt" IS NULL`)[0] ?? null;
  });
  if (!row || !row.key || !isServiceKeyOfBusiness(row.key, businessId)) throw new ServiceDeskError("NOT_FOUND");
  const o = await storage.getObject(row.key);
  const bytes = Buffer.from(o.body as Uint8Array);
  if (sniffImage(bytes) === null) throw new ServiceDeskError("NOT_FOUND"); // a fence marker or a foreign object is never served
  return { bytes, contentType: row.mime };
}
