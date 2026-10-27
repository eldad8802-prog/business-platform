/**
 * Monthly accountant workflow — G4 end to end, on the Production-shaped lab (app_runtime_prod, NOBYPASSRLS),
 * migrations 20261027 + 20261105 applied. The REAL services, routes and Resend adapter; the network is a
 * Resend emulator (fetch) that, like Resend, sends a message once per Idempotency-Key. Nothing leaves the box.
 *
 *   ready package → owner notice → owner review (view) → explicit approval → secure send → portal opened →
 *   file viewed / downloaded → the owner sees it all → revoke / expiry.
 *
 *   1. Preparation and the owner's notice; the owner's view of the month.
 *   2. Recipient: missing, invalid, unconfirmed, a stale screen; another business cannot touch it.
 *   3. Approval: refused with the switch off, without a recipient, without the D2 acknowledgement.
 *   4. Double click (same key) and concurrent approvals → one send; concurrent attempts → one provider call.
 *   5. Provider 503 → retry on schedule with the SAME idempotency key → accepted; one message at the provider.
 *   6. No answer (timeout) on every attempt → FAILED and flagged UNCERTAIN; the provider still holds ONE message
 *      (every retry reused the key); the owner is told a copy may have arrived.
 *   7. Provider refusal (422) → FAILED, not uncertain; the month is SEND_FAILED with its failure notice.
 *   8. The accountant opens the portal, views a file, downloads the ZIP → the owner's view shows it, exactly.
 *   9. Revoke (route) → the link is dead everywhere; expiry → the owner sees "expired".
 *  10. Isolation: another business sees none of it and cannot revoke it; a business without the feature → 404.
 *  11. Nothing changed: package rows, stored ZIPs and source documents are byte-identical; no other network.
 *
 * env: OWNER_URL, DATABASE_URL, DIRECT_URL. Synthetic only. ZERO real network.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Production runs in UTC; the workbook's date cells follow the process time zone (a known, separate issue).
process.env.TZ = "UTC";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-g4-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
process.env.RATE_LIMIT_BACKEND = "memory";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type Json = Record<string, unknown>;

// ── The Resend emulator ─────────────────────────────────────────────────────────────────────────
type Mode = "sent" | "503" | "422" | "timeout";
let mode: Mode = "sent";
const calls: { key: string; to: string; text: string }[] = [];
const messages = new Map<string, string>(); // Idempotency-Key → message id: the provider sends once per key
let otherNetwork = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.resend.com/")) { otherNetwork++; throw new Error("no network"); }
  const key = String((init?.headers as Record<string, string>)["Idempotency-Key"]);
  const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
  calls.push({ key, to: body.to[0], text: body.text });
  const accept = () => { if (!messages.has(key)) messages.set(key, `msg_lab_${messages.size + 1}`); };
  if (mode === "timeout") { accept(); const e = new Error("The operation timed out"); e.name = "TimeoutError"; throw e; } // it got it; we never hear
  if (mode === "503") return new Response(JSON.stringify({ name: "internal_server_error" }), { status: 503 });
  if (mode === "422") return new Response(JSON.stringify({ name: "validation_error" }), { status: 422 });
  accept();
  return new Response(JSON.stringify({ id: messages.get(key) }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { getStorageService } = await import("@/lib/storage");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const { signAuthToken } = await import("@/lib/auth-token");
  const prep = await import("@/lib/accountant/prepare.service");
  const del = await import("@/lib/accountant/delivery.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const { syncPeriodNotice } = await import("@/lib/accountant/notify");
  const { getPeriodView } = await import("@/lib/accountant/view.service");
  const periodRoute = await import("@/app/api/accountant/periods/[periodKey]/route");
  const deliveriesRoute = await import("@/app/api/accountant/periods/[periodKey]/deliveries/route");
  const recipientRoute = await import("@/app/api/accountant/recipient/route");
  const revokeRoute = await import("@/app/api/accountant/deliveries/[deliveryId]/revoke/route");
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
  const originals: { key: string; sha: string }[] = [];
  let n = 0;
  const business = async (name: string, enabled = true) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}-${b}@g4.lab`, b);
    if (enabled) await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingTaxId", "updatedAt") VALUES ($1, $2, '515151515', now())`, b, `${name} בע"מ`);
    for (const [day, vendor, status] of [["05", "חברת החשמל", "approved"], ["12", "Office Depot ישראל", "approved"], ["20", "", "needs_review"]] as const) {
      const body = Buffer.from(`%PDF-1.4 g4 ${name} ${++n}`);
      const basename = `doc-${Date.now()}${n}-g4.pdf`;
      await putDocumentObject({ businessId: b, basename, body, contentType: "application/pdf", source: "file" });
      const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt", "contentHashSha256") VALUES ($1, $2, 'file', 'application/pdf', $3, $4::timestamp, $5) RETURNING "id"`,
        b, basename, status, `2026-09-${day}T08:00:00`, sha(body));
      originals.push({ key: basename, sha: sha(body) });
      if (status === "approved") await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, 120.5, $3::timestamp, $4, 'expense', 'general')`, d, b, `2026-09-${day}T00:00:00`, vendor);
    }
    return { b, u, token: signAuthToken(u, 0) };
  };
  const inB = <T>(b: number, fn: () => Promise<T>) => runWithTenantContext({ businessId: b }, fn);
  const prepare = (x: { b: number }, at: Date) =>
    inB(x.b, () => prep.preparePeriod({ businessId: x.b, periodKey: KEY, trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, { ...prep.defaultPrepareDeps, now: () => at }));
  const recipient = (x: { b: number; u: number }, at: Date, expectedVersion: number | null = null) =>
    inB(x.b, () => setRecipient({ businessId: x.b, userId: x.u, name: "רו\"ח דנה", email: "dana@example.com", expectedVersion, confirm: true, now: at }));
  const pkgOf = (b: number) => owner.accountantPackage.findFirstOrThrow({ where: { businessId: b, status: "READY" } });
  const approve = async (x: { b: number; u: number }, at: Date, key = `send:g4-${x.b}-${Math.random().toString(36).slice(2)}`) => {
    const p = await pkgOf(x.b);
    const rc = await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: x.b } });
    return inB(x.b, () => del.approveDelivery({ businessId: x.b, userId: x.u, periodKey: KEY, packageId: p.id, packageSha256: p.sha256!, recipientVersion: rc.version,
      recipientEmail: rc.email, acknowledgeIncomplete: true, idempotencyKey: key, now: at }));
  };
  const throwsCode = async (fn: () => Promise<unknown>, code: string) => { try { await fn(); return false; } catch (e) { return (e as { code?: string }).code === code; } };
  const req = (url: string, token: string | null, init: RequestInit = {}) =>
    new Request(`https://app.example.com${url}`, { ...init, headers: { ...(init.headers as Record<string, string>), ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-forwarded-for": `198.51.100.${(++n % 200) + 1}` } });
  const viewOf = async (token: string | null) => periodRoute.GET(req(`/api/accountant/periods/${KEY}`, token), { params: Promise.resolve({ periodKey: KEY }) });
  const delivery = (id: number) => owner.accountantDelivery.findUniqueOrThrow({ where: { id } });
  const now = new Date();

  const A = await business("מאפיית הלב");
  const B = await business("acct-g4-B");
  const E = await business("acct-g4-E");   // no answer from the provider
  const F = await business("acct-g4-F");   // refused by the provider
  const X = await business("acct-g4-X");   // approved 20 days ago → expired link
  const D = await business("acct-g4-D", false);
  for (const x of [A, B, E, F]) await prepare(x, now);
  await prepare(X, new Date(now.getTime() - 20 * 86400_000));

  const snapshot = async () => {
    const pkgs = await owner.accountantPackage.findMany({ where: { businessId: { in: [A.b, B.b, E.b, F.b, X.b] } }, orderBy: { id: "asc" } });
    const zips = await Promise.all(pkgs.filter((p) => p.storageKey).map(async (p) => sha((await storage.getObject(p.storageKey!)).body)));
    const docs = await owner.document.findMany({ where: { businessId: { in: [A.b, B.b, E.b, F.b, X.b] } }, select: { id: true, status: true, contentHashSha256: true, fileUrl: true }, orderBy: { id: "asc" } });
    return JSON.stringify({ pkgs: pkgs.map((p) => [p.id, p.status, p.version, p.sha256, p.storageKey, p.sizeBytes, p.contentFingerprint]), zips, docs });
  };
  const before = await snapshot();

  // ── 1. Preparation, notice, the owner's view ───────────────────────────────────────────────────
  console.log("1. preparation, notice, the owner's view");
  const periodA = await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: A.b, periodKey: KEY } });
  await inB(A.b, () => syncPeriodNotice(periodA, now));
  const notices = await owner.notification.findMany({ where: { businessId: A.b, resolvedAt: null } });
  ok("1a the owner has one live notice for the month, linking to it", notices.length === 1 && notices[0].href === `/documents/accountant-pack?period=${KEY}`, JSON.stringify(notices.map((x) => x.href)));
  let r = await viewOf(A.token);
  let v = ((await r.json()) as { period: Json & { currentPackage: Json; openItems: number; deliveries: unknown[]; recipient: unknown; sendingAvailable: boolean } }).period;
  ok("1b the owner's view: a sealed package, its open item listed, no recipient yet, sending available", r.status === 200 && !!v.currentPackage && v.status === "NEEDS_ATTENTION" && v.openItems >= 1 && v.recipient === null && v.sendingAvailable === true, JSON.stringify({ s: v.status, o: v.openItems }));
  ok("1c no session → 401; a business without the feature → 404", (await viewOf(null)).status === 401 && (await viewOf(D.token)).status === 404);

  // ── 2. Recipient ───────────────────────────────────────────────────────────────────────────────
  console.log("2. recipient");
  const put = (token: string | null, body: Json) => recipientRoute.PUT(req("/api/accountant/recipient", token, { method: "PUT", body: JSON.stringify(body) }));
  const code = async (res: Response) => ({ s: res.status, e: ((await res.json().catch(() => ({}))) as Json).error });
  const post = (token: string | null, body: Json, key: string | null) =>
    deliveriesRoute.POST(req(`/api/accountant/periods/${KEY}/deliveries`, token, { method: "POST", body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {} }), { params: Promise.resolve({ periodKey: KEY }) });
  const pA = await pkgOf(A.b);
  let c = await code(await post(A.token, { packageId: pA.id, packageSha256: pA.sha256, recipientVersion: 1, recipientEmail: "dana@example.com", acknowledgeIncomplete: true }, "send:g4-no-recipient-01"));
  ok("2a approving with no recipient → 409 RECIPIENT_MISSING", c.s === 409 && c.e === "RECIPIENT_MISSING", JSON.stringify(c));
  c = await code(await put(A.token, { name: "רו\"ח דנה", email: "not-an-email", expectedVersion: null, confirm: true }));
  ok("2b an invalid address → 400 INVALID_EMAIL", c.s === 400 && c.e === "INVALID_EMAIL", JSON.stringify(c));
  c = await code(await put(A.token, { name: "רו\"ח דנה", email: "dana@example.com", expectedVersion: null }));
  ok("2c without the explicit confirmation → 400 CONFIRMATION_REQUIRED", c.s === 400 && c.e === "CONFIRMATION_REQUIRED", JSON.stringify(c));
  c = await code(await put(null, { name: "x", email: "x@example.com", expectedVersion: null, confirm: true }));
  ok("2d no session → 401", c.s === 401);
  c = await code(await put(D.token, { name: "x", email: "x@example.com", expectedVersion: null, confirm: true }));
  ok("2e a business without the feature → 404", c.s === 404);
  r = await put(A.token, { name: "רו\"ח דנה", email: "Dana@Example.com", expectedVersion: null, confirm: true });
  ok("2f set with confirmation: stored normalised, version 1", r.status === 200 && (await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: A.b } })).email === "dana@example.com");
  c = await code(await put(A.token, { name: "רו\"ח אחר", email: "other@example.com", expectedVersion: null, confirm: true }));
  ok("2g a stale screen cannot overwrite it → 409 RECIPIENT_CHANGED_ELSEWHERE", c.s === 409 && c.e === "RECIPIENT_CHANGED_ELSEWHERE", JSON.stringify(c));
  await put(B.token, { name: "רו\"ח של ב", email: "b-cpa@example.com", expectedVersion: null, confirm: true });
  ok("2h another business setting ITS recipient never touches this one", (await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: A.b } })).email === "dana@example.com" &&
    (await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: B.b } })).email === "b-cpa@example.com");
  for (const x of [E, F, X]) await recipient(x, x === X ? new Date(now.getTime() - 20 * 86400_000) : now);

  // ── 3. Approval refusals ───────────────────────────────────────────────────────────────────────
  console.log("3. approval refusals");
  const sendBody = (p: { id: number; sha256: string | null }, ack: boolean) => ({ packageId: p.id, packageSha256: p.sha256, recipientVersion: 1, recipientEmail: "dana@example.com", acknowledgeIncomplete: ack });
  c = await code(await post(A.token, sendBody(pA, false), "send:g4-no-ack-0001"));
  ok("3a an incomplete package without the D2 acknowledgement → 409 INCOMPLETE_NOT_ACKNOWLEDGED", c.s === 409 && c.e === "INCOMPLETE_NOT_ACKNOWLEDGED", JSON.stringify(c));
  c = await code(await post(A.token, sendBody(pA, true), null));
  ok("3b no Idempotency-Key → 400", c.s === 400 && c.e === "IDEMPOTENCY_KEY_REQUIRED", JSON.stringify(c));
  c = await code(await post(A.token, { ...sendBody(pA, true), recipientEmail: "someone-else@example.com" }, "send:g4-wrong-to-01"));
  ok("3c an address other than the stored one → 409 RECIPIENT_CHANGED", c.s === 409 && c.e === "RECIPIENT_CHANGED", JSON.stringify(c));
  delete process.env.ACCOUNTANT_DELIVERY_ENABLED;
  c = await code(await post(A.token, sendBody(pA, true), "send:g4-switch-off-01"));
  ok("3d the platform switch off → 403 DELIVERY_DISABLED", c.s === 403 && c.e === "DELIVERY_DISABLED", JSON.stringify(c));
  ok("3e …and nothing is ever sent with it off (attempt → disabled; the sweep path tries nothing)", (await del.attemptDelivery(A.b, 999999, now)) === "disabled" && (await inB(A.b, () => del.processDueDeliveries(A.b, now))) === 0);
  r = await viewOf(A.token);
  ok("3f the owner sees sending is not available", ((await r.json()) as { period: { sendingAvailable: boolean } }).period.sendingAvailable === false);
  process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
  ok("3g no refusal created a delivery or reached the provider", (await owner.accountantDelivery.count({ where: { businessId: A.b } })) === 0 && calls.length === 0);

  // ── 4. Double clicks and concurrency ───────────────────────────────────────────────────────────
  console.log("4. double clicks and concurrency");
  const k = "send:g4-double-click-0001";
  // Both requests at once (a double click that reached the server twice), then a third one later.
  const [a1, a2] = await Promise.all([approve(A, now, k), approve(A, now, k)]);
  const a3 = await approve(A, now, k);
  ok("4a the same Idempotency-Key twice AT ONCE (a double click) → one approval, both answered with it", a1.deliveryId === a2.deliveryId && [a1.created, a2.created].filter(Boolean).length === 1, JSON.stringify([a1, a2]));
  ok("4a2 …and again later → the same approval", a3.deliveryId === a1.deliveryId && a3.created === false && (await owner.accountantDelivery.count({ where: { businessId: A.b } })) === 1);
  ok("4b a second approval with another key while one waits → SEND_IN_PROGRESS", await throwsCode(() => approve(A, now), "SEND_IN_PROGRESS"));
  const parallel = await Promise.allSettled([approve(B, now), approve(B, now), approve(B, now)]);
  ok("4c three concurrent approvals of the same month → exactly one created", parallel.filter((p) => p.status === "fulfilled").length === 1 && (await owner.accountantDelivery.count({ where: { businessId: B.b } })) === 1,
    JSON.stringify(parallel.map((p) => p.status === "fulfilled" ? "ok" : (p.reason as { code?: string }).code)));
  const bId = (await owner.accountantDelivery.findFirstOrThrow({ where: { businessId: B.b } })).id;
  mode = "sent";
  const outcomes = await Promise.all([1, 2, 3].map(() => inB(B.b, () => del.attemptDelivery(B.b, bId, now))));
  ok("4d three concurrent send attempts → one provider call, one acceptance", outcomes.filter((o) => o === "accepted").length === 1 && calls.filter((x) => x.key === `acct:${bId}`).length === 1, JSON.stringify(outcomes));

  // ── 5. Provider 503 → retry → accepted, one message ────────────────────────────────────────────
  console.log("5. a temporary failure and the retry");
  mode = "503";
  ok("5a the first attempt meets a 503 → retry scheduled", (await inB(A.b, () => del.attemptDelivery(A.b, a1.deliveryId, now))) === "retry_scheduled");
  let dA = await delivery(a1.deliveryId);
  ok("5b the row waits (APPROVED, code, next attempt set) and the month is still SENDING", dA.status === "APPROVED" && dA.failureCode === "provider_503" && !!dA.nextAttemptAt && (await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: A.b, periodKey: KEY } })).status === "SENDING");
  let view = await inB(A.b, () => getPeriodView(A.b, KEY));
  ok("5c the owner's view shows the retry and when it is due", view!.deliveries[0].status === "APPROVED" && !!view!.deliveries[0].nextAttemptAt && view!.deliveries[0].retryAfterNoAnswer === false);
  mode = "sent";
  ok("5d before it is due nothing is tried", (await inB(A.b, () => del.processDueDeliveries(A.b, now))) === 0);
  const later = new Date(now.getTime() + 2 * 60_000);
  await inB(A.b, () => del.processDueDeliveries(A.b, later));
  dA = await delivery(a1.deliveryId);
  ok("5e the retry is accepted", dA.status === "ACCEPTED" && dA.attempts === 2, `${dA.status} ${dA.attempts}`);
  ok("5f both attempts carried the SAME idempotency key; the provider holds ONE message", calls.filter((x) => x.key === `acct:${a1.deliveryId}`).length === 2 && [...messages.keys()].filter((x) => x === `acct:${a1.deliveryId}`).length === 1);
  ok("5g sent to the approved address only, with the portal link in the email", calls.filter((x) => x.key === `acct:${a1.deliveryId}`).every((x) => x.to === "dana@example.com") && /https:\/\/app\.example\.com\/a\/[A-Za-z0-9_-]{32}#t=[A-Za-z0-9_-]{43}/.test(calls[calls.length - 1].text));
  ok("5h the month is SENT", (await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: A.b, periodKey: KEY } })).status === "SENT");

  // ── 6. No answer → uncertain, still one message ────────────────────────────────────────────────
  console.log("6. no answer from the provider");
  const e1 = await approve(E, now);
  mode = "timeout";
  let clock = now;
  ok("6a a timeout schedules a retry, flagged as an unanswered attempt", (await inB(E.b, () => del.attemptDelivery(E.b, e1.deliveryId, clock))) === "retry_scheduled" &&
    (await inB(E.b, () => getPeriodView(E.b, KEY)))!.deliveries[0].retryAfterNoAnswer === true);
  for (let i = 0; i < 8; i++) { clock = new Date(clock.getTime() + 7 * 3600_000); await inB(E.b, () => del.processDueDeliveries(E.b, clock)); }
  const dE = await delivery(e1.deliveryId);
  ok("6b after every retry it is FAILED with a no-answer code", dE.status === "FAILED" && /^timeout/.test(dE.failureCode ?? ""), `${dE.status} ${dE.failureCode} ${dE.attempts}`);
  view = await inB(E.b, () => getPeriodView(E.b, KEY));
  ok("6c the owner's view flags it UNCERTAIN (it may have arrived)", view!.deliveries[0].outcomeUncertain === true && view!.deliveries[0].linkState === "not_sent");
  ok("6d every attempt reused the same key, so the provider holds exactly ONE message", calls.filter((x) => x.key === `acct:${e1.deliveryId}`).length === dE.attempts && dE.attempts > 1 && [...messages.keys()].filter((x) => x === `acct:${e1.deliveryId}`).length === 1);
  ok("6e the month is SEND_FAILED (the owner decides) — never silently marked sent", (await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: E.b, periodKey: KEY } })).status === "SEND_FAILED");

  // ── 7. Refusal → failed, not uncertain ─────────────────────────────────────────────────────────
  console.log("7. a refusal");
  const f1 = await approve(F, now);
  mode = "422";
  ok("7a a 422 fails at once", (await inB(F.b, () => del.attemptDelivery(F.b, f1.deliveryId, now))) === "failed");
  view = await inB(F.b, () => getPeriodView(F.b, KEY));
  ok("7b FAILED, not uncertain (the provider answered)", view!.deliveries[0].status === "FAILED" && view!.deliveries[0].outcomeUncertain === false);
  const periodF = await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: F.b, periodKey: KEY } });
  await inB(F.b, () => syncPeriodNotice(periodF, now));
  ok("7c the month is SEND_FAILED and the owner gets the failure notice", periodF.status === "SEND_FAILED" &&
    (await owner.notification.count({ where: { businessId: F.b, resolvedAt: null, href: `/documents/accountant-pack?period=${KEY}` } })) === 1);
  mode = "sent";

  // ── 8. The accountant uses the link; the owner sees it ─────────────────────────────────────────
  console.log("8. the accountant uses the link — the owner sees it");
  const link = /https:\/\/app\.example\.com\/a\/([A-Za-z0-9_-]{32})#t=([A-Za-z0-9_-]{43})/.exec(calls.filter((x) => x.key === `acct:${a1.deliveryId}`).pop()!.text)!;
  const lp = (route: { POST: (r: Request) => Promise<Response> }, url: string, body: Json) => route.POST(req(url, null, { method: "POST", body: JSON.stringify({ publicId: link[1], token: link[2], ...body }) }));
  view = await inB(A.b, () => getPeriodView(A.b, KEY));
  ok("8a before anything: link live, not opened yet", view!.deliveries[0].linkState === "live" && view!.deliveries[0].portal.views === 0);
  r = await lp(portalRoute, "/api/accountant/link/portal", {});
  const ix = (await r.json()) as { files: { path: string }[] };
  ok("8b the accountant opens the portal (200, the sealed files)", r.status === 200 && ix.files.length === 2, String(r.status));
  r = await lp(fileRoute, "/api/accountant/link/file", { file: ix.files[0].path, mode: "view" });
  await r.arrayBuffer();
  r = await lp(fileRoute, "/api/accountant/link/file", { file: ix.files[1].path, mode: "download" });
  await r.arrayBuffer();
  r = await lp(openRoute, "/api/accountant/link/open", { mode: "download" });
  await r.arrayBuffer();
  r = await viewOf(A.token);
  const dv = ((await r.json()) as { period: { deliveries: (Json & { portal: Json })[] } }).period.deliveries[0];
  ok("8c the owner's view: opened once, two files, the ZIP once, link live",
    dv.portal.views === 1 && dv.portal.fileDownloads === 2 && dv.downloadCount === 1 && dv.linkState === "live" && typeof dv.portal.lastViewedAt === "string", JSON.stringify({ p: dv.portal, z: dv.downloadCount, l: dv.linkState }));
  ok("8d the owner's view carries no path, key or link secret", !JSON.stringify(dv).includes("biz/") && !JSON.stringify(dv).includes(link[2]) && !JSON.stringify(dv).includes("approved/"));

  // ── 9. Revoke and expiry ───────────────────────────────────────────────────────────────────────
  console.log("9. revoke and expiry");
  r = await revokeRoute.POST(req(`/api/accountant/deliveries/${a1.deliveryId}/revoke`, B.token, { method: "POST" }), { params: Promise.resolve({ deliveryId: String(a1.deliveryId) }) });
  ok("9a another business cannot revoke it (404) — the link still works", r.status === 404 && (await lp(portalRoute, "/api/accountant/link/portal", {})).status === 200);
  r = await revokeRoute.POST(req(`/api/accountant/deliveries/${a1.deliveryId}/revoke`, A.token, { method: "POST" }), { params: Promise.resolve({ deliveryId: String(a1.deliveryId) }) });
  ok("9b the owner revokes it (route)", r.status === 200 || r.status === 204, String(r.status));
  ok("9c the portal, a file and the ZIP → 410 LINK_REVOKED",
    (await code(await lp(portalRoute, "/api/accountant/link/portal", {}))).e === "LINK_REVOKED" &&
      (await code(await lp(fileRoute, "/api/accountant/link/file", { file: ix.files[0].path, mode: "download" }))).e === "LINK_REVOKED" &&
      (await code(await lp(openRoute, "/api/accountant/link/open", { mode: "download" }))).e === "LINK_REVOKED");
  view = await inB(A.b, () => getPeriodView(A.b, KEY));
  ok("9d the owner's view says revoked; the earlier activity is kept", view!.deliveries[0].linkState === "revoked" && view!.deliveries[0].portal.views === 2);
  const x1 = await approve(X, new Date(now.getTime() - 20 * 86400_000));
  await inB(X.b, () => del.attemptDelivery(X.b, x1.deliveryId, new Date(now.getTime() - 20 * 86400_000)));
  view = await inB(X.b, () => getPeriodView(X.b, KEY));
  ok("9e a link approved 20 days ago: the owner's view says expired", view!.deliveries[0].status === "ACCEPTED" && view!.deliveries[0].linkState === "expired");

  // ── 10. Isolation ──────────────────────────────────────────────────────────────────────────────
  console.log("10. isolation");
  r = await viewOf(B.token);
  const vb = ((await r.json()) as { period: { deliveries: { id: number }[]; recipient: { email: string } } }).period;
  ok("10a B's view holds only B's send and B's recipient", vb.deliveries.length === 1 && vb.deliveries[0].id === bId && vb.recipient.email === "b-cpa@example.com");
  const crossView = await inB(B.b, () => getPeriodView(B.b, KEY));
  ok("10b no A delivery is visible in B's tenant context", !crossView!.deliveries.some((d) => d.id === a1.deliveryId));
  ok("10c a business without the feature has no accountant data and gets 404", (await viewOf(D.token)).status === 404 && (await owner.accountantPeriod.count({ where: { businessId: D.b } })) === 0);

  // ── 11. Nothing else changed ───────────────────────────────────────────────────────────────────
  console.log("11. nothing else changed");
  ok("11a package rows, stored ZIPs and source documents are byte-identical to before", (await snapshot()) === before);
  ok("11b every provider call went to the emulator; no other network", otherNetwork === 0);
  const sent = [...messages.keys()];
  ok("11c messages at the provider: one per delivery that reached it, never two for one delivery", new Set(sent).size === sent.length && sent.every((s) => /^acct:\d+$/.test(s)));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
