/**
 * Admin legal-identity correction handlers (./handlers.ts) with injected dependencies, plus the route files' guard
 * order. No DB, no network.
 *   node_modules/.bin/tsx app/api/platform-admin/legal-identity-corrections/handlers.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { UserRole } from "@prisma/client";
import { NextResponse } from "next/server";

import type { PlatformAdminUser } from "@/lib/auth/platform-admin";
import { PLATFORM_AUDIT_ACTIONS } from "@/lib/services/platform-admin/constants";
import type { CorrectionDetail } from "@/lib/services/platform-admin/legal-identity-corrections.service";

import {
  handleAttachment,
  handleDecision,
  handleDetail,
  handleList,
  handleRequestInfo,
  type AuditInput,
  type CorrectionAdminDeps,
} from "./handlers";

let n = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); n++; } catch (e) { console.error(`FAIL - ${name}`); throw e; }
}

const admin: PlatformAdminUser = { id: 900, email: "approver@dubiz.invalid", name: "מאשרת", role: UserRole.PLATFORM_ADMIN };
const TAX_A = "000000018";

const detail: CorrectionDetail = {
  id: 41, businessId: 3, businessName: "מאפיית דנה", kind: "TYPO_CORRECTION", status: "PENDING",
  current: { businessKind: "AUTHORIZED_DEALER", legalName: "דנה כהן", taxId: TAX_A },
  requested: { businessKind: "AUTHORIZED_DEALER", legalName: "דנה כהן-לוי", taxId: TAX_A },
  reason: "טעות הקלדה בשם המשפטי בהרשמה", sameLegalEntity: true,
  verification: { method: "PASSWORD", at: new Date().toISOString() },
  requester: { userId: 7, name: "דנה", email: "dana@lab.invalid", emailVerified: true },
  publicNote: null, internalNote: null, infoRequestedAt: null, infoRequestNote: null,
  decidedByUserId: null, decidedAt: null, createdAt: new Date().toISOString(), anonymised: false,
  attachments: [{ id: 5, mimeType: "application/pdf", sizeBytes: 1200, sha256: "a".repeat(64), createdAt: new Date().toISOString() }],
};

type Calls = { audit: AuditInput[]; decide: unknown[]; requestInfo: unknown[]; read: unknown[] };
function deps(over: Partial<CorrectionAdminDeps> = {}): { d: CorrectionAdminDeps; calls: Calls } {
  const calls: Calls = { audit: [], decide: [], requestInfo: [], read: [] };
  const d: CorrectionAdminDeps = {
    enabled: () => true,
    isApprover: () => true,
    freshStepUp: () => null,
    list: async () => [],
    detail: async (id) => (id === 41 ? detail : null),
    attachment: async (r, a) => (r === 41 && a === 5 ? { businessId: 3, storageKey: "biz/3/legal-identity/41/x.pdf", mimeType: "application/pdf" } : null),
    readAttachment: async (i) => { calls.read.push(i); return { body: Buffer.from("%PDF-1.4"), contentType: "application/pdf" }; },
    decide: async (i) => { calls.decide.push(i); return "APPLIED"; },
    requestInfo: async (i) => { calls.requestInfo.push(i); return "REQUESTED"; },
    audit: async (i) => { calls.audit.push(i); },
    ...over,
  };
  return { d, calls };
}
const post = (body: unknown) => new Request("http://x/api/platform-admin/legal-identity-corrections/41/decision", { method: "POST", body: JSON.stringify(body) });
const get = (q = "") => new Request(`http://x/api/platform-admin/legal-identity-corrections${q}`);
const goodDecision = { approve: true, publicNote: "התיקון אושר", internalNote: "נבדק מול תעודת עוסק מורשה", confirmedReview: true };
const json = async (r: NextResponse) => (await r.json()) as Record<string, unknown>;

async function main() {
  // ---- the gate: flag, dedicated permission
  await check("flag off → 404 on every handler, nothing read, nothing audited", async () => {
    const { d, calls } = deps({ enabled: () => false });
    for (const r of [
      await handleList(get(), admin, d),
      await handleDetail(get("/41"), admin, "41", d),
      await handleAttachment(get("/41/attachments/5"), admin, "41", "5", d),
      await handleDecision(post(goodDecision), admin, "41", d),
      await handleRequestInfo(post({ note: "נא לצרף תעודה" }), admin, "41", d),
    ]) assert.equal(r.status, 404);
    assert.equal(calls.audit.length + calls.decide.length + calls.requestInfo.length + calls.read.length, 0);
  });
  await check("admin WITHOUT the dedicated permission → 403 LEGAL_IDENTITY_APPROVER_REQUIRED everywhere", async () => {
    const { d, calls } = deps({ isApprover: () => false });
    for (const r of [
      await handleList(get(), admin, d),
      await handleDetail(get("/41"), admin, "41", d),
      await handleAttachment(get("/41/attachments/5"), admin, "41", "5", d),
      await handleDecision(post(goodDecision), admin, "41", d),
      await handleRequestInfo(post({ note: "נא לצרף תעודה" }), admin, "41", d),
    ]) {
      assert.equal(r.status, 403);
      assert.equal((await json(r)).code, "LEGAL_IDENTITY_APPROVER_REQUIRED");
    }
    assert.equal(calls.decide.length + calls.requestInfo.length + calls.read.length, 0);
  });

  // ---- reads
  await check("list: audited as a view, OPEN by default, ?filter=all → ALL", async () => {
    const seen: string[] = [];
    const { d, calls } = deps({ list: async (f) => { seen.push(f); return []; } });
    assert.equal((await handleList(get(), admin, d)).status, 200);
    assert.equal((await handleList(get("?filter=all"), admin, d)).status, 200);
    assert.deepEqual(seen, ["OPEN", "ALL"]);
    assert.equal(calls.audit[0].action, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTIONS_LIST_VIEWED);
  });
  await check("detail: full request, audited with ids only (no name, no number in metadata)", async () => {
    const { d, calls } = deps();
    const r = await handleDetail(get("/41"), admin, "41", d);
    assert.equal(r.status, 200);
    assert.equal(((await json(r)).request as CorrectionDetail).requested.legalName, "דנה כהן-לוי");
    assert.equal(calls.audit[0].action, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_VIEWED);
    const meta = JSON.stringify(calls.audit[0].metadata);
    assert.ok(!meta.includes(TAX_A) && !meta.includes("דנה"), meta);
  });
  await check("detail: bad id → 400; unknown → 404 (no audit)", async () => {
    const { d, calls } = deps();
    assert.equal((await handleDetail(get("/x"), admin, "abc", d)).status, 400);
    assert.equal((await handleDetail(get("/99"), admin, "99", d)).status, 404);
    assert.equal(calls.audit.length, 0);
  });
  await check("attachment: streamed as a download with nosniff, audited; unknown → 404", async () => {
    const { d, calls } = deps();
    const r = await handleAttachment(get("/41/attachments/5"), admin, "41", "5", d);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(calls.audit[0].action, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_ATTACHMENT_VIEWED);
    assert.equal((await handleAttachment(get("/41/attachments/6"), admin, "41", "6", d)).status, 404);
  });

  // ---- decision
  await check("decision requires a FRESH step-up: refused before anything is read or decided", async () => {
    const refusal = NextResponse.json({ code: "ADMIN_MFA_REQUIRED", fresh: true }, { status: 403 });
    const { d, calls } = deps({ freshStepUp: () => refusal });
    const r = await handleDecision(post(goodDecision), admin, "41", d);
    assert.equal(r.status, 403);
    assert.equal((await json(r)).code, "ADMIN_MFA_REQUIRED");
    assert.equal(calls.decide.length, 0);
    const r2 = await handleRequestInfo(post({ note: "נא לצרף תעודה" }), admin, "41", d);
    assert.equal(r2.status, 403);
    assert.equal(calls.requestInfo.length, 0);
  });
  await check("decision: both notes are required, for approve AND reject", async () => {
    const { d, calls } = deps();
    for (const body of [
      { ...goodDecision, publicNote: "" },
      { ...goodDecision, internalNote: "abc" },
      { approve: false, publicNote: "נדחה", internalNote: "" },
      { approve: false, publicNote: "", internalNote: "פנימי ארוך" },
    ]) {
      const r = await handleDecision(post(body), admin, "41", d);
      assert.equal(r.status, 400);
      assert.equal((await json(r)).code, "NOTE_REQUIRED");
    }
    assert.equal(calls.decide.length, 0);
  });
  await check("approval needs the explicit review confirmation; rejection does not", async () => {
    const { d, calls } = deps();
    const r = await handleDecision(post({ ...goodDecision, confirmedReview: false }), admin, "41", d);
    assert.equal(r.status, 400);
    assert.equal((await json(r)).code, "CONFIRMATION_REQUIRED");
    assert.equal(calls.decide.length, 0);
    const { d: d2 } = deps({ decide: async () => "REJECTED" });
    assert.equal((await handleDecision(post({ approve: false, publicNote: "חסר מסמך", internalNote: "אין תעודה" }), admin, "41", d2)).status, 200);
  });
  await check("approve: decided in the request's OWN business, as the session admin; audited APPROVED", async () => {
    const { d, calls } = deps();
    const r = await handleDecision(post(goodDecision), admin, "41", d);
    assert.equal(r.status, 200);
    assert.deepEqual(calls.decide[0], { businessId: 3, requestId: 41, approverUserId: 900, approve: true, publicNote: "התיקון אושר", internalNote: "נבדק מול תעודת עוסק מורשה" });
    assert.equal(calls.audit.at(-1)?.action, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_APPROVED);
    const meta = JSON.stringify(calls.audit.at(-1)?.metadata);
    assert.ok(!meta.includes("נבדק") && !meta.includes(TAX_A), "notes and values never reach the audit metadata");
  });
  await check("the approver id is the session's, never the body's", async () => {
    const { d, calls } = deps();
    await handleDecision(post({ ...goodDecision, approverUserId: 1, businessId: 99 }), admin, "41", d);
    assert.equal((calls.decide[0] as { approverUserId: number }).approverUserId, 900);
    assert.equal((calls.decide[0] as { businessId: number }).businessId, 3);
  });
  await check("database outcomes map to statuses and audit actions: STALE 409, NOT_PENDING 409, NOT_ALLOWED 403, NOT_FOUND 404", async () => {
    const cases: [string, number, string][] = [
      ["STALE", 409, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_STALE],
      ["NOT_PENDING", 409, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REFUSED],
      ["DECLARATION_ACTIVE", 409, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REFUSED],
      ["NOT_ALLOWED", 403, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REFUSED],
      ["NOT_FOUND", 404, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REFUSED],
      ["REJECTED", 200, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_REJECTED],
    ];
    for (const [outcome, status, action] of cases) {
      const { d, calls } = deps({ decide: async () => outcome as never });
      const r = await handleDecision(post(goodDecision), admin, "41", d);
      assert.equal(r.status, status, outcome);
      assert.equal((await json(r)).outcome, outcome);
      assert.equal(calls.audit.at(-1)?.action, action, outcome);
    }
  });
  await check("decision on an unknown request → 404 before the database is asked", async () => {
    const { d, calls } = deps();
    assert.equal((await handleDecision(post(goodDecision), admin, "99", d)).status, 404);
    assert.equal(calls.decide.length, 0);
  });
  await check("approve must be a boolean", async () => {
    const { d } = deps();
    assert.equal((await handleDecision(post({ ...goodDecision, approve: "yes" }), admin, "41", d)).status, 400);
  });

  // ---- request info
  await check("request-info: note required; decided in the request's business; audited INFO_REQUESTED", async () => {
    const { d, calls } = deps();
    assert.equal((await handleRequestInfo(post({ note: "x" }), admin, "41", d)).status, 400);
    const r = await handleRequestInfo(post({ note: "נא לצרף תעודת עוסק" }), admin, "41", d);
    assert.equal(r.status, 200);
    assert.deepEqual(calls.requestInfo[0], { businessId: 3, requestId: 41, approverUserId: 900, note: "נא לצרף תעודת עוסק" });
    assert.equal(calls.audit.at(-1)?.action, PLATFORM_AUDIT_ACTIONS.LEGAL_IDENTITY_CORRECTION_INFO_REQUESTED);
  });

  // ---- route files: the guard is the first await and its refusal is returned at once (AST-5 / CI-3)
  await check("every route file calls requirePlatformAdminOrResponse first and returns its refusal", () => {
    const base = path.join(process.cwd(), "app/api/platform-admin/legal-identity-corrections");
    for (const rel of ["route.ts", "[id]/route.ts", "[id]/attachments/[attachmentId]/route.ts", "[id]/decision/route.ts", "[id]/request-info/route.ts"]) {
      const src = readFileSync(path.join(base, rel), "utf8");
      const body = src.slice(src.indexOf("export async function"));
      const firstAwait = body.indexOf("await ");
      assert.ok(body.slice(firstAwait).startsWith("await requirePlatformAdminOrResponse(req)"), `${rel}: guard is not the first await`);
      assert.match(body, /const auth = await requirePlatformAdminOrResponse\(req\);\s*if \(auth instanceof NextResponse\) return auth;/, rel);
    }
  });

  console.log(`legal-identity-corrections admin handlers.test.ts: ok (${n} checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
