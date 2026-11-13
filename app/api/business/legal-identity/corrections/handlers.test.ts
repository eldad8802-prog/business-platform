/**
 * Correction request handlers (./handlers.ts) with injected dependencies. No DB, no network.
 *   node_modules/.bin/tsx app/api/business/legal-identity/corrections/handlers.test.ts
 */
import assert from "node:assert/strict";

import { CorrectionError, type CorrectionState } from "@/lib/services/account/legal-identity-correction.service";

import { AttachmentInputError } from "@/lib/services/legal-identity/correction-attachment-storage";

import { handleDelete, handleDownload, handleGet, handlePost, handleUpload, type CorrectionDeps } from "./handlers";

let n = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); n++; } catch (e) { console.error(`FAIL - ${name}`); throw e; }
}
function withCheckDigit(eight: string): string {
  let sum = 0;
  for (let i = 0; i < 8; i++) { let d = Number(eight[i]) * (i % 2 === 0 ? 1 : 2); if (d > 9) d -= 9; sum += d; }
  return eight + String((10 - (sum % 10)) % 10);
}
const A = withCheckDigit("03141592");
const B = withCheckDigit("27182818");
const BAD = B.slice(0, 8) + String((Number(B[8]) + 1) % 10);

const confirmed: CorrectionState = {
  identity: { businessKind: "AUTHORIZED_DEALER", legalName: "דנה כהן", taxId: A },
  verification: "PASSWORD",
  requests: [],
};

type Calls = { verify: unknown[]; submit: unknown[]; cancel: unknown[]; rate: string[]; upload: unknown[]; download: unknown[] };
function deps(over: Partial<CorrectionDeps> = {}, state: CorrectionState = confirmed): { d: CorrectionDeps; calls: Calls } {
  const calls: Calls = { verify: [], submit: [], cancel: [], rate: [], upload: [], download: [] };
  const d: CorrectionDeps = {
    enabled: () => true,
    auth: async () => ({ user: { id: 7, businessId: 3 }, sessionId: "s-1" }),
    rateLimit: async (key) => { calls.rate.push(key); return { allowed: true }; },
    readState: async () => state,
    verify: async (...a) => { calls.verify.push(a); return { method: "PASSWORD", verifiedAt: new Date() }; },
    submit: async (...a) => { calls.submit.push(a); return 41; },
    cancel: async (...a) => { calls.cancel.push(a); return "CANCELLED"; },
    upload: async (...a) => { calls.upload.push(a); return 5; },
    download: async (...a) => { calls.download.push(a); return { body: Buffer.from("%PDF-1.7 x"), mimeType: "application/pdf" }; },
    ...over,
  };
  return { d, calls };
}
const post = (body: unknown) => new Request("http://x/api/business/legal-identity/corrections", { method: "POST", body: JSON.stringify(body) });
const get = () => new Request("http://x/api/business/legal-identity/corrections");
const del = () => new Request("http://x/api/business/legal-identity/corrections/41", { method: "DELETE" });
const good = { requestedBusinessKind: "AUTHORIZED_DEALER", requestedLegalName: "דנה כהן-לוי", requestedTaxId: A, reason: "שגיאת הקלדה בשם בהרשמה", sameLegalEntity: true, password: "pw-secret-1" };

