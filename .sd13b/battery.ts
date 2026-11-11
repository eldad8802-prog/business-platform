/**
 * Service Desk 1.3b — the intake signature path: the data service AS the real runtime role, on the P4 lab
 * (.sd3p4/lab.sh <db> then --deploy-only: 1.2a + 1.2b + M2 + 1.3-0 + P4 applied by migrate deploy). Synthetic only.
 * Objects go to the real storage adapter (STORAGE_PROVIDER=local, a scratch LOCAL_STORAGE_ROOT): create-once writes, and
 * the case machine itself checks the signature object exists before CHECK_IN (INTAKE_ARTIFACTS_STORED).
 *
 *   T  terms: no active texts → TERMS_NOT_CONFIGURED; a DRAFT active → TERMS_NOT_APPROVED, nothing written; approved →
 *      the snapshot (ids + hashes) and one RECORD_INTAKE event; replay; once per case; the database refuses a DRAFT
 *      snapshot written directly by the runtime role (owner rule: no signature without approved terms).
 *   P  photos: accepted by bytes (object + row + event); declared type ≠ bytes refused and nothing stored; the same photo
 *      twice refused; over 4 MB refused; the 11th refused; the bytes read back only through the case's own row.
 *   S  signature: not before the intake data is recorded; not without the terms snapshot; then signed (object, row,
 *      termsVersion label, event); afterwards terms / photos / intake data / a second signature are refused; CHECK_IN
 *      now passes, while an unsigned case is still refused (the case machine unchanged); a FIELD case has no intake.
 *   V  the view: frozen texts, photos, the journal steps.
 *   J  every intake payload is tokens / numbers / booleans — no Hebrew, no body text.
 *   I  isolation: another business cannot read, present, upload, sign or fetch an object of A's case.
 *   K  races: two signatures at once (one signs); one photo key five times (one row); two presentations (one snapshot).
 *   O  the orphan sweep (library, not scheduled): grace period, dry run, only unlinked intake shapes, under the case lock;
 *      a swept upload is written again by its late command; per-business prefix; a deleting business skipped.
 *   L  the slip PDF (1.3b-B): only for a signed intake; rendered once (Chromium), stored content-addressed, only slipPdfKey set
 *      (the guard refuses any later change); replay; read back by its hash; isolation.
 *
 * env: OWNER_URL (lab owner), SUPER_URL (lab superuser — fixtures only), DATABASE_URL = DIRECT_URL (app_runtime_prod),
 *      TASK_REQUEST_HMAC_KEY / _ID, AUTH_TOKEN_SECRET.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { deflateSync } from "node:zlib";

import { PrismaClient } from "@prisma/client";

import { getStorageService } from "../lib/storage";
import { uuidV7 } from "../lib/services/tasks/task-idempotency";
import { ServiceDeskError } from "../lib/services/service-desk/service-desk-errors";
import { openCase, recordIntake, runCaseAction, type ServiceDeskPrincipal } from "../lib/services/service-desk/service-case.service";
import { crc32 } from "../lib/services/service-desk/intake.core";
import { createIntakeSlip, loadSlipInput, readIntakeSlip, renderIntakeSlipPdf } from "../lib/services/service-desk/intake-slip.service";
import { buildIntakeSlipHtml } from "../lib/services/service-desk/intake-slip-html";
import { sweepIntakeOrphans } from "../lib/services/service-desk/intake-orphan-sweep";
import { addIntakePhoto, getIntake, intakeDigest, presentTerms, readIntakeObject, signIntake } from "../lib/services/service-desk/intake.service";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const runtime = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL! }); // the real runtime role, for the guard checks
const sup = new PrismaClient({ datasourceUrl: process.env.SUPER_URL! }); // lab superuser — fixtures only
let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); } else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
type Rows = Record<string, unknown>[];
const q = (sql: string, ...a: unknown[]) => owner.$queryRawUnsafe(sql, ...a) as Promise<Rows>;
const x = (sql: string, ...a: unknown[]) => owner.$executeRawUnsafe(sql, ...a);
const n = async (sql: string, ...a: unknown[]) => Number((await q(sql, ...a))[0]?.n);
const key = () => uuidV7(new Date());
async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return "OK"; } catch (e) {
    if (e instanceof ServiceDeskError) return `${e.code}${e.details && Object.keys(e.details).length ? ":" + JSON.stringify(e.details) : ""}`;
    return `ERR:${(e as Error).message.replace(/\s+/g, " ").trim().slice(-300)}`;
  }
}

const store = getStorageService();
const stored = async (k: string) => (await store.headObject(k)).exists;

// ── images (the core reads the header; the bytes differ per call so each photo is its own object) ──
let salt = 0;
/** A real, decodable PNG: a white canvas with a dark stroke (a drawn signature), unique per call (a tEXt chunk). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  for (let x = Math.floor(width * 0.1); x < Math.floor(width * 0.9); x++) {
    const y = Math.floor(height / 2 + Math.sin(x / 18) * height * 0.25);
    for (let t = -2; t <= 2; t++) { const yy = Math.min(height - 1, Math.max(0, y + t)); const o = yy * (width * 3 + 1) + 1 + x * 3; raw[o] = 20; raw[o + 1] = 20; raw[o + 2] = 60; }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("tEXt", Buffer.from(`lab\0${++salt}`, "latin1")), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function jpeg(bytes = 6000): Buffer { const b = Buffer.alloc(bytes); b.set([0xff, 0xd8, 0xff, 0xe0]); b.writeUInt32BE(++salt, bytes - 4); return b; }
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const t = Date.now();
async function business(tag: string) {
  const b = Number((await q(`INSERT INTO "Business" (name, "updatedAt") VALUES ($1, now()) RETURNING id`, `sd13b-${tag}-${t}`))[0].id);
  const u = Number((await q(`INSERT INTO "User" (email, "businessId", "updatedAt") VALUES ($1, $2, now()) RETURNING id`, `sd13b-${tag}-${t}@lab.invalid`, b))[0].id);
  const cust = Number((await q(`INSERT INTO "Customer" ("businessId", name, "updatedAt") VALUES ($1, 'לקוח סינתטי', now()) RETURNING id`, b))[0].id);
  return { b, u, cust, p: { businessId: b, userId: u } as ServiceDeskPrincipal };
}
type Biz = Awaited<ReturnType<typeof business>>;
/** Lab fixture: a text version born DRAFT (the guard insists), optionally approved in its own step (time + approver). */
async function text(z: Biz, kind: "TERMS" | "STATUTORY_NOTICE", body: string, approve: boolean): Promise<number> {
  const v = (await n(`SELECT COALESCE(max(version), 0)::int AS n FROM "ServiceTextVersion" WHERE "businessId" = $1 AND kind = $2::"ServiceTextKind"`, z.b, kind)) + 1;
  const id = Number((await q(`INSERT INTO "ServiceTextVersion" ("businessId", kind, version, body, "bodySha256", "createdByUserId")
    VALUES ($1, $2::"ServiceTextKind", $3, $4, encode(sha256(convert_to($4, 'UTF8')), 'hex'), $5) RETURNING id`, z.b, kind, v, body, z.u))[0].id);
  if (approve) await x(`UPDATE "ServiceTextVersion" SET "legalStatus" = 'LEGALLY_APPROVED', "legallyApprovedAt" = now(), "legallyApprovedByUserId" = $2 WHERE id = $1`, id, z.u);
  return id;
}
async function activate(z: Biz, terms: number, statutory: number) {
  const cur = (await q(`SELECT version FROM "ServiceSettings" WHERE "businessId" = $1`, z.b))[0];
  if (!cur) await x(`INSERT INTO "ServiceSettings" ("businessId", "activeTermsVersionId", "activeStatutoryNoticeVersionId", version, "updatedAt") VALUES ($1, $2, $3, 1, now())`, z.b, terms, statutory);
  else await x(`UPDATE "ServiceSettings" SET "activeTermsVersionId" = $2, "activeStatutoryNoticeVersionId" = $3, version = version + 1, "updatedAt" = now() WHERE "businessId" = $1`, z.b, terms, statutory);
}
async function shopCase(z: Biz) {
  const o = await openCase(z.p, { kind: "IN_SHOP", customerId: z.cust, problemDescription: "המסך לא נדלק" }, { idempotencyKey: key() });
  return { id: o.case.id, v: o.case.version };
}
const version = async (id: number) => n(`SELECT version::int AS n FROM "ServiceCase" WHERE id = $1`, id);
const events = (id: number) => n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1`, id);
const snapshots = (id: number) => n(`SELECT count(*)::int AS n FROM "ServiceIntakeTermsSnapshot" WHERE "caseId" = $1`, id);
const photos = (id: number) => n(`SELECT count(*)::int AS n FROM "ServiceIntakePhoto" WHERE "caseId" = $1`, id);
const record = async (z: Biz, id: number) => recordIntake(z.p, id, { conditionNote: "שריטה בפינה", accessoriesNote: "מטען", conditionRecorded: true, accessoriesRecorded: true, expectedVersion: await version(id) }, { idempotencyKey: key() });
const present = async (z: Biz, id: number, k = key()) => presentTerms(z.p, id, { expectedVersion: await version(id) }, { idempotencyKey: k });
const photo = async (z: Biz, id: number, bytes: Buffer, mime = "image/jpeg", k = key()) => addIntakePhoto(z.p, id, { bytes, declaredMime: mime, expectedVersion: await version(id) }, { idempotencyKey: k }, store);
const sign = async (z: Biz, id: number, bytes = png(600, 200), k = key()) => signIntake(z.p, id, { signaturePng: bytes, expectedVersion: await version(id) }, { idempotencyKey: k }, store);

async function main() {
  const A = await business("a"), B = await business("b");

  console.log("T — terms");
  const c1 = await shopCase(A);
  ok("T1 no settings / no active texts → TERMS_NOT_CONFIGURED, nothing written", (await code(() => present(A, c1.id))).includes("TERMS_NOT_CONFIGURED") && (await snapshots(c1.id)) === 0);
  const draftT = await text(A, "TERMS", "תנאי שירות — טיוטה", false), draftS = await text(A, "STATUTORY_NOTICE", "הודעה לפי חוק — טיוטה", false);
  await activate(A, draftT, draftS);
  const e0 = await events(c1.id);
  ok("T2 active texts still DRAFT → TERMS_NOT_APPROVED; no snapshot, no event", (await code(() => present(A, c1.id))).includes("TERMS_NOT_APPROVED") && (await snapshots(c1.id)) === 0 && (await events(c1.id)) === e0);
  const T1 = await text(A, "TERMS", "תנאי שירות מאושרים — גרסה 2", true), S1 = await text(A, "STATUTORY_NOTICE", "הודעה לפי חוק — מאושרת", true);
  await activate(A, T1, S1);
  const kp = key();
  const v0 = await version(c1.id);
  const r1 = await present(A, c1.id, kp);
  const snap = (await q(`SELECT "termsVersionId" t, "statutoryNoticeVersionId" s, "termsSha256" th, "presentedByUserId" u FROM "ServiceIntakeTermsSnapshot" WHERE "caseId" = $1`, c1.id))[0];
  const tsha = String((await q(`SELECT "bodySha256" h FROM "ServiceTextVersion" WHERE id = $1`, T1))[0].h);
  const ev1 = (await q(`SELECT action::text a, "eventType"::text et, payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, c1.id))[0];
  ok("T3 approved → the snapshot names both versions with the text's own hash and the presenter; version +1; one RECORD_INTAKE event (TERMS_PRESENTED)",
    r1.case.version === v0 + 1 && Number(snap.t) === T1 && Number(snap.s) === S1 && snap.th === tsha && Number(snap.u) === A.u
      && ev1.a === "RECORD_INTAKE" && ev1.et === "intake.recorded" && (ev1.payload as Record<string, unknown>).step === "TERMS_PRESENTED");
  const r1b = await presentTerms(A.p, c1.id, { expectedVersion: v0 }, { idempotencyKey: kp });
  ok("T4 the same key again → the stored answer (replayed), still one snapshot", r1b.replayed === true && (await snapshots(c1.id)) === 1);
  ok("T5 a second presentation → TERMS_ALREADY_PRESENTED", (await code(() => present(A, c1.id))).includes("TERMS_ALREADY_PRESENTED") && (await snapshots(c1.id)) === 1);
  const c2 = await shopCase(A);
  const direct = await code(() => runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`INSERT INTO "ServiceIntakeTermsSnapshot" ("businessId", "caseId", "termsVersionId", "termsSha256", "statutoryNoticeVersionId", "statutorySha256")
      SELECT $1, $2, t.id, t."bodySha256", s.id, s."bodySha256" FROM "ServiceTextVersion" t, "ServiceTextVersion" s WHERE t.id = $3 AND s.id = $4`, A.b, c2.id, draftT, draftS);
  }));
  ok("T6 the database itself refuses a DRAFT snapshot written by the runtime role (SERVICE_INTAKE_TERMS_NOT_APPROVED)", direct.includes("SERVICE_INTAKE_TERMS_NOT_APPROVED") && (await snapshots(c2.id)) === 0, direct);

  console.log("P — photos");
  const j1 = jpeg();
    const p1 = await photo(A, c1.id, j1);
  const prow = (await q(`SELECT "storageKey" k, sha256 s, "mimeType" m, "byteSize" z FROM "ServiceIntakePhoto" WHERE "caseId" = $1`, c1.id))[0];
  ok("P1 a JPEG by its bytes → one row (content-addressed key, its hash, type and size), the object stored, one event (PHOTO_ADDED)",
    p1.photo?.sha256 === sha(j1) && prow.s === sha(j1) && prow.m === "image/jpeg" && Number(prow.z) === j1.length
      && String(prow.k) === `biz/${A.b}/service/cases/${c1.id}/intake/photos/${sha(j1)}.jpg` && (await stored(String(prow.k))));
  const jx = jpeg();
  ok("P2 declared image/png but the bytes are a JPEG → PHOTO_TYPE; nothing stored, no row",
    (await code(() => photo(A, c1.id, jx, "image/png"))).includes("PHOTO_TYPE") && !(await stored(`biz/${A.b}/service/cases/${c1.id}/intake/photos/${sha(jx)}.jpg`))
      && !(await stored(`biz/${A.b}/service/cases/${c1.id}/intake/photos/${sha(jx)}.png`)) && (await photos(c1.id)) === 1);
  ok("P3 the same photo again → PHOTO_DUPLICATE", (await code(() => photo(A, c1.id, j1))).includes("PHOTO_DUPLICATE") && (await photos(c1.id)) === 1);
  ok("P4 more than 4 MB → PHOTO_TOO_LARGE (before any write)", (await code(() => photo(A, c1.id, jpeg(4 * 1024 * 1024 + 1)))).includes("PHOTO_TOO_LARGE") && (await photos(c1.id)) === 1);
  const back = await readIntakeObject(A.b, c1.id, { kind: "photo", photoId: Number((await q(`SELECT id FROM "ServiceIntakePhoto" WHERE "caseId" = $1`, c1.id))[0].id) }, store);
  ok("P5 the bytes read back through the case's own row are the uploaded bytes, as image/jpeg", back.contentType === "image/jpeg" && Buffer.compare(back.bytes, j1) === 0);
  for (let i = 0; i < 9; i++) await photo(A, c1.id, jpeg());
  ok("P6 ten photos accepted; the 11th → PHOTO_LIMIT", (await photos(c1.id)) === 10 && (await code(() => photo(A, c1.id, jpeg()))).includes("PHOTO_LIMIT"));

  console.log("S — signature");
  ok("S1 before the intake data is recorded → INTAKE_NOT_RECORDED", (await code(() => sign(A, c1.id))).includes("INTAKE_NOT_RECORDED"));
  await record(A, c1.id);
  const c3 = await shopCase(A); await record(A, c3.id);
  ok("S2 data recorded but no terms snapshot → TERMS_NOT_PRESENTED; nothing signed", (await code(() => sign(A, c3.id))).includes("TERMS_NOT_PRESENTED")
    && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseIntake" WHERE "caseId" = $1 AND "signedAt" IS NOT NULL`, c3.id)) === 0);
  ok("S3 a JPEG as signature / a too-small PNG → SIGNATURE_INVALID", (await code(() => sign(A, c1.id, jpeg()))).includes("SIGNATURE_INVALID") && (await code(() => sign(A, c1.id, png(40, 20)))).includes("SIGNATURE_INVALID"));
  const sig = png(640, 220);
  const s1 = await sign(A, c1.id, sig);
  const irow = (await q(`SELECT "customerSigned" cs, "signedAt" sa, "signatureKey" k, "termsVersion" tv FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c1.id))[0];
  const tvn = Number((await q(`SELECT version FROM "ServiceTextVersion" WHERE id = $1`, T1))[0].version), svn = Number((await q(`SELECT version FROM "ServiceTextVersion" WHERE id = $1`, S1))[0].version);
  ok("S4 signed: customerSigned + signedAt + the content-addressed signature key + termsVersion T{n}-S{m}; the PNG stored; event SIGNED",
    irow.cs === true && irow.sa !== null && String(irow.k) === `biz/${A.b}/service/cases/${c1.id}/intake/signature/${sha(sig)}.png` && irow.tv === `T${tvn}-S${svn}`
      && (await stored(String(irow.k))) && s1.case.version === (await version(c1.id)));
  const after = await Promise.all([code(() => photo(A, c1.id, jpeg())), code(() => sign(A, c1.id)), code(() => record(A, c1.id))]);
  ok("S5 after the signature: a photo, a second signature and new intake data → refused (INTAKE_SIGNED)", after.every((c) => c.includes("INTAKE_SIGNED")), after.join(" | "));
  const sigBack = await readIntakeObject(A.b, c1.id, { kind: "signature" }, store);
  ok("S6 the signature PNG reads back through the intake row", sigBack.contentType === "image/png" && Buffer.compare(sigBack.bytes, sig) === 0);
  const ciReal = await code(async () => runCaseAction(A.p, c1.id, { action: { type: "CHECK_IN", intakeConfirmed: true }, expectedVersion: await version(c1.id) }, { idempotencyKey: key() }));
  const st = String((await q(`SELECT status::text s FROM "ServiceCase" WHERE id = $1`, c1.id))[0].s);
  ok("S7 the case checks in on the owner's confirmation (CHECKED_IN)", ciReal === "OK" && st === "CHECKED_IN", `${ciReal} / ${st}`);
  ok("S8 without the owner's explicit confirmation CHECK_IN is refused (INTAKE_NOT_CONFIRMED)", (await code(async () => runCaseAction(A.p, c3.id, { action: { type: "CHECK_IN" }, expectedVersion: await version(c3.id) }, { idempotencyKey: key() }))) !== "OK");
  const f1 = await openCase(A.p, { kind: "FIELD", customerId: A.cust, problemDescription: "ביקור" }, { idempotencyKey: key() });
  ok("S9 a FIELD case has no shop intake: terms / photo / signature → INTAKE_ONLY_IN_SHOP",
    (await code(() => present(A, f1.case.id))).includes("INTAKE_ONLY_IN_SHOP") && (await code(() => photo(A, f1.case.id, jpeg()))).includes("INTAKE_ONLY_IN_SHOP"));


  console.log("R — review follow-ups (idempotency, case binding, retries, evidence)");
  const c6 = await shopCase(A);
  const k6 = key(), v6 = await version(c6.id);
  await addIntakePhoto(A.p, c6.id, { bytes: jpeg(), declaredMime: "image/jpeg", expectedVersion: v6 }, { idempotencyKey: k6 }, store);
  ok("R1 the same key with another photo → IDEMPOTENCY_KEY_REUSED",
    (await code(() => addIntakePhoto(A.p, c6.id, { bytes: jpeg(), declaredMime: "image/jpeg", expectedVersion: v6 }, { idempotencyKey: k6 }, store))).includes("IDEMPOTENCY_KEY_REUSED"));
  const c6photo = Number((await q(`SELECT id FROM "ServiceIntakePhoto" WHERE "caseId" = $1`, c6.id))[0].id);
  ok("R2 a photo of case X asked for under case Y of the same business → NOT_FOUND", (await code(() => readIntakeObject(A.b, c1.id, { kind: "photo", photoId: c6photo }, store))).startsWith("NOT_FOUND"));
  const pre = jpeg(), preKey = `biz/${A.b}/service/cases/${c6.id}/intake/photos/${sha(pre)}.jpg`;
  await store.putObjectIfAbsent({ key: preKey, body: pre, contentType: "image/jpeg", metadata: { businessId: A.b, domain: "service", visibility: "private" } });
  const before6 = await photos(c6.id);
  ok("R3 an upload that landed before its command failed: the retry reuses the object (EXISTS) and writes one row",
    (await code(() => photo(A, c6.id, pre))) === "OK" && (await photos(c6.id)) === before6 + 1);
  await store.deleteObject(preKey);
  const lost = Number((await q(`SELECT id FROM "ServiceIntakePhoto" WHERE "storageKey" = $1`, preKey))[0].id);
  ok("R4 a row whose object is gone → NOT_FOUND, never a 500", (await code(() => readIntakeObject(A.b, c6.id, { kind: "photo", photoId: lost }, store))).startsWith("NOT_FOUND"));
  const refusedSig = png(600, 200);
  ok("R5 a refused signature (no intake data yet) stores nothing — the preflight decides before any upload",
    (await code(() => sign(A, c6.id, refusedSig))).includes("INTAKE_NOT_RECORDED") && !(await stored(`biz/${A.b}/service/cases/${c6.id}/intake/signature/${sha(refusedSig)}.png`)));
  const signedEv = (await q(`SELECT payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND payload->>'step' = 'SIGNED'`, c1.id))[0].payload as Record<string, unknown>;
  const snap1 = (await q(`SELECT "termsSha256" t, "statutorySha256" s FROM "ServiceIntakeTermsSnapshot" WHERE "caseId" = $1`, c1.id))[0];
  const in1 = (await q(`SELECT "conditionNote" cn, "accessoriesNote" an, "conditionRecorded" cr, "accessoriesRecorded" ar FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c1.id))[0];
  const shas1 = (await q(`SELECT sha256 FROM "ServiceIntakePhoto" WHERE "caseId" = $1`, c1.id)).map((r) => String(r.sha256).trim());
  const expectDigest = intakeDigest({ conditionNote: in1.cn as string, accessoriesNote: in1.an as string, conditionRecorded: in1.cr as boolean, accessoriesRecorded: in1.ar as boolean, photoShas: shas1 });
  ok("R6 the SIGNED event proves on its own: snapshot text hashes, signature hash, and the digest of notes + flags + photo hashes",
    signedEv.termsSha256 === String(snap1.t).trim() && signedEv.statutorySha256 === String(snap1.s).trim() && signedEv.signatureSha256 === sha(sig)
      && signedEv.intakeSha256 === expectDigest && signedEv.photoCount === 10);
  const c7 = await shopCase(A); await record(A, c7.id); await present(A, c7.id);
  const T2 = await text(A, "TERMS", "תנאי שירות מאושרים — גרסה חדשה יותר", true);
  await activate(A, T2, S1);
  const ks7 = key(), sig7 = png(620, 210);
  const s7 = await signIntake(A.p, c7.id, { signaturePng: sig7, expectedVersion: await version(c7.id) }, { idempotencyKey: ks7 }, store);
  const tv7 = String((await q(`SELECT "termsVersion" tv FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c7.id))[0].tv);
  ok("R7 the active terms changed after presentation: the signature binds to the presented snapshot (label from the snapshot, not the new active)",
    tv7 === `T${tvn}-S${svn}` && s7.replayed === false);
  const again = await signIntake(A.p, c7.id, { signaturePng: sig7, expectedVersion: s7.case.version - 1 }, { idempotencyKey: ks7 }, store);
  ok("R8 the same signature request again (same key) → the stored answer (replayed), no second upload decision", again.replayed === true);
  await activate(A, T1, S1);


  console.log("L — the intake slip PDF (1.3b-B)");
  let renders = 0;
  const render = async (html: string) => { renders++; return renderIntakeSlipPdf(html); };
  const slip = async (z: Biz, id: number, k = key()) => createIntakeSlip(z.p, id, { expectedVersion: await version(id) }, { idempotencyKey: k }, { storage: store, render });
  ok("L1 an intake the owner has not confirmed → INTAKE_NOT_CONFIRMED; nothing rendered, nothing stored", (await code(() => slip(A, c3.id))).includes("INTAKE_NOT_CONFIRMED") && renders === 0);
  const before1 = (await q(`SELECT "signedAt" sa, "signatureKey" k, "termsVersion" tv, "updatedAt" ua FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c1.id))[0];
  const kl = key();
  const l1 = await slip(A, c1.id, kl);
  const after1 = (await q(`SELECT "signedAt" sa, "signatureKey" k, "termsVersion" tv, "updatedAt" ua, "slipPdfKey" sk FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c1.id))[0];
  const lev = (await q(`SELECT payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, c1.id))[0].payload as Record<string, unknown>;
  ok("L2 a signed intake → one PDF rendered (Chromium) and stored content-addressed; only slipPdfKey changed on the row; event SLIP_STORED with the PDF hash",
    renders === 1 && typeof l1.slip?.sha256 === "string" && String(after1.sk) === `biz/${A.b}/service/cases/${c1.id}/intake/slip/${l1.slip?.sha256}.pdf`
      && (await stored(String(after1.sk))) && String(before1.sa) === String(after1.sa) && before1.k === after1.k && before1.tv === after1.tv && String(before1.ua) === String(after1.ua)
      && lev.step === "SLIP_STORED" && lev.slipSha256 === l1.slip?.sha256);
  ok("L3 a second slip → SLIP_EXISTS, no render", (await code(() => slip(A, c1.id))).includes("SLIP_EXISTS") && renders === 1);
  const again1 = await createIntakeSlip(A.p, c1.id, { expectedVersion: l1.case.version - 1 }, { idempotencyKey: kl }, { storage: store, render });
  ok("L4 the same key again → the stored answer (replayed), no render", again1.replayed === true && renders === 1);
  const pdf = await readIntakeSlip(A.b, c1.id, store);
  ok("L5 the stored slip reads back through the intake row: a PDF whose hash is its name", pdf.bytes.subarray(0, 5).toString("latin1") === "%PDF-" && sha(pdf.bytes) === l1.slip?.sha256 && pdf.bytes.length > 5000);
  const isoL = await Promise.all([code(() => readIntakeSlip(B.b, c1.id, store)), code(() => createIntakeSlip(B.p, c1.id, { expectedVersion: 1 }, { idempotencyKey: key() }, { storage: store, render }))]);
  ok("L6 business B cannot read or create A's slip → NOT_FOUND", isoL.every((c) => c.startsWith("NOT_FOUND")), isoL.join(" | "));
  const direct2 = await code(() => runtime.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_business_id', $1, true)`, String(A.b));
    await tx.$executeRawUnsafe(`UPDATE "ServiceCaseIntake" SET "slipPdfKey" = $2 WHERE "caseId" = $1`, c1.id, `biz/${A.b}/service/cases/${c1.id}/intake/slip/${"0".repeat(64)}.pdf`);
  }));
  ok("L7 the database refuses replacing a stored slip key, even by the runtime role directly (the intake guard)", direct2 !== "OK", direct2);


  console.log("N — no customer signature: owner-confirmed intake end to end (owner decision 2026-11-11)");
  const cN = await shopCase(A);
  await recordIntake(A.p, cN.id, { conditionNote: "שריטה במסך", accessoriesNote: null, conditionRecorded: true, accessoriesRecorded: true, expectedVersion: await version(cN.id) }, { idempotencyKey: key() });
  await photo(A, cN.id, jpeg());
  const vN0 = await getIntake(A.b, cN.id);
  ok("N1 documented (no accessories handed over) + a photo, no terms, no signature → the owner may confirm; no slip yet",
    vN0.allowed.confirm && !vN0.allowed.createSlip && vN0.confirmation === null && vN0.terms === null && vN0.intake?.signed === false);
  const kN = key(), vNb = await version(cN.id);
  const ciN = await runCaseAction(A.p, cN.id, { action: { type: "CHECK_IN", intakeConfirmed: true }, expectedVersion: vNb }, { idempotencyKey: kN });
  const vN1 = await getIntake(A.b, cN.id);
  ok("N2 the owner's confirmation checks the item in: CHECKED_IN, confirmation by this user with its time, signedAt still empty, no signature object",
    ciN.case.status === "CHECKED_IN" && vN1.confirmation?.byUserId === A.u && typeof vN1.confirmation?.at === "string" && vN1.intake?.signed === false && vN1.intake?.hasSignature === false);
  ok("N3 after the confirmation the intake is closed: no data, no photo, no second confirmation; the slip is offered",
    !vN1.allowed.recordData && !vN1.allowed.addPhoto && !vN1.allowed.confirm && vN1.allowed.createSlip
      && (await code(() => photo(A, cN.id, jpeg()))).includes("INTAKE_ONLY_BEFORE_CHECK_IN"));
  const evBefore = await events(cN.id);
  const replayN = await runCaseAction(A.p, cN.id, { action: { type: "CHECK_IN", intakeConfirmed: true }, expectedVersion: vNb }, { idempotencyKey: kN });
  const second = await code(async () => runCaseAction(A.p, cN.id, { action: { type: "CHECK_IN", intakeConfirmed: true }, expectedVersion: await version(cN.id) }, { idempotencyKey: key() }));
  ok("N7 no double confirmation: the same request replays the stored answer; a new confirmation is refused; nothing more journaled",
    replayN.replayed === true && second !== "OK" && (await events(cN.id)) === evBefore
      && (await n(`SELECT count(*)::int AS n FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND action::text = 'CHECK_IN'`, cN.id)) === 1, second);
  const nHtml = buildIntakeSlipHtml(await loadSlipInput(A.b, cN.id));
  ok("N4 the slip names the confirming user and says no accessories were handed over; no signature, no terms, no image",
    nHtml.includes("הקליטה אושרה") && nHtml.includes("לא נמסרו אביזרים") && !/חתימ|תנאי השירות|<img/.test(nHtml));
  const slN = await slip(A, cN.id);
  const evN = (await q(`SELECT payload FROM "ServiceCaseEvent" WHERE "caseId" = $1 ORDER BY seq DESC LIMIT 1`, cN.id))[0].payload as Record<string, unknown>;
  const pdfN = await readIntakeSlip(A.b, cN.id, store);
  ok("N5 the slip of an unsigned, owner-confirmed intake is rendered once and stored; SLIP_STORED carries the PDF hash and the intake digest",
    typeof slN.slip?.sha256 === "string" && evN.step === "SLIP_STORED" && evN.slipSha256 === slN.slip?.sha256 && /^[0-9a-f]{64}$/.test(String(evN.intakeSha256))
      && pdfN.bytes.subarray(0, 5).toString("latin1") === "%PDF-");
  fs.writeFileSync(process.env.SLIP_OUT ?? "sd13b-slip-sample.pdf", pdfN.bytes);
  const ckEv = (await q(`SELECT "actorUserId" a, "fromStatus"::text f, "toStatus"::text t, payload->>'intakeConfirmed' c FROM "ServiceCaseEvent" WHERE "caseId" = $1 AND action::text = 'CHECK_IN'`, cN.id))[0];
  ok("N6 the audit journal names who confirmed, the status change and the confirmation (no signature data)", Number(ckEv.a) === A.u && ckEv.f === "OPEN" && ckEv.t === "CHECKED_IN" && ckEv.c === "true");
  console.log("O — the intake orphan sweep (library only, not scheduled)");
  const c8 = await shopCase(A); await record(A, c8.id);
  const put = async (k: string, body: Buffer, type: string) => store.putObjectIfAbsent({ key: k, body, contentType: type, metadata: { businessId: A.b, domain: "service", visibility: "private" } });
  const orphanJpg = jpeg(), orphanKey = `biz/${A.b}/service/cases/${c8.id}/intake/photos/${sha(orphanJpg)}.jpg`;
  await put(orphanKey, orphanJpg, "image/jpeg");                       // an upload whose command never wrote its row
  const strangeKey = `biz/${A.b}/service/cases/${c8.id}/notes/readme.txt`;
  await put(strangeKey, Buffer.from("not an intake object"), "text/plain"); // not this sweep's shape
  const linkedPhotoKey = String((await q(`SELECT "storageKey" k FROM "ServiceIntakePhoto" WHERE "caseId" = $1 LIMIT 1`, c1.id))[0].k);
  const linkedSigKey = String((await q(`SELECT "signatureKey" k FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c1.id))[0].k);
  const linkedSlipKey = String((await q(`SELECT "slipPdfKey" k FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c1.id))[0].k);
  const future = new Date(Date.now() + 48 * 3600_000);                  // every object looks two days old
  const young = await sweepIntakeOrphans(A.b, { dryRun: false }, store);
  ok("O1 with the real clock every new object is younger than the grace → nothing deleted, all kept as in flight",
    young.deleted.length === 0 && young.kept.some((k) => k.key === orphanKey && k.reason === "TOO_YOUNG") && (await stored(orphanKey)));
  const dry = await sweepIntakeOrphans(A.b, { now: future }, store);
  ok("O2 dry run (the default) reports the orphan and deletes nothing", dry.dryRun && dry.orphans.includes(orphanKey) && dry.deleted.length === 0 && (await stored(orphanKey)));
  const real = await sweepIntakeOrphans(A.b, { dryRun: false, now: future }, store);
  ok("O3 a real run deletes ONLY the orphan: linked photo, signature and slip kept (LINKED), the foreign-shaped object ignored",
    real.deleted.includes(orphanKey) && !(await stored(orphanKey)) && (await stored(linkedPhotoKey)) && (await stored(linkedSigKey)) && (await stored(linkedSlipKey))
      && [linkedPhotoKey, linkedSigKey, linkedSlipKey].every((k) => real.kept.some((x) => x.key === k && x.reason === "LINKED"))
      && (await stored(strangeKey)) && real.ignored >= 1);
  const lateJpg = jpeg(), lateKey = `biz/${A.b}/service/cases/${c8.id}/intake/photos/${sha(lateJpg)}.jpg`;
  await put(lateKey, lateJpg, "image/jpeg");
  await sweepIntakeOrphans(A.b, { dryRun: false, now: future }, store);   // swept before its command took the lock
  const late = await addIntakePhoto(A.p, c8.id, { bytes: lateJpg, declaredMime: "image/jpeg", expectedVersion: await version(c8.id) }, { idempotencyKey: key() }, store);
  ok("O4 a command whose upload was swept writes it again under the lock: the row and the object both exist (never a dangling row)",
    late.photo?.sha256 === sha(lateJpg) && (await stored(lateKey)) && (await n(`SELECT count(*)::int AS n FROM "ServiceIntakePhoto" WHERE "storageKey" = $1`, lateKey)) === 1);
  const bOrphan = jpeg(), bKey = `biz/${B.b}/service/cases/999999/intake/photos/${sha(bOrphan)}.jpg`;
  await store.putObjectIfAbsent({ key: bKey, body: bOrphan, contentType: "image/jpeg", metadata: { businessId: B.b, domain: "service", visibility: "private" } });
  const aAgain = await sweepIntakeOrphans(A.b, { dryRun: false, now: future }, store);
  const bRun = await sweepIntakeOrphans(B.b, { dryRun: false, now: future }, store);
  ok("O5 a sweep of A never touches B's prefix; in B an object of a case that does not exist is kept (CASE_GONE), not guessed",
    (await stored(bKey)) && !aAgain.deleted.includes(bKey) && bRun.kept.some((k) => k.key === bKey && k.reason === "CASE_GONE"));
  await x(`UPDATE "Business" SET "deletionRequestedAt" = now() WHERE id = $1`, B.b);
  const bDel = await sweepIntakeOrphans(B.b, { dryRun: false, now: future }, store);
  await x(`UPDATE "Business" SET "deletionRequestedAt" = NULL WHERE id = $1`, B.b);
  ok("O6 a business being deleted is skipped entirely (the account erasure owns its prefix)", bDel.skipped === "BUSINESS_DELETING" && bDel.scanned === 0 && (await stored(bKey)));

  const c9 = await shopCase(A);
  const erJpg = jpeg(), erKey = `biz/${A.b}/service/cases/${c9.id}/intake/photos/${sha(erJpg)}.jpg`;
  await put(erKey, erJpg, "image/jpeg");
  await sup.$transaction([sup.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`), sup.$executeRawUnsafe(`UPDATE "ServiceCase" SET "erasedAt" = now() WHERE id = $1`, c9.id)]); // lab fixture: a case under erasure
  const erRun = await sweepIntakeOrphans(A.b, { dryRun: false, now: future }, store);
  ok("O7 an unlinked object of a case being / already erased is kept (CASE_ERASED) — the erasure job owns it", (await stored(erKey)) && erRun.kept.some((k) => k.key === erKey && k.reason === "CASE_ERASED"));

  console.log("V — view");
  const view = await getIntake(A.b, c1.id);
  ok("V1 the view: signed, both frozen bodies + versions, 10 photos, the steps in order (TERMS_PRESENTED, PHOTO_ADDED…, SIGNED, SLIP_STORED)",
    view.intake?.signed === true && view.terms?.termsBody === "תנאי שירות מאושרים — גרסה 2" && view.terms?.statutoryVersion === svn && view.photos.length === 10
      && view.history[0].step === "TERMS_PRESENTED" && view.history.filter((h) => h.step === "PHOTO_ADDED").length === 10 && view.history.some((h) => h.step === "SIGNED") && view.history.at(-1)?.step === "SLIP_STORED"
      && view.activeTerms.approved === true);
  const c4 = await shopCase(A);
  await activate(A, draftT, draftS);
  const v4 = await getIntake(A.b, c4.id);
  ok("V2 an intake with nothing documented allows recording data but not the confirmation", v4.allowed.recordData && !v4.allowed.confirm && !v4.allowed.createSlip);
  ok("V3 a confirmed intake with its slip allows nothing more (no data, photo, confirmation or second slip)", Object.values(view.allowed).every((x) => x === false));
  await activate(A, T1, S1);

  console.log("J — journal payloads");
  const payloads = (await q(`SELECT payload::text p FROM "ServiceCaseEvent" WHERE "businessId" = $1 AND action::text = 'RECORD_INTAKE'`, A.b)).map((r) => String(r.p));
  ok("J1 every intake payload holds tokens / numbers / booleans only — no Hebrew, no text body", payloads.length > 10 && payloads.every((p) => !/[֐-׿]/.test(p) && !p.includes("תנאי")));

  console.log("I — isolation");
  const iso = await Promise.all([
    code(() => getIntake(B.b, c1.id)),
    code(() => presentTerms(B.p, c4.id, { expectedVersion: 1 }, { idempotencyKey: key() })),
    code(() => addIntakePhoto(B.p, c4.id, { bytes: jpeg(), declaredMime: "image/jpeg", expectedVersion: 1 }, { idempotencyKey: key() }, store)),
    code(() => signIntake(B.p, c4.id, { signaturePng: png(600, 200), expectedVersion: 1 }, { idempotencyKey: key() }, store)),
    code(() => readIntakeObject(B.b, c1.id, { kind: "signature" }, store)),
  ]);
  ok("I1 business B: view, present, upload, sign and fetch on A's cases → NOT_FOUND every time", iso.every((c) => c.startsWith("NOT_FOUND")), iso.join(" | "));

  console.log("K — races");
  const c5 = await shopCase(A);
  const pr = await Promise.all([present(A, c5.id), present(A, c5.id)].map((p) => p.then(() => "OK", (e) => (e instanceof ServiceDeskError ? e.code : String(e)))));
  ok("K1 two presentations at once → exactly one snapshot, the other refused / version conflict", (await snapshots(c5.id)) === 1 && pr.filter((r) => r === "OK").length === 1, pr.join(","));
  const kk = key(), jj = jpeg(), vv = await version(c5.id);
  const same = await Promise.all(Array.from({ length: 5 }, () => addIntakePhoto(A.p, c5.id, { bytes: jj, declaredMime: "image/jpeg", expectedVersion: vv }, { idempotencyKey: kk }, store).then(() => "OK", (e) => (e as ServiceDeskError).code)));
  ok("K2 one photo key five times at once → one row, every answer OK (the others replayed)", (await photos(c5.id)) === 1 && same.every((r) => r === "OK"), same.join(","));
  await record(A, c5.id);
  const vs = await version(c5.id);
  const two = await Promise.all([png(600, 200), png(610, 200)].map((b) => signIntake(A.p, c5.id, { signaturePng: b, expectedVersion: vs }, { idempotencyKey: key() }, store).then(() => "OK", (e) => (e as ServiceDeskError).code)));
  const signedKey = String((await q(`SELECT "signatureKey" k FROM "ServiceCaseIntake" WHERE "caseId" = $1`, c5.id))[0].k);
  ok("K3 two signatures at one version → exactly one signs (the other VERSION_CONFLICT / refused); one key on the row", two.filter((r) => r === "OK").length === 1 && signedKey.includes("/intake/signature/"), two.join(","));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  await owner.$disconnect(); await runtime.$disconnect();
  if (failures.length > 0) process.exit(1);
}
main().catch(async (e) => { console.error(e); await owner.$disconnect(); process.exit(1); });
