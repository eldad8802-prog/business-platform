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
 * Objects are written create-once (putObjectIfAbsent) BEFORE the command transaction, after a preflight that takes the
 * same decision (a refused request stores nothing) and skips the upload for a replayed key, so no case lock or pooled
 * connection is held while bytes travel. The command then re-decides under the lock and writes only the row and event.
 * A command that fails after its upload leaves an object with no row; the key is the content hash, so a retry with the
 * same bytes reuses it (EXISTS). Orphans are removed with the business prefix by the account-erasure job; a periodic
 * orphan sweep for live businesses is a documented follow-up.
 *
 * Journal payloads are tokens, numbers and booleans only (ServiceCaseEvent_payload_closed) — never a text body.
 */
import { createHash } from "node:crypto";

import { getStorageService, type StorageService } from "@/lib/storage";
import { tenantTx } from "@/lib/tenant/tenant-tx";

import { evaluateAddPhoto, evaluatePresentTerms, evaluateSign, sniffImage, type IntakeFacts, type IntakeViolation, type TextFact } from "./intake.core";
import {
  appendRecord,
  isNonNegativeInt,
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
import { INTAKE_PHOTOS_PER_CASE, SERVICE_STORAGE_DOMAIN, intakePhotoKey, intakeSignatureKey, isServiceKeyOfBusiness, serviceBusinessPrefix } from "./storage/service-storage-keys";

/** Vercel caps a request body at 4.5 MB: the screen downsizes photos; the server refuses more than this. */
export const PHOTO_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refused = (violations: IntakeViolation[]) => new ServiceDeskError("REFUSED", { violations });

// ── Facts ───────────────────────────────────────────────────────────────────────────────────────────────────

type IntakeData = IntakeFacts & {
  notes: { conditionNote: string | null; accessoriesNote: string | null };
  snapshotHashes: { termsSha256: string; statutorySha256: string } | null;
  photoShas: string[];
};

/** The intake facts of a case (inside a transaction; under the case lock when the caller holds it). */
async function intakeData(tx: Tx, b: number, caseId: number, kind: IntakeFacts["kind"], status: IntakeFacts["status"]): Promise<IntakeData> {
  const intake = (await tx.$queryRaw<{ cr: boolean; ar: boolean; signed: boolean; cn: string | null; an: string | null }[]>`
    SELECT "conditionRecorded" AS cr, "accessoriesRecorded" AS ar, "signedAt" IS NOT NULL AS signed, "conditionNote" AS cn, "accessoriesNote" AS an
      FROM "ServiceCaseIntake" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int`)[0];
  const snap = (await tx.$queryRaw<{ tv: number; sv: number; th: string; sh: string }[]>`
    SELECT t.version AS tv, s.version AS sv, x."termsSha256" AS th, x."statutorySha256" AS sh
      FROM "ServiceIntakeTermsSnapshot" x
      JOIN "ServiceTextVersion" t ON t."businessId" = x."businessId" AND t.id = x."termsVersionId"
      JOIN "ServiceTextVersion" s ON s."businessId" = x."businessId" AND s.id = x."statutoryNoticeVersionId"
     WHERE x."businessId" = ${b}::int AND x."caseId" = ${caseId}::int`)[0];
  const photos = await tx.$queryRaw<{ sha256: string }[]>`
    SELECT sha256 FROM "ServiceIntakePhoto" WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int`;
  return {
    kind, status,
    intake: intake ? { conditionRecorded: intake.cr, accessoriesRecorded: intake.ar, signed: intake.signed } : null,
    termsSnapshot: snap ? { termsVersion: Number(snap.tv), statutoryVersion: Number(snap.sv) } : null,
    photoCount: photos.length,
    notes: { conditionNote: intake?.cn ?? null, accessoriesNote: intake?.an ?? null },
    snapshotHashes: snap ? { termsSha256: String(snap.th).trim(), statutorySha256: String(snap.sh).trim() } : null,
    photoShas: photos.map((r) => String(r.sha256).trim()).sort(),
  };
}

const lockedData = (tx: Tx, b: number, caseId: number, locked: Locked) => intakeData(tx, b, caseId, locked.context.kind, locked.context.status);

/**
 * Before an upload, OUTSIDE the command transaction (no case lock is held while bytes travel to storage): an earlier
 * answer for this key → skip the upload (recordCommand replays); otherwise the same decision the command takes again
 * under the lock — a request refused here stores nothing.
 */
async function preflight(b: number, caseId: number, idempotencyKey: string, decide: (f: IntakeData) => IntakeViolation[] | null): Promise<"REPLAY" | "UPLOAD"> {
  return tenantTx(b, async (tx) => {
    const prior = (await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "ServiceCaseEvent" WHERE "businessId" = ${b}::int AND "idempotencyKey" = ${idempotencyKey}) AS ok`)[0]?.ok === true;
    if (prior) return "REPLAY";
    const c = (await tx.$queryRaw<{ kind: string; status: string }[]>`
      SELECT kind::text AS kind, status::text AS status FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${b}::int`)[0];
    if (!c) throw new ServiceDeskError("NOT_FOUND");
    const v = decide(await intakeData(tx, b, caseId, c.kind as never, c.status as never));
    if (v && v.length > 0) throw refused(v);
    return "UPLOAD";
  });
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
  // command that failed after its upload). Never an overwrite: the domain accepts create-once writes only.
  await storage.putObjectIfAbsent({ key, body: Buffer.from(bytes), contentType, metadata: { businessId: b, domain: SERVICE_STORAGE_DOMAIN, visibility: "private" } });
}

/**
 * Under the case lock, right before a row starts to name an object: make sure the object is there. The orphan sweep
 * (intake-orphan-sweep) deletes only while holding this same case lock and only objects no row names, so an upload that
 * was swept before its command got the lock is written again here from the bytes in memory — a row never names a
 * missing object.
 */
export async function ensureStoredUnderLock(storage: StorageService, b: number, key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if ((await storage.headObject(key)).exists) return;
  await storeCreateOnce(storage, b, key, bytes, contentType);
}

/**
 * What the customer signed, as one hash: the intake notes and flags and the sorted photo hashes, in a fixed canonical
 * form. Journaled with the signature, so the event alone proves later that none of it was changed.
 */
export function intakeDigest(d: { conditionNote: string | null; accessoriesNote: string | null; conditionRecorded: boolean; accessoriesRecorded: boolean; photoShas: string[] }): string {
  const canonical = JSON.stringify([d.conditionNote ?? null, d.accessoriesNote ?? null, d.conditionRecorded, d.accessoriesRecorded, [...d.photoShas].sort()]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────

/** Freeze the active approved terms + statutory notice for this case. Refused without approved texts. */
export async function presentTerms(p: ServiceDeskPrincipal, caseId: unknown, body: { expectedVersion?: unknown }, req: WriteRequest): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  const prepared = prepare(p, req, "service-desk/cases:intake-terms", { caseId, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const f = await lockedData(tx, b, caseId, locked);
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

/** One intake photo. The bytes decide the type; the key is the content hash; uploaded before the command, not inside it. */
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
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const sha256 = sha256Hex(body.bytes);
  const prepared = prepare(p, req, "service-desk/cases:intake-photo", { caseId, sha256, declaredMime: body.declaredMime ?? null, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  const decide = (f: IntakeData): IntakeViolation[] | null => {
    const d = evaluateAddPhoto(f, { declaredMime: body.declaredMime, bytes: body.bytes });
    if (!d.ok) return d.violations;
    return f.photoShas.includes(sha256) ? ["PHOTO_DUPLICATE"] : null;
  };
  const mode = await preflight(b, caseId, prepared.key, decide);
  const mime = sniffImage(body.bytes);
  if (mode === "UPLOAD" && mime) await storeCreateOnce(storage, b, intakePhotoKey({ businessId: b, caseId, sha256, mimeType: mime }), body.bytes, mime);
  const r = await recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const f = await lockedData(tx, b, caseId, locked);
    const v = decide(f);
    if (v) throw refused(v);
    const d = evaluateAddPhoto(f, { declaredMime: body.declaredMime, bytes: body.bytes });
    if (!d.ok) throw refused(d.violations);
    const key = intakePhotoKey({ businessId: b, caseId, sha256, mimeType: d.mimeType });
    await ensureStoredUnderLock(storage, b, key, body.bytes, d.mimeType);
    await tx.$executeRaw`
      INSERT INTO "ServiceIntakePhoto" ("businessId", "caseId", "storageKey", sha256, "mimeType", "byteSize", "createdByUserId")
      VALUES (${b}::int, ${caseId}::int, ${key}, ${sha256}::char(64), ${d.mimeType}, ${d.byteSize}::int, ${p.userId}::int)`;
    await appendRecord(tx, b, caseId, locked.context, "RECORD_INTAKE", { step: "PHOTO_ADDED", photoNumber: d.photoNumber, sha256 }, p.userId, prepared);
  });
  return { ...r, photo: { sha256 } };
}

/**
 * The customer's signature: intake data recorded, approved terms frozen, a structurally valid PNG. Freezes the intake.
 * The event carries the evidence on its own: the snapshot's text hashes, the signature hash and the digest of what was
 * signed (notes, flags, photo hashes).
 */
export async function signIntake(
  p: ServiceDeskPrincipal,
  caseId: unknown,
  body: { signaturePng: Uint8Array; expectedVersion?: unknown },
  req: WriteRequest,
  storage: StorageService = getStorageService(),
): Promise<CommandResult> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  if (!(body.signaturePng instanceof Uint8Array) || body.signaturePng.length === 0) throw new ServiceDeskError("INVALID_INPUT", { field: "signature" });
  if (!isNonNegativeInt(body.expectedVersion)) throw new ServiceDeskError("INVALID_INPUT", { field: "expectedVersion" });
  const sha256 = sha256Hex(body.signaturePng);
  const prepared = prepare(p, req, "service-desk/cases:intake-sign", { caseId, sha256, expectedVersion: body.expectedVersion });
  const b = p.businessId;
  const key = intakeSignatureKey({ businessId: b, caseId, sha256 });
  const mode = await preflight(b, caseId, prepared.key, (f) => { const d = evaluateSign(f, body.signaturePng); return d.ok ? null : d.violations; });
  if (mode === "UPLOAD") await storeCreateOnce(storage, b, key, body.signaturePng, "image/png");
  return recordCommand(p, caseId, body.expectedVersion, prepared, async (tx, locked) => {
    const f = await lockedData(tx, b, caseId, locked);
    const d = evaluateSign(f, body.signaturePng);
    if (!d.ok) throw refused(d.violations);
    if (!f.termsSnapshot || !f.snapshotHashes || !f.intake) throw refused(["TERMS_NOT_PRESENTED"]);
    await ensureStoredUnderLock(storage, b, key, body.signaturePng, "image/png");
    const n = await tx.$executeRaw`
      UPDATE "ServiceCaseIntake" SET "customerSigned" = true, "signedAt" = now(), "signatureKey" = ${key}, "termsVersion" = ${d.termsVersionLabel}, "updatedAt" = now()
       WHERE "businessId" = ${b}::int AND "caseId" = ${caseId}::int AND "signedAt" IS NULL`;
    if (n !== 1) throw refused(["INTAKE_SIGNED"]);
    const intakeSha256 = intakeDigest({ ...f.notes, conditionRecorded: f.intake.conditionRecorded, accessoriesRecorded: f.intake.accessoriesRecorded, photoShas: f.photoShas });
    await appendRecord(tx, b, caseId, locked.context, "RECORD_INTAKE", {
      step: "SIGNED", termsVersion: f.termsSnapshot.termsVersion, statutoryVersion: f.termsSnapshot.statutoryVersion,
      termsSha256: f.snapshotHashes.termsSha256, statutorySha256: f.snapshotHashes.statutorySha256, signatureSha256: sha256, intakeSha256, photoCount: f.photoCount,
    }, p.userId, prepared);
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
  /** The owner's confirmation of the intake (the CHECK_IN event): when and by whom. Owner decision 2026-11-11 — no customer signature. */
  confirmation: { at: string; byUserId: number | null; byName: string | null } | null;
  /** The case this intake belongs to (the screen's title) and what the server allows NOW — the screen offers only these. */
  case: { caseNumber: number; kind: string; status: string; version: number };
  allowed: IntakeAllowed;
};

/** The intake actions the server would accept now (write access aside — the gate answers READ_ONLY). */
export type IntakeAllowed = { recordData: boolean; addPhoto: boolean; confirm: boolean; createSlip: boolean };

/**
 * Pure: the intake actions allowed now, from the same rules the commands apply. Owner decision 2026-11-11: no customer
 * signature and no terms step — the owner confirms the documented intake (CHECK_IN with intakeConfirmed), then the slip.
 */
export function intakeAllowed(v: { kind: string; status: string; recorded: boolean; photoCount: number; confirmed: boolean; hasSlip: boolean }): IntakeAllowed {
  const open = v.kind === "IN_SHOP" && (v.status === "OPEN" || v.status === "SCHEDULED") && !v.confirmed;
  return {
    recordData: open,
    addPhoto: open && v.photoCount < INTAKE_PHOTOS_PER_CASE,
    confirm: open && v.recorded,
    createSlip: v.kind === "IN_SHOP" && v.confirmed && !v.hasSlip,
  };
}

const iso = (d: unknown) => (d === null || d === undefined ? null : new Date(d as string).toISOString());

/** The intake of one case: its data, the frozen texts, photos and the intake journal (its steps, never text). */
export async function getIntake(businessId: number, caseId: unknown): Promise<IntakeView> {
  if (!isPositiveInt(caseId)) throw new ServiceDeskError("NOT_FOUND");
  return tenantTx(businessId, async (tx) => {
    const kase = (await tx.$queryRaw<{ n: number; kind: string; status: string; version: number }[]>`
      SELECT "caseNumber" AS n, kind::text AS kind, status::text AS status, version FROM "ServiceCase" WHERE id = ${caseId}::int AND "businessId" = ${businessId}::int`)[0];
    if (!kase) throw new ServiceDeskError("NOT_FOUND");
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
    const conf = (await tx.$queryRaw<{ at: Date; uid: number | null; name: string | null }[]>`
      SELECT e."occurredAt" AS at, e."actorUserId" AS uid, COALESCE(NULLIF(btrim(u.name), ''), u.email) AS name
        FROM "ServiceCaseEvent" e LEFT JOIN "User" u ON u.id = e."actorUserId"
       WHERE e."businessId" = ${businessId}::int AND e."caseId" = ${caseId}::int AND e.action::text = 'CHECK_IN' ORDER BY e.seq DESC LIMIT 1`)[0];
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
      case: { caseNumber: Number(kase.n), kind: kase.kind, status: kase.status, version: Number(kase.version) },
      confirmation: conf ? { at: iso(conf.at) as string, byUserId: conf.uid === null ? null : Number(conf.uid), byName: conf.name ?? null } : null,
      allowed: intakeAllowed({
        kind: kase.kind, status: kase.status, recorded: i?.conditionRecorded === true && i?.accessoriesRecorded === true,
        photoCount: photos.length, confirmed: Boolean(conf), hasSlip: i?.slipPdfKey != null,
      }),
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
  // The key must sit under THIS case's own intake folder, and the bytes must hash to the name it carries.
  const folder = `${serviceBusinessPrefix(businessId)}cases/${caseId}/intake/${what.kind === "photo" ? "photos" : "signature"}/`;
  if (!row || !row.key || !isServiceKeyOfBusiness(row.key, businessId) || !row.key.startsWith(folder)) throw new ServiceDeskError("NOT_FOUND");
  let bytes: Buffer;
  try {
    bytes = Buffer.from((await storage.getObject(row.key)).body);
  } catch {
    throw new ServiceDeskError("NOT_FOUND"); // the row outlived its object (an erasure race, a lost write): never a 500
  }
  const named = row.key.slice(folder.length).split(".")[0];
  if (sniffImage(bytes) === null || sha256Hex(bytes) !== named) throw new ServiceDeskError("NOT_FOUND"); // a fence marker or foreign bytes are never served
  return { bytes, contentType: row.mime };
}