async function main() {
  await check("OFF → 404 for GET, POST and DELETE, and nothing is read", async () => {
    const { d, calls } = deps({ enabled: () => false, auth: async () => { throw new Error("must not authenticate"); } });
    assert.equal((await handleGet(get(), d)).status, 404);
    assert.equal((await handlePost(post(good), d)).status, 404);
    assert.equal((await handleDelete(del(), "41", d)).status, 404);
    assert.equal(calls.submit.length + calls.verify.length + calls.cancel.length, 0);
  });
  await check("no session → 401", async () => {
    const { d } = deps({ auth: async () => null });
    assert.equal((await handleGet(get(), d)).status, 401);
    assert.equal((await handlePost(post(good), d)).status, 401);
    assert.equal((await handleDelete(del(), "41", d)).status, 401);
  });
  await check("GET returns the state for the session's business", async () => {
    const res = await handleGet(get(), deps().d);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).identity.taxId, A);
  });
  await check("POST: valid → 201, kind derived, values normalised, verified BEFORE storing", async () => {
    const order: string[] = [];
    const { d, calls } = deps({
      verify: async () => { order.push("verify"); return { method: "PASSWORD", verifiedAt: new Date() }; },
      submit: async (...a) => { order.push("submit"); calls.submit.push(a); return 41; },
    });
    const res = await handlePost(post({ ...good, requestedLegalName: "  דנה   כהן-לוי ", kind: "BUSINESS_KIND_CHANGE", businessId: 999 }), d);
    assert.equal(res.status, 201);
    const j = await res.json();
    assert.equal(j.kind, "TYPO_CORRECTION");
    assert.deepEqual(order, ["verify", "submit"]);
    const [businessId, userId, c] = calls.submit[0] as [number, number, { requestedLegalName: string }];
    assert.equal(businessId, 3, "the business is the session's, never the body's");
    assert.equal(userId, 7);
    assert.equal(c.requestedLegalName, "דנה כהן-לוי");
  });
  await check("POST: rate limited per user → 429, nothing verified", async () => {
    const { d, calls } = deps({ rateLimit: async () => ({ allowed: false }) });
    assert.equal((await handlePost(post(good), d)).status, 429);
    assert.equal(calls.verify.length, 0);
  });
  await check("POST: identity not confirmed → 409 (edit directly instead)", async () => {
    const { d } = deps({}, { ...confirmed, identity: null });
    const res = await handlePost(post(good), d);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "IDENTITY_NOT_CONFIRMED");
  });
  await check("POST: an open request already exists → 409", async () => {
    const pending = { ...confirmed, requests: [{ status: "PENDING" } as never] };
    const res = await handlePost(post(good), deps({}, pending).d);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "CORRECTION_ALREADY_OPEN");
  });
  await check("POST: individual → company is refused as another entity (400, field), nothing verified", async () => {
    const { d, calls } = deps();
    const res = await handlePost(post({ ...good, requestedBusinessKind: "LTD_COMPANY" }), d);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).field, "requestedBusinessKind");
    assert.equal(calls.verify.length, 0);
  });
  await check("POST: a bad number → 400 naming the field, never repeating the number", async () => {
    const res = await handlePost(post({ ...good, requestedTaxId: BAD }), deps().d);
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.ok(text.includes("requestedTaxId") && !text.includes(BAD));
  });
  await check("POST: wrong password → 403, nothing stored", async () => {
    const { d, calls } = deps({ verify: async () => { throw new CorrectionError("WRONG_PASSWORD", 403); } });
    const res = await handlePost(post(good), d);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "WRONG_PASSWORD");
    assert.equal(calls.submit.length, 0);
  });
  await check("POST: Google-only account not recently signed in → 403 SIGN_IN_AGAIN", async () => {
    const res = await handlePost(post({ ...good, password: undefined }), deps({ verify: async () => { throw new CorrectionError("SIGN_IN_AGAIN", 403); } }).d);
    assert.equal((await res.json()).code, "SIGN_IN_AGAIN");
  });
  await check("POST: the database refuses a second open request (race) → 409", async () => {
    const res = await handlePost(post(good), deps({ submit: async () => { throw new CorrectionError("CORRECTION_ALREADY_OPEN", 409); } }).d);
    assert.equal(res.status, 409);
  });
  await check("POST: an unexpected error → 500 without details", async () => {
    const res = await handlePost(post(good), deps({ submit: async () => { throw new Error(`boom ${A}`); } }).d);
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes(A));
  });
  await check("POST: a different tax id for the same entity is a typo correction (allowed)", async () => {
    const res = await handlePost(post({ ...good, requestedLegalName: "דנה כהן", requestedTaxId: B }), deps().d);
    assert.equal(res.status, 201);
  });
  await check("DELETE: cancelled / not pending / not found / bad id", async () => {
    assert.equal((await handleDelete(del(), "41", deps().d)).status, 200);
    assert.equal((await handleDelete(del(), "41", deps({ cancel: async () => "NOT_PENDING" }).d)).status, 409);
    assert.equal((await handleDelete(del(), "41", deps({ cancel: async () => "NOT_FOUND" }).d)).status, 404);
    const { d, calls } = deps();
    assert.equal((await handleDelete(del(), "abc", d)).status, 404);
    assert.equal(calls.cancel.length, 0);
  });
  // ---- attachments
  const PDF = Buffer.from("%PDF-1.7 " + "x".repeat(50));
  const upload = (file?: Blob, name = "doc.pdf", headers: Record<string, string> = {}) => {
    const fd = new FormData();
    if (file) fd.append("file", file, name);
    return new Request("http://x/api/business/legal-identity/corrections/41/attachments", { method: "POST", body: fd, headers });
  };
  const dl = () => new Request("http://x/api/business/legal-identity/corrections/41/attachments/5");
  await check("attachments OFF → 404 for upload and download, nothing read", async () => {
    const { d, calls } = deps({ enabled: () => false });
    assert.equal((await handleUpload(upload(new Blob([PDF], { type: "application/pdf" })), "41", d)).status, 404);
    assert.equal((await handleDownload(dl(), "41", "5", d)).status, 404);
    assert.equal(calls.upload.length + calls.download.length, 0);
  });
  await check("attachments without a session → 401", async () => {
    const { d } = deps({ auth: async () => null });
    assert.equal((await handleUpload(upload(new Blob([PDF], { type: "application/pdf" })), "41", d)).status, 401);
    assert.equal((await handleDownload(dl(), "41", "5", d)).status, 401);
  });
  await check("upload → 201; the session business and user, the real bytes and the declared type reach the service", async () => {
    const { d, calls } = deps();
    const res = await handleUpload(upload(new Blob([PDF], { type: "application/pdf" })), "41", d);
    assert.equal(res.status, 201);
    const [businessId, userId, requestId, file] = calls.upload[0] as [number, number, number, { mimeType: string; body: Buffer }];
    assert.deepEqual([businessId, userId, requestId], [3, 7, 41]);
    assert.equal(file.mimeType, "application/pdf");
    assert.ok(file.body.equals(PDF));
    assert.ok(calls.rate.includes("legal-identity-attachment:7"), "uploads have their own rate-limit key");
  });
  await check("upload: bad request id → 404; no file → 400; rate limited → 429", async () => {
    assert.equal((await handleUpload(upload(new Blob([PDF])), "x", deps().d)).status, 404);
    assert.equal((await handleUpload(upload(), "41", deps().d)).status, 400);
    assert.equal((await handleUpload(upload(new Blob([PDF])), "41", deps({ rateLimit: async () => ({ allowed: false }) }).d)).status, 429);
  });
  await check("upload: a declared body over the limit is refused unread (413)", async () => {
    const { d, calls } = deps();
    const res = await handleUpload(upload(new Blob([PDF]), "doc.pdf", { "content-length": String(11 * 1024 * 1024) }), "41", d);
    assert.equal(res.status, 413);
    assert.equal(calls.upload.length, 0);
  });
  await check("upload: invalid content → 400 / too large → 413 / limit → 409 / not pending → 409", async () => {
    const mk = (e: Error) => deps({ upload: async () => { throw e; } }).d;
    const file = () => upload(new Blob([PDF], { type: "application/pdf" }));
    assert.equal((await handleUpload(file(), "41", mk(new AttachmentInputError("CONTENT_MISMATCH", "x")))).status, 400);
    assert.equal((await handleUpload(file(), "41", mk(new AttachmentInputError("TOO_LARGE", "x")))).status, 413);
    const lim = await handleUpload(file(), "41", mk(new CorrectionError("ATTACHMENT_LIMIT", 409)));
    assert.equal(lim.status, 409);
    assert.equal((await lim.json()).code, "ATTACHMENT_LIMIT");
    assert.equal((await handleUpload(file(), "41", mk(new CorrectionError("NOT_PENDING", 409)))).status, 409);
  });
  await check("download: always an attachment, nosniff, sandboxed, no-store; the session business is the scope", async () => {
    const { d, calls } = deps();
    const res = await handleDownload(dl(), "41", "5", d);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="correction-41-5.pdf"$/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.deepEqual(calls.download[0], [3, 41, 5]);
  });
  await check("download: unknown or foreign attachment → 404; bad ids → 404 without a lookup", async () => {
    assert.equal((await handleDownload(dl(), "41", "5", deps({ download: async () => null }).d)).status, 404);
    const { d, calls } = deps();
    assert.equal((await handleDownload(dl(), "41", "-1", d)).status, 404);
    assert.equal(calls.download.length, 0);
  });
  console.log(`handlers.test.ts: ok (${n} checks)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
