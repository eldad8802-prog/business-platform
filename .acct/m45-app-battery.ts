/**
 * G5 M4 (per-business send permission) + M5 (one-time code on a new device) — the application through the REAL
 * services and routes, on the Production-shaped lab (app_runtime_prod, NOBYPASSRLS) with migrations
 * 20261105090000_accountant_link_events, 20261109090000_accountant_delivery_permission and
 * 20261109091000_accountant_link_otp applied.
 *
 *  M4  1. Without the business's permission no approval is possible (403 DELIVERY_NOT_PERMITTED), even with the
 *         master switch on; the owner's screen says sending is unavailable; preparing, viewing and downloading work.
 *      2. The master switch still rules: permission without ACCOUNTANT_DELIVERY_ENABLED → DELIVERY_DISABLED.
 *      3. With both: approve + send (fake provider). Withdrawn between approval and send: the waiting approval is
 *         canceled (never sent), its link revoked, the reason in the trail; the provider is never called.
 *      4. Isolation: B's permission does nothing for A.
 *  M5  5. A live link on a new browser → 401 VERIFICATION_REQUIRED (masked address) for the portal, every file and
 *         the ZIP; "info" stays open to the link alone.
 *      6. The code goes ONLY to the delivery's recipient snapshot (an address in the request is ignored; a later
 *         recipient change does not move it); the database holds a salted HMAC, never the code.
 *      7. Wrong codes cost attempts; the 5th locks the code even for the right digits; a new code may be asked.
 *      8. The right code once → a device (httpOnly, Secure-ready, SameSite=Strict, path-scoped); reuse fails;
 *         five concurrent uses of one right code → exactly one device.
 *      9. Limits: one code per minute, 3 per 15 minutes, 10 per day per delivery; concurrent requests issue one.
 *     10. A device is bound to ONE delivery: not another month's link of the same business, not another business;
 *         a forged or tampered cookie is refused.
 *     11. Revocation overrides everything: the link → 410 with a device, codes and verification refuse, every
 *         device of it is marked revoked. An expired link → 410 with a device; a code cannot restore it.
 *     12. An expired code is refused; a failing email channel → 503 CODE_NOT_SENT, recorded.
 *     13. The trail: LINK_CODE_SENT / LINK_CODE_FAILED / LINK_DEVICE_VERIFIED with ids and reasons only; no code,
 *         cookie value or address in any event, in any answer body (except the masked address), or in any log line.
 *
 * env: OWNER_URL, DATABASE_URL, DIRECT_URL (runtime). Synthetic only. ZERO network (every email is answered here).
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { format } from "node:util";

process.env.TZ = "UTC";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), "acct-m45-"));
process.env.AUTH_TOKEN_SECRET = "acct-lab-synthetic-auth-token-secret-0123456789";
process.env.TRANSACTIONAL_EMAIL_ENABLED = "true";
process.env.RESEND_API_KEY = "re_lab_synthetic";
process.env.TRANSACTIONAL_EMAIL_FROM = "Dubiz <no-reply@example.com>";
process.env.APP_BASE_URL = "https://app.example.com";
process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";
process.env.RATE_LIMIT_BACKEND = "memory";

import { PrismaClient } from "@prisma/client";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; out(`  [PASS] ${name}`); }
  else { failures.push(name); out(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// Every log line the application writes is kept, to prove no code / cookie / address ever reaches a log.
const logged: string[] = [];
const rawLog = console.log.bind(console);
const out = (s: string) => rawLog(s);
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...a: unknown[]) => { logged.push(format(...a)); orig(...a); };
}

// The email channel: the one-time code (acct-otp:<id>) and nothing else is expected; "fail" answers 503.
let mailMode: "ok" | "fail" = "ok";
const otp: { key: string; to: string; text: string }[] = [];
let otherNetwork = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = String((init?.headers as Record<string, string> | undefined)?.["Idempotency-Key"] ?? "");
  if (!String(input).startsWith("https://api.resend.com/") || !key.startsWith("acct-otp:")) { otherNetwork++; throw new Error("no network"); }
  if (mailMode === "fail") return new Response(JSON.stringify({ name: "internal_server_error" }), { status: 503 });
  const body = JSON.parse(String(init?.body)) as { to: string[]; text: string };
  otp.push({ key, to: body.to[0], text: body.text });
  return new Response(JSON.stringify({ id: `msg_otp_${otp.length}` }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Json = Record<string, unknown>;
const codeOf = (text: string) => /\b([0-9]{6})\b/.exec(text)![1];

async function main() {
  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const { runWithTenantContext } = await import("@/lib/tenant/context");
  const { putDocumentObject } = await import("@/lib/services/documents/document-storage.service");
  const prep = await import("@/lib/accountant/prepare.service");
  const { setRecipient } = await import("@/lib/accountant/recipient.service");
  const del = await import("@/lib/accountant/delivery.service");
  const view = await import("@/lib/accountant/view.service");
  const dev = await import("@/lib/accountant/link-device");
  const portalRoute = await import("@/app/api/accountant/link/portal/route");
  const fileRoute = await import("@/app/api/accountant/link/file/route");
  const openRoute = await import("@/app/api/accountant/link/open/route");
  const codeRoute = await import("@/app/api/accountant/link/code/route");
  const verifyRoute = await import("@/app/api/accountant/link/verify/route");

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
  let n = 0;
  const business = async (name: string, permitted: boolean) => {
    const b = await one(`INSERT INTO "Business" ("name", "updatedAt") VALUES ($1, now()) RETURNING "id"`, name);
    const u = await one(`INSERT INTO "User" ("email", "password", "businessId", "updatedAt") VALUES ($1, 'x', $2, now()) RETURNING "id"`, `${name}-${b}@m45.lab`, b);
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_month_close', 'ENABLED', now())`, b);
    if (permitted) await grant(b, "ENABLED");
    await owner.$executeRawUnsafe(`INSERT INTO "BusinessProfile" ("businessId", "billingLegalName", "billingTaxId", "updatedAt") VALUES ($1, $2, '515151515', now())`, b, `${name} בע"מ`);
    return { b, u };
  };
  const grant = (b: number, state: "ENABLED" | "DISABLED") =>
    owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, 'accountant_delivery', $2::"BusinessFeatureAccessState", now())
      ON CONFLICT ("businessId", "featureKey") DO UPDATE SET "state" = EXCLUDED."state", "updatedAt" = now()`, b, state);
  const month = async (b: number, key: string) => {
    const body = Buffer.from(`%PDF-1.4 m45 ${b} ${key} ${++n}`);
    const basename = `doc-${Date.now()}${n}-m45.pdf`;
    await putDocumentObject({ businessId: b, basename, body, contentType: "application/pdf", source: "file" });
    const d = await one(`INSERT INTO "Document" ("businessId", "fileUrl", "source", "mimeType", "status", "createdAt", "contentHashSha256") VALUES ($1, $2, 'file', 'application/pdf', 'approved', $3::timestamp, $4) RETURNING "id"`,
      b, basename, `${key}-10T08:00:00`, createHash("sha256").update(body).digest("hex"));
    await owner.$executeRawUnsafe(`INSERT INTO "FinancialRecord" ("documentId", "businessId", "amount", "date", "vendorName", "direction", "category") VALUES ($1, $2, 100, $3::timestamp, 'ספק', 'expense', 'general')`, d, b, `${key}-05T00:00:00`);
  };
  const sent: { to: string; text: string }[] = [];
  const fake = {
    provider: () => ({
      name: "resend",
      async send(m: { to: string; text: string }) {
        sent.push({ to: m.to, text: m.text });
        return { outcome: "sent" as const, providerMessageId: `msg_m45_${sent.length}` };
      },
    }),
  };
  const inX = <T>(b: number, fn: () => Promise<T>) => runWithTenantContext({ businessId: b }, fn);
  const prepare = async (x: { b: number; u: number }, key: string, clock: Date) => {
    await inX(x.b, () => prep.preparePeriod({ businessId: x.b, periodKey: key, trigger: "SCHEDULE", actor: { type: "SYSTEM" } }, { ...prep.defaultPrepareDeps, now: () => clock }));
    const rc = await owner.accountantRecipient.findUnique({ where: { businessId: x.b } });
    if (!rc) await inX(x.b, () => setRecipient({ businessId: x.b, userId: x.u, name: "רו\"ח דנה", email: "dana@example.com", expectedVersion: null, confirm: true, now: clock }));
    const period = await owner.accountantPeriod.findFirstOrThrow({ where: { businessId: x.b, periodKey: key } });
    return owner.accountantPackage.findFirstOrThrow({ where: { businessId: x.b, periodId: period.id, status: "READY" } });
  };
  const approve = async (x: { b: number; u: number }, key: string, clock: Date) => {
    const pkg = await prepare(x, key, clock);
    const rc = await owner.accountantRecipient.findUniqueOrThrow({ where: { businessId: x.b } });
    return inX(x.b, () => del.approveDelivery({
      businessId: x.b, userId: x.u, periodKey: key, packageId: pkg.id, packageSha256: pkg.sha256!, recipientVersion: rc.version,
      recipientEmail: rc.email, acknowledgeIncomplete: true, idempotencyKey: `send:m45-${x.b}-${key}-${Math.random().toString(36).slice(2)}`, now: clock,
    }));
  };
  const deliver = async (x: { b: number; u: number }, key: string, clock: Date) => {
    const a = await approve(x, key, clock);
    await inX(x.b, () => del.attemptDelivery(x.b, a.deliveryId, clock, fake));
    const m = /https:\/\/app\.example\.com\/a\/([A-Za-z0-9_-]{32})#t=([A-Za-z0-9_-]{43})/.exec(sent[sent.length - 1].text)!;
    return { deliveryId: a.deliveryId, publicId: m[1], token: m[2] };
  };
  const throwsCode = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return (e as { code?: string }).code ?? "?"; } };

  let ipSeq = 0;
  type Link = { publicId: string; token: string; deliveryId: number };
  const call = async (route: { POST: (r: Request) => Promise<Response> }, url: string, l: Link, extra: Json = {}, cookie?: string) => {
    const res = await route.POST(new Request(`https://app.example.com${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${(++ipSeq % 250) + 1}`, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ publicId: l.publicId, token: l.token, ...extra }),
    }));
    const text = await res.text();
    bodies.push(text);
    let json: Json = {};
    try { json = JSON.parse(text) as Json; } catch { /* bytes */ }
    return { s: res.status, j: json, setCookie: res.headers.get("set-cookie") ?? "" };
  };
  const bodies: string[] = [];
  const events = async (deliveryId: number, type?: string) =>
    (await owner.$queryRawUnsafe(`SELECT "eventType", payload FROM "AccountantWorkflowEvent" WHERE "deliveryId" = $1 ${type ? `AND "eventType" = '${type}'` : ""} ORDER BY id`, deliveryId)) as { eventType: string; payload: Json }[];
  const clearChallenges = (deliveryId: number) => owner.$executeRawUnsafe(`DELETE FROM "AccountantLinkChallenge" WHERE "deliveryId" = $1`, deliveryId);
  const pastCodes = (deliveryId: number, ms: number) =>
    owner.$executeRawUnsafe(`UPDATE "AccountantLinkChallenge" SET "createdAt" = "createdAt" - make_interval(secs => $2::float8 / 1000), "expiresAt" = "expiresAt" - make_interval(secs => $2::float8 / 1000) WHERE "deliveryId" = $1`, deliveryId, ms);
  const now = new Date();
  const KEY = "2026-09";

  // ═══ M4 ══════════════════════════════════════════════════════════════════════════════════════
  out("M4. the per-business send permission");
  const A = await business("acct-m45-A", false);
  const B = await business("acct-m45-B", true);
  for (const x of [A, B]) for (const k of [KEY, "2026-08"]) await month(x.b, k);
  ok("1a the flag exists, OFF for everyone; only B holds it", (await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "featureKey" = 'accountant_delivery' AND "state" = 'ENABLED'`) as { n: number }[])[0].n === 1);
  ok("1b A without the permission: approval → 403 DELIVERY_NOT_PERMITTED (master switch on)", (await throwsCode(() => approve(A, KEY, now))) === "DELIVERY_NOT_PERMITTED");
  ok("1c …no delivery row, nothing sent", (await owner.accountantDelivery.count({ where: { businessId: A.b } })) === 0 && sent.length === 0);
  const vA = await inX(A.b, () => view.getPeriodView(A.b, KEY as never, now));
  ok("1d …the owner's screen says sending is unavailable, the package is ready (prepare / view keep working)", vA?.sendingAvailable === false && !!vA?.currentPackage, JSON.stringify({ s: vA?.sendingAvailable }));
  const vB = await inX(B.b, () => view.getPeriodView(B.b, KEY as never, now));
  ok("1e B (permitted) sees sending available", vB?.sendingAvailable === true);

  delete process.env.ACCOUNTANT_DELIVERY_ENABLED;
  ok("2a the master switch still rules: B permitted, switch off → DELIVERY_DISABLED", (await throwsCode(() => approve(B, KEY, now))) === "DELIVERY_DISABLED");
  process.env.ACCOUNTANT_DELIVERY_ENABLED = "true";

  ok("4a isolation: B's permission does nothing for A", (await throwsCode(() => approve(A, KEY, now))) === "DELIVERY_NOT_PERMITTED");

  const aB = await approve(B, KEY, now);
  await grant(B.b, "DISABLED");
  const sentBefore = sent.length;
  const outcome = await inX(B.b, () => del.attemptDelivery(B.b, aB.deliveryId, now, fake));
  const dB = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: aB.deliveryId } });
  ok("3a withdrawn between approval and send → not_permitted, the provider never called", outcome === "not_permitted" && sent.length === sentBefore, outcome);
  ok("3b …the waiting approval canceled, its link revoked, reason recorded", dB.status === "CANCELED" && dB.failureCode === "delivery_not_permitted" && !!dB.linkRevokedAt);
  ok("3c …DELIVERY_CANCELED in the trail with the reason", (await events(aB.deliveryId, "DELIVERY_CANCELED")).some((e) => e.payload.reason === "delivery_not_permitted"));
  ok("3d …a second attempt changes nothing (no send, still canceled)", (await inX(B.b, () => del.attemptDelivery(B.b, aB.deliveryId, now, fake))) === "not_permitted" && sent.length === sentBefore);
  ok("3e …the sweep sends nothing either", (await inX(B.b, () => del.processDueDeliveries(B.b, now, fake))) === 0 && sent.length === sentBefore);
  await grant(B.b, "ENABLED");
  const LB = await deliver(B, "2026-08", now);
  ok("3f permission back + a NEW explicit approval → sent once, to the approved address", sent.length === sentBefore + 1 && sent[sent.length - 1].to === "dana@example.com");

  // ═══ M5 ══════════════════════════════════════════════════════════════════════════════════════
  out("M5. the one-time code on a new device");
  await grant(A.b, "ENABLED");
  const LA = await deliver(A, KEY, now);
  const LA2 = await deliver(A, "2026-08", now);

  let r = await call(portalRoute, "/api/accountant/link/portal", LA);
  ok("5a new browser, live link → 401 VERIFICATION_REQUIRED with the address masked", r.s === 401 && r.j.error === "VERIFICATION_REQUIRED" && r.j.maskedTo === "d•••@example.com", JSON.stringify(r.j));
  r = await call(fileRoute, "/api/accountant/link/file", LA, { report: "xlsx", mode: "download" });
  ok("5b …a file → 401", r.s === 401 && r.j.error === "VERIFICATION_REQUIRED");
  r = await call(openRoute, "/api/accountant/link/open", LA, { mode: "download" });
  ok("5c …the ZIP → 401, and not counted", r.s === 401 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: LA.deliveryId } })).downloadCount === 0);
  r = await call(openRoute, "/api/accountant/link/open", LA, { mode: "info" });
  ok("5d \"info\" (whose, which month) stays open to the link alone", r.s === 200 && typeof r.j.periodLabel === "string");
  ok("5e nothing was viewed or downloaded", (await events(LA.deliveryId, "LINK_VIEWED")).length === 0 && (await events(LA.deliveryId, "LINK_FILE_DOWNLOADED")).length === 0);

  // 6. The code goes to the snapshot.
  await inX(A.b, () => setRecipient({ businessId: A.b, userId: A.u, name: "אחר", email: "other@example.com", expectedVersion: 1, confirm: true, now }));
  r = await call(codeRoute, "/api/accountant/link/code", LA, { email: "attacker@evil.example", to: "attacker@evil.example" });
  ok("6a code sent → 200, only the masked address in the answer", r.s === 200 && r.j.sent === true && r.j.maskedTo === "d•••@example.com" && !JSON.stringify(r.j).includes("dana@"), JSON.stringify(r.j));
  ok("6b …to the delivery's recipient snapshot: not the address in the request, not the later recipient", otp.length === 1 && otp[0].to === "dana@example.com");
  const code1 = codeOf(otp[0].text);
  const ch = (await owner.$queryRawUnsafe(`SELECT "salt", "codeHash", "attempts" FROM "AccountantLinkChallenge" WHERE "deliveryId" = $1`, LA.deliveryId)) as { salt: string; codeHash: string; attempts: number }[];
  ok("6c the database holds a salted HMAC (never the code), no attempt used yet", ch.length === 1 && /^[0-9a-f]{64}$/.test(ch[0].codeHash) && ch[0].codeHash === dev.hashCode(LA.deliveryId, ch[0].salt, code1) && ch[0].attempts === 0);
  ok("6d the email: the code, whose package, no link", /[0-9]{6}/.test(otp[0].text) && !/https?:\/\//.test(otp[0].text) && otp[0].text.includes("acct-m45-A"));
  ok("6e the code email went through the idempotency key acct-otp:<challenge id>", /^acct-otp:[0-9]+$/.test(otp[0].key));

  // 7. Wrong codes.
  const wrong = code1 === "000000" ? "111111" : "000000";
  r = await call(verifyRoute, "/api/accountant/link/verify", LA, { code: wrong });
  ok("7a a wrong code → 400 CODE_WRONG, 4 attempts left, no cookie", r.s === 400 && r.j.error === "CODE_WRONG" && r.j.attemptsLeft === 4 && !r.setCookie, JSON.stringify(r.j));
  for (let i = 0; i < 3; i++) await call(verifyRoute, "/api/accountant/link/verify", LA, { code: wrong });
  r = await call(verifyRoute, "/api/accountant/link/verify", LA, { code: wrong });
  ok("7b the 5th wrong code → CODE_LOCKED", r.s === 400 && r.j.error === "CODE_LOCKED", JSON.stringify(r.j));
  r = await call(verifyRoute, "/api/accountant/link/verify", LA, { code: code1 });
  ok("7c …now even the right code is refused", r.s === 400 && r.j.error === "CODE_LOCKED" && !r.setCookie);
  ok("7d …attempts never exceed 5", ((await owner.$queryRawUnsafe(`SELECT max("attempts")::int AS m FROM "AccountantLinkChallenge" WHERE "deliveryId" = $1`, LA.deliveryId)) as { m: number }[])[0].m === 5);
  r = await call(verifyRoute, "/api/accountant/link/verify", LA, { code: "12ab56" });
  ok("7e a malformed code → refused", r.s === 400 && !r.setCookie);

  // 9. Limits.
  r = await call(codeRoute, "/api/accountant/link/code", LA);
  ok("9a another code within a minute → 429 CODE_COOLDOWN with Retry-After", r.s === 429 && r.j.error === "CODE_COOLDOWN" && Number(r.j.retryAfterSec) > 0 && otp.length === 1);
  await clearChallenges(LA.deliveryId);
  const burst = await Promise.all(Array.from({ length: 6 }, () => call(codeRoute, "/api/accountant/link/code", LA)));
  ok("9b six concurrent code requests → exactly one code issued and sent", burst.filter((x) => x.s === 200).length === 1 && otp.length === 2 &&
    ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantLinkChallenge" WHERE "deliveryId" = $1`, LA.deliveryId)) as { n: number }[])[0].n === 1, burst.map((x) => x.s).join(","));
  const t0 = new Date();
  await clearChallenges(LA.deliveryId);
  const lim: string[] = [];
  for (let i = 0; i < 4; i++) {
    const o = await dev.issueCode(A.b, LA.deliveryId, new Date(t0.getTime() + i * 61_000));
    lim.push(o.ok ? "ok" : o.reason);
  }
  ok("9c 3 codes per 15 minutes, the 4th refused (limit_15min)", lim.join(",") === "ok,ok,ok,limit_15min", lim.join(","));
  await clearChallenges(LA.deliveryId);
  const day: string[] = [];
  for (let i = 0; i < 11; i++) {
    const o = await dev.issueCode(A.b, LA.deliveryId, new Date(t0.getTime() + i * 16 * 60_000));
    day.push(o.ok ? "ok" : o.reason);
  }
  ok("9d 10 codes per day, the 11th refused (limit_day)", day.slice(0, 10).every((x) => x === "ok") && day[10] === "limit_day", day.join(","));
  await clearChallenges(LA.deliveryId);

  // 8. The right code.
  r = await call(codeRoute, "/api/accountant/link/code", LA);
  const code2 = codeOf(otp[otp.length - 1].text);
  const race = await Promise.all(Array.from({ length: 5 }, () => call(verifyRoute, "/api/accountant/link/verify", LA, { code: code2 })));
  const winners = race.filter((x) => x.s === 200);
  ok("8a five concurrent uses of one right code → exactly one device", winners.length === 1 &&
    ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantLinkDevice" WHERE "deliveryId" = $1`, LA.deliveryId)) as { n: number }[])[0].n === 1, race.map((x) => x.s).join(","));
  const setCookie = winners[0]?.setCookie ?? "";
  const cookie = setCookie.split(";")[0];
  ok("8b the cookie: HttpOnly, SameSite=Strict, Path=/api/accountant/link, expires with the link, named per link",
    /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\/api\/accountant\/link(;|$)/.test(setCookie) && /Max-Age=\d+/.test(setCookie) &&
      Number(/Max-Age=(\d+)/.exec(setCookie)![1]) <= 14 * 86400 && cookie.startsWith(dev.deviceCookieName(LA.publicId) + "="), setCookie.replace(/=[A-Za-z0-9_-]{43}/, "=…"));
  const tokenValue = cookie.split("=")[1];
  const devRow = (await owner.$queryRawUnsafe(`SELECT "tokenHash", "expiresAt" FROM "AccountantLinkDevice" WHERE "deliveryId" = $1`, LA.deliveryId)) as { tokenHash: string; expiresAt: Date }[];
  const dA = await owner.accountantDelivery.findUniqueOrThrow({ where: { id: LA.deliveryId } });
  ok("8c the database keeps the cookie's HMAC only, valid until the link expires", devRow[0].tokenHash === dev.hashDeviceToken(tokenValue) && devRow[0].tokenHash !== tokenValue && devRow[0].expiresAt.getTime() === dA.linkExpiresAt.getTime());
  r = await call(verifyRoute, "/api/accountant/link/verify", LA, { code: code2 });
  ok("8d the same code again → refused (single use)", r.s === 400 && !r.setCookie);
  r = await call(portalRoute, "/api/accountant/link/portal", LA, {}, cookie);
  ok("8e with the device: the portal opens (200), recorded as viewed", r.s === 200 && Array.isArray(r.j.files) && (await events(LA.deliveryId, "LINK_VIEWED")).length === 1);
  r = await call(openRoute, "/api/accountant/link/open", LA, { mode: "download" }, cookie);
  ok("8f …the ZIP downloads and is counted once", r.s === 200 && (await owner.accountantDelivery.findUniqueOrThrow({ where: { id: LA.deliveryId } })).downloadCount === 1);
  r = await call(fileRoute, "/api/accountant/link/file", LA, { report: "xlsx", mode: "download" }, cookie);
  ok("8g …a file opens", r.s === 200);

  // 10. Bound to one delivery.
  r = await call(portalRoute, "/api/accountant/link/portal", LA2, {}, `${dev.deviceCookieName(LA2.publicId)}=${tokenValue}`);
  ok("10a the device of September does not open August's link of the same business (even renamed)", r.s === 401);
  r = await call(portalRoute, "/api/accountant/link/portal", LB, {}, `${dev.deviceCookieName(LB.publicId)}=${tokenValue}`);
  ok("10b …nor another business's link", r.s === 401);
  const tampered = tokenValue.slice(0, -1) + (tokenValue.endsWith("A") ? "B" : "A");
  r = await call(portalRoute, "/api/accountant/link/portal", LA, {}, `${dev.deviceCookieName(LA.publicId)}=${tampered}`);
  ok("10c a tampered cookie → 401", r.s === 401);
  r = await call(portalRoute, "/api/accountant/link/portal", LA, {}, `${dev.deviceCookieName(LA.publicId)}=not-a-token`);
  ok("10d a malformed cookie → 401", r.s === 401);
  r = await call(portalRoute, "/api/accountant/link/portal", { ...LA, token: LA2.token }, {}, cookie);
  ok("10e the device without the link's own secret → 404 (the link check comes first)", r.s === 404);

  // 12. Expired code, failing channel.
  await clearChallenges(LA2.deliveryId);
  r = await call(codeRoute, "/api/accountant/link/code", LA2);
  const code3 = codeOf(otp[otp.length - 1].text);
  await pastCodes(LA2.deliveryId, 11 * 60_000);
  r = await call(verifyRoute, "/api/accountant/link/verify", LA2, { code: code3 });
  ok("12a a code older than 10 minutes → CODE_EXPIRED", r.s === 400 && r.j.error === "CODE_EXPIRED" && !r.setCookie, JSON.stringify(r.j));
  mailMode = "fail";
  await pastCodes(LA2.deliveryId, 2 * 60_000);
  r = await call(codeRoute, "/api/accountant/link/code", LA2);
  ok("12b the email channel fails → 503 CODE_NOT_SENT, LINK_CODE_FAILED recorded", r.s === 503 && r.j.error === "CODE_NOT_SENT" && (await events(LA2.deliveryId, "LINK_CODE_FAILED")).some((e) => e.payload.reason === "not_sent"));
  mailMode = "ok";
  const savedEnabled = process.env.TRANSACTIONAL_EMAIL_ENABLED;
  delete process.env.TRANSACTIONAL_EMAIL_ENABLED;
  const issuedBefore = ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantLinkChallenge" WHERE "deliveryId" = $1`, LA2.deliveryId)) as { n: number }[])[0].n;
  r = await call(codeRoute, "/api/accountant/link/code", LA2);
  ok("12c no email configuration → 503 CODE_UNAVAILABLE, no code issued", r.s === 503 && r.j.error === "CODE_UNAVAILABLE" &&
    ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantLinkChallenge" WHERE "deliveryId" = $1`, LA2.deliveryId)) as { n: number }[])[0].n === issuedBefore);
  process.env.TRANSACTIONAL_EMAIL_ENABLED = savedEnabled;

  // 11. Revocation and expiry override everything.
  await pastCodes(LA2.deliveryId, 2 * 60_000);
  r = await call(codeRoute, "/api/accountant/link/code", LA2);
  const code4 = codeOf(otp[otp.length - 1].text);
  await inX(A.b, () => del.revokeLink(A.b, A.u, LA.deliveryId, new Date()));
  r = await call(portalRoute, "/api/accountant/link/portal", LA, {}, cookie);
  ok("11a revoked: the portal → 410 LINK_REVOKED even with the device", r.s === 410 && r.j.error === "LINK_REVOKED");
  r = await call(openRoute, "/api/accountant/link/open", LA, { mode: "download" }, cookie);
  ok("11b …the ZIP → 410", r.s === 410);
  r = await call(codeRoute, "/api/accountant/link/code", LA);
  ok("11c …a new code → 410 (none issued)", r.s === 410);
  ok("11d …every device of the link is marked revoked", ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantLinkDevice" WHERE "deliveryId" = $1 AND "revokedAt" IS NULL`, LA.deliveryId)) as { n: number }[])[0].n === 0);
  await inX(A.b, () => del.revokeLink(A.b, A.u, LA2.deliveryId, new Date()));
  r = await call(verifyRoute, "/api/accountant/link/verify", LA2, { code: code4 });
  ok("11e a code issued before the revocation → 410, no device", r.s === 410 && !r.setCookie &&
    ((await owner.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "AccountantLinkDevice" WHERE "deliveryId" = $1`, LA2.deliveryId)) as { n: number }[])[0].n === 0);

  const C = await business("acct-m45-C", true);
  await month(C.b, KEY);
  const LC = await deliver(C, KEY, now);
  await call(codeRoute, "/api/accountant/link/code", LC);
  const v = await call(verifyRoute, "/api/accountant/link/verify", LC, { code: codeOf(otp[otp.length - 1].text) });
  const cookieC = v.setCookie.split(";")[0];
  await owner.$executeRawUnsafe(`UPDATE "AccountantDelivery" SET "linkExpiresAt" = now() - interval '1 minute' WHERE "id" = $1`, LC.deliveryId);
  r = await call(portalRoute, "/api/accountant/link/portal", LC, {}, cookieC);
  ok("11f expired: the portal → 410 LINK_EXPIRED even with a verified device", r.s === 410 && r.j.error === "LINK_EXPIRED");
  r = await call(codeRoute, "/api/accountant/link/code", LC);
  ok("11g …a code cannot restore it (410)", r.s === 410);

  // 13. The trail and the logs.
  const all = (await owner.$queryRawUnsafe(`SELECT "eventType", "actor", payload::text AS p FROM "AccountantWorkflowEvent" WHERE "eventType" LIKE 'LINK_CODE_%' OR "eventType" = 'LINK_DEVICE_VERIFIED'`)) as { eventType: string; actor: string; p: string }[];
  ok("13a the events exist: code sent, code failed, device verified (actor RECIPIENT)",
    ["LINK_CODE_SENT", "LINK_CODE_FAILED", "LINK_DEVICE_VERIFIED"].every((t) => all.some((e) => e.eventType === t)) && all.every((e) => e.actor === "RECIPIENT"));
  const secrets = [...otp.map((m) => codeOf(m.text)), tokenValue, "dana@example.com", "other@example.com"];
  ok("13b no code, cookie value or address in any event", all.every((e) => secrets.every((x) => !e.p.includes(x))));
  ok("13c no code or cookie value in any answer body", bodies.every((b) => [...otp.map((m) => codeOf(m.text)), tokenValue].every((x) => !b.includes(x))));
  ok("13d no code, cookie value or address in any log line", logged.every((l) => secrets.every((x) => !l.includes(x))), logged.find((l) => secrets.some((x) => l.includes(x)))?.slice(0, 120));
  ok("13e the owner's screen shows the device verification", (await inX(A.b, () => view.getPeriodView(A.b, KEY as never, new Date())))?.deliveries.some((d) => d.portal.devicesVerified === 1) === true);
  ok("13f every email went through the emulator; no other network", otherNetwork === 0);
  ok("13g the runtime cannot delete codes or devices", await (async () => {
    const rt = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
    try { await rt.$executeRawUnsafe(`DELETE FROM "AccountantLinkDevice"`); return false; } catch { return true; } finally { await rt.$disconnect(); }
  })());

  out(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  await owner.$disconnect();
}
main().catch((e) => { rawLog(e); process.exitCode = 1; }).finally(() => process.exit());
