/**
 * The unified push sender — pure checks with a FAKE fetch (no database, no network, no real key).
 *
 *   npx tsx lib/notifications/push/push.test.ts
 *
 *  1. FCM configuration from the environment only; anything missing / malformed ⇒ not_configured (never thrown,
 *     no request made).
 *  2. The service-account assertion: RS256 over {iss, scope firebase.messaging, aud oauth2 token URL, iat, exp =
 *     iat + 3600}, verified with the public key of a key generated in the test.
 *  3. The access token is fetched once and cached; a 401 from messages:send drops it; an OAuth 5xx is transient,
 *     a 4xx permanent.
 *  4. messages:send: URL with the project id, Bearer token, the body (token, PRIVATE Android notification,
 *     channel dubiz_urgent / dubiz_default by importance, collapse key, TTL, data = exactly
 *     { notificationId, href, category }).
 *  5. Error classification: UNREGISTERED / 404 / SENDER_ID_MISMATCH → gone; INVALID_ARGUMENT on the token → gone,
 *     on the payload → permanent; 429 / 5xx / UNAVAILABLE / network / timeout → transient; other 4xx permanent.
 *  6. Payload privacy: the generic lock-screen text unless lockScreenDetails; the digest / test keep their stored
 *     count-only text; an href outside the category prefix falls back to the prefix; no token or secret ever in a
 *     result code.
 *  7. Web push through the unified sender: not configured ⇒ not_configured; a refused endpoint ⇒ permanent
 *     (no send); 404 / 410 ⇒ gone; 429 / 5xx / network ⇒ transient; the web payload carries title / body / url / tag.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";

import { getCategory } from "../catalog";
import {
  FCM_SCOPE,
  OAUTH_TOKEN_URL,
  buildAssertion,
  classifyFcmError,
  fcmConfig,
  fcmMessageBody,
  resetFcmTokenCache,
  sendFcm,
} from "./fcm-client";
import { buildPushMessage } from "./push-content";
import { classifyWebPushOutcome, sendToDevice, webPushPayloadOf } from "./push-sender";
import type { FetchLike, PushMessage } from "./push-types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = { FCM_PROJECT_ID: "dubiz-lab", FCM_CLIENT_EMAIL: "push@dubiz-lab.iam.gserviceaccount.com", FCM_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") };
const TOKEN = "fGx1:APA91bH" + "a".repeat(60);
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(script: ((c: Call) => { status: number; body: string } | Error)[]) {
  const calls: Call[] = [];
  let i = 0;
  const f: FetchLike = async (url, init) => {
    const c = { url, headers: init.headers, body: init.body };
    calls.push(c);
    const step = script[Math.min(i++, script.length - 1)](c);
    if (step instanceof Error) throw step;
    return { status: step.status, text: async () => step.body };
  };
  return { f, calls };
}
const tokenOk = () => ({ status: 200, body: JSON.stringify({ access_token: "ya29.lab-access", expires_in: 3600 }) });
const sendOk = () => ({ status: 200, body: JSON.stringify({ name: "projects/dubiz-lab/messages/1" }) });

const msg = (over: Partial<PushMessage> = {}): PushMessage => ({
  notificationId: 41, category: "tasks.reminder", importance: "high", title: "דוביז", body: "יש לך תזכורת חדשה",
  href: "/tasks?task=9", collapseKey: "tasks.reminder-task-9", ttlSeconds: 3600, ...over,
});

async function main() {
  console.log("1. configuration");
  ok("complete env ⇒ configured (\\n escapes accepted)", fcmConfig(ENV)?.privateKey.includes("\n") === true);
  for (const k of ["FCM_PROJECT_ID", "FCM_CLIENT_EMAIL", "FCM_PRIVATE_KEY"] as const) {
    ok(`missing ${k} ⇒ not configured`, fcmConfig({ ...ENV, [k]: undefined }) === null);
  }
  ok("a malformed project id / email / key ⇒ not configured",
    fcmConfig({ ...ENV, FCM_PROJECT_ID: "Bad Project" }) === null && fcmConfig({ ...ENV, FCM_CLIENT_EMAIL: "nope" }) === null &&
    fcmConfig({ ...ENV, FCM_PRIVATE_KEY: "not a key" }) === null);
  const nc = fakeFetch([sendOk]);
  const r0 = await sendFcm(TOKEN, msg(), { env: {}, fetch: nc.f, nowMs: NOW });
  ok("not configured ⇒ not_configured, and no request is made", r0.kind === "not_configured" && nc.calls.length === 0, r0);

  console.log("2. the assertion");
  const cfg = fcmConfig(ENV)!;
  const jwt = buildAssertion(cfg, NOW);
  const [h, c, sig] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  ok("header RS256 / JWT", header.alg === "RS256" && header.typ === "JWT");
  ok("claims: iss, scope, aud, iat, exp = iat + 3600",
    claims.iss === ENV.FCM_CLIENT_EMAIL && claims.scope === FCM_SCOPE && claims.aud === OAUTH_TOKEN_URL && claims.iat === NOW / 1000 && claims.exp === claims.iat + 3600, claims);
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${c}`);
  ok("the signature verifies with the public key", v.verify(publicKey, Buffer.from(sig, "base64url")));

  console.log("3. the access token");
  resetFcmTokenCache();
  const a = fakeFetch([tokenOk, sendOk, sendOk]);
  const r1 = await sendFcm(TOKEN, msg(), { env: ENV, fetch: a.f, nowMs: NOW });
  const r2 = await sendFcm(TOKEN, msg(), { env: ENV, fetch: a.f, nowMs: NOW + 60_000 });
  ok("sent twice", r1.kind === "sent" && r2.kind === "sent", [r1, r2]);
  ok("…with ONE token exchange (cached)", a.calls.filter((x) => x.url === OAUTH_TOKEN_URL).length === 1);
  ok("the exchange is the jwt-bearer grant", a.calls[0].body.includes("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer") && a.calls[0].body.includes("assertion="));
  const b = fakeFetch([sendOk, tokenOk, sendOk]);
  // still cached from above until 5 minutes before expiry
  await sendFcm(TOKEN, msg(), { env: ENV, fetch: b.f, nowMs: NOW + 56 * 60_000 });
  ok("near expiry the token is refreshed", b.calls.some((x) => x.url === OAUTH_TOKEN_URL));
  resetFcmTokenCache();
  const unauth = fakeFetch([tokenOk, () => ({ status: 401, body: "{}" }), tokenOk, sendOk]);
  const u1 = await sendFcm(TOKEN, msg(), { env: ENV, fetch: unauth.f, nowMs: NOW });
  const u2 = await sendFcm(TOKEN, msg(), { env: ENV, fetch: unauth.f, nowMs: NOW + 1000 });
  ok("401 from messages:send ⇒ transient and the cached token is dropped", u1.kind === "transient" && u2.kind === "sent" && unauth.calls.filter((x) => x.url === OAUTH_TOKEN_URL).length === 2, [u1, u2]);
  resetFcmTokenCache();
  ok("OAuth 503 ⇒ transient", (await sendFcm(TOKEN, msg(), { env: ENV, fetch: fakeFetch([() => ({ status: 503, body: "" })]).f, nowMs: NOW })).kind === "transient");
  resetFcmTokenCache();
  ok("OAuth 400 (bad key / account) ⇒ permanent", (await sendFcm(TOKEN, msg(), { env: ENV, fetch: fakeFetch([() => ({ status: 400, body: "{}" })]).f, nowMs: NOW })).kind === "permanent");
  resetFcmTokenCache();
  ok("OAuth network error ⇒ transient", (await sendFcm(TOKEN, msg(), { env: ENV, fetch: fakeFetch([() => new TypeError("fetch failed")]).f, nowMs: NOW })).kind === "transient");

  console.log("4. messages:send");
  resetFcmTokenCache();
  const s = fakeFetch([tokenOk, sendOk]);
  await sendFcm(TOKEN, msg(), { env: ENV, fetch: s.f, nowMs: NOW });
  const send = s.calls[1];
  ok("URL carries the project id", send.url === "https://fcm.googleapis.com/v1/projects/dubiz-lab/messages:send", send.url);
  ok("Bearer access token", send.headers.authorization === "Bearer ya29.lab-access");
  const body = JSON.parse(send.body);
  ok("the device token is the message target", body.message.token === TOKEN);
  ok("Android notification: PRIVATE visibility, urgent channel for high importance, tag = collapse key",
    body.message.android.notification.visibility === "PRIVATE" && body.message.android.notification.channel_id === "dubiz_urgent" &&
    body.message.android.notification.tag === "tasks.reminder-task-9" && body.message.android.collapse_key === "tasks.reminder-task-9" && body.message.android.priority === "HIGH");
  ok("TTL in seconds", body.message.android.ttl === "3600s");
  ok("data is exactly { notificationId, href, category } (strings)",
    JSON.stringify(Object.keys(body.message.data).sort()) === JSON.stringify(["category", "href", "notificationId"]) &&
    body.message.data.notificationId === "41" && body.message.data.href === "/tasks?task=9" && body.message.data.category === "tasks.reminder");
  ok("normal importance ⇒ dubiz_default, NORMAL priority",
    fcmMessageBody(TOKEN, msg({ importance: "normal" })).message.android.notification.channel_id === "dubiz_default" &&
    fcmMessageBody(TOKEN, msg({ importance: "low" })).message.android.priority === "NORMAL");
  ok("a malformed token is gone without any request", (await sendFcm("bad token!", msg(), { env: ENV, fetch: fakeFetch([sendOk]).f, nowMs: NOW })).kind === "gone");

  console.log("5. error classification");
  const fcmErr = (status: string, errorCode: string, message = "") => JSON.stringify({ error: { status, message, details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] } });
  const cases: [number, string, string][] = [
    [404, fcmErr("NOT_FOUND", "UNREGISTERED", "Requested entity was not found."), "gone"],
    [404, "", "gone"],
    [403, fcmErr("PERMISSION_DENIED", "SENDER_ID_MISMATCH"), "gone"],
    [400, fcmErr("INVALID_ARGUMENT", "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token"), "gone"],
    [400, fcmErr("INVALID_ARGUMENT", "INVALID_ARGUMENT", "Invalid JSON payload received. Unknown name"), "permanent"],
    [429, fcmErr("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"), "transient"],
    [503, fcmErr("UNAVAILABLE", "UNAVAILABLE"), "transient"],
    [500, fcmErr("INTERNAL", "INTERNAL"), "transient"],
    [502, "<html>bad gateway</html>", "transient"],
    [401, fcmErr("UNAUTHENTICATED", "THIRD_PARTY_AUTH_ERROR"), "transient"],
    [403, fcmErr("PERMISSION_DENIED", ""), "permanent"],
  ];
  for (const [status, raw, want] of cases) {
    const r = classifyFcmError(status, raw);
    ok(`${status} ${raw.slice(0, 60) || "(empty)"} ⇒ ${want}`, r.kind === want && /^fcm_[A-Za-z0-9_]{1,36}$/.test(r.code), r);
  }
  resetFcmTokenCache();
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const t = await sendFcm(TOKEN, msg(), { env: ENV, fetch: fakeFetch([tokenOk, () => abort]).f, nowMs: NOW });
  ok("a timeout ⇒ transient fcm_timeout", t.kind === "transient" && t.code === "fcm_timeout", t);

  console.log("6. payload privacy");
  const n = { id: 7, title: "יוסי כהן — חשבונית 1042 ₪3,400", summary: "לקוח: יוסי כהן, 054-1234567", href: "/billing/1042", entityType: "billing_document", entityId: 1042 };
  const bf = getCategory("billing.failure")!;
  const safe = buildPushMessage(bf, n, { lockScreenDetails: false, ttlSeconds: 600 });
  ok("default: the generic title and body — no name, amount, number or phone", safe.title === "דוביז" && safe.body === bf.lockScreen.body && !/[0-9]|יוסי/.test(safe.title + safe.body), safe);
  const detailed = buildPushMessage(bf, n, { lockScreenDetails: true, ttlSeconds: 600 });
  ok("lockScreenDetails ON: the stored title / summary (bounded)", detailed.title.startsWith("יוסי") && detailed.body.startsWith("לקוח") && detailed.title.length <= 80 && detailed.body.length <= 160);
  ok("the deep link is the stored internal href when allowed", safe.href === "/billing/1042");
  ok("an href outside the category prefix falls back to the prefix", buildPushMessage(bf, { ...n, href: "/settings/connections" }, { lockScreenDetails: false, ttlSeconds: 1 }).href === "/billing");
  ok("an external href falls back", buildPushMessage(bf, { ...n, href: "https://evil.example/billing" }, { lockScreenDetails: true, ttlSeconds: 1 }).href === "/billing");
  const dg = buildPushMessage(getCategory("digest.daily")!, { id: 9, title: "סיכום יומי", summary: "סיכום יומי: 3 עניינים מחכים לך", href: "/notifications", entityType: "digest", entityId: 4 }, { lockScreenDetails: false, ttlSeconds: 60 });
  ok("the digest keeps its count-only text on the lock screen", dg.title === "דוביז" && dg.body === "סיכום יומי: 3 עניינים מחכים לך");
  ok("the FCM body for the default message carries no stored text",
    !JSON.stringify(fcmMessageBody(TOKEN, safe)).includes("יוסי") && !JSON.stringify(fcmMessageBody(TOKEN, safe)).includes("1042 ₪"));

  console.log("7. web push through the unified sender");
  const web = { id: 1, provider: "WEB_PUSH", endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "BPk", auth: "au" };
  const VAPID = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:ops@example.test" };
  let sent = 0;
  let lastPayload: unknown = null;
  const fakeWeb = (status: number | null, okFlag: boolean, gone = false) => async (_t: unknown, p: unknown) => {
    sent += 1; lastPayload = p;
    return okFlag ? { ok: true as const, status: status ?? 201 } : { ok: false as const, gone, status };
  };
  ok("no VAPID ⇒ not_configured", (await sendToDevice(web, msg(), { env: {}, webPush: fakeWeb(201, true) })).kind === "not_configured" && sent === 0);
  ok("an endpoint outside the push services ⇒ permanent, nothing sent",
    (await sendToDevice({ ...web, endpoint: "https://evil.example/x" }, msg(), { env: VAPID, webPush: fakeWeb(201, true) })).kind === "permanent" && sent === 0);
  ok("201 ⇒ sent", (await sendToDevice(web, msg(), { env: VAPID, webPush: fakeWeb(201, true) })).kind === "sent");
  ok("the web payload: title / body / url / tag (+ ids)", (() => {
    const p = lastPayload as Record<string, unknown>;
    return p.title === "דוביז" && p.url === "/tasks?task=9" && p.tag === "tasks.reminder-task-9" && p.notificationId === 41 && p.category === "tasks.reminder";
  })(), lastPayload);
  ok("410 ⇒ gone", (await sendToDevice(web, msg(), { env: VAPID, webPush: fakeWeb(410, false, true) })).kind === "gone");
  ok("429 ⇒ transient", (await sendToDevice(web, msg(), { env: VAPID, webPush: fakeWeb(429, false) })).kind === "transient");
  ok("503 ⇒ transient", classifyWebPushOutcome({ ok: false, gone: false, status: 503 }).kind === "transient");
  ok("network (null) ⇒ transient", classifyWebPushOutcome({ ok: false, gone: false, status: null }).kind === "transient");
  ok("400 ⇒ permanent", classifyWebPushOutcome({ ok: false, gone: false, status: 400 }).kind === "permanent");
  ok("an FCM row without fcm: ⇒ permanent", (await sendToDevice({ ...web, provider: "FCM" }, msg(), { env: ENV })).kind === "permanent");
  ok("an unknown provider ⇒ permanent", (await sendToDevice({ ...web, provider: "APNS" }, msg(), { env: VAPID })).kind === "permanent");
  ok("webPushPayloadOf keeps the service worker's fields", JSON.stringify(Object.keys(webPushPayloadOf(msg())).sort()) === JSON.stringify(["body", "category", "notificationId", "tag", "title", "url"]));

  console.log(`\n[push] PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
