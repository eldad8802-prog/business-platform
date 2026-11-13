/**
 * Correction request handlers (./handlers.ts) with injected dependencies. No DB, no network.
 *   node_modules/.bin/tsx app/api/business/legal-identity/corrections/handlers.test.ts
 */
import assert from "node:assert/strict";

import { CorrectionError, type CorrectionState } from "@/lib/services/account/legal-identity-correction.service";

import { handleDelete, handleGet, handlePost, type CorrectionDeps } from "./handlers";

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

type Calls = { verify: unknown[]; submit: unknown[]; cancel: unknown[]; rate: string[] };
function deps(over: Partial<CorrectionDeps> = {}, state: CorrectionState = confirmed): { d: CorrectionDeps; calls: Calls } {
  const calls: Calls = { verify: [], submit: [], cancel: [], rate: [] };
  const d: CorrectionDeps = {
    enabled: () => true,
    auth: async () => ({ user: { id: 7, businessId: 3 }, sessionId: "s-1" }),
    rateLimit: async (key) => { calls.rate.push(key); return { allowed: true }; },
    readState: async () => state,
    verify: async (...a) => { calls.verify.push(a); return { method: "PASSWORD", verifiedAt: new Date() }; },
    submit: async (...a) => { calls.submit.push(a); return 41; },
    cancel: async (...a) => { calls.cancel.push(a); return "CANCELLED"; },
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
  console.log(`handlers.test.ts: ok (${n} checks)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
