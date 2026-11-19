/**
 * The notification engine's boundaries — static source checks (no database, no network).
 *
 *   npx tsx lib/notifications/engine/engine-boundary.test.ts
 *
 *  1. The worker and digest routes authenticate through decideCronAuth only (CRON_SECRET) and are NOT scheduled
 *     in vercel.json.
 *  2. Every session route of the engine (settings, overrides, reset, test push, device registration) takes the actor
 *     from the session (engineActor → getAuthContext) and is behind notifications_engine; none reads a user or a
 *     business id from the request.
 *  3. Nothing logs a token, an endpoint or text: no console call in the FCM client or the sender; the worker / digest
 *     log counts only.
 *  4. The logout, cookie-revoke and session-directory routes call the device hooks only AFTER their own auth action,
 *     through the best-effort wrappers that never throw; the hooks write PushSubscription through tenantTx only.
 *  5. The existing push loops (task reminders, public booking) go through the shared sender, web push devices only;
 *     the snapshot writer gives every owed PUSH row an expiresAt; lib/push/web-push-sender.ts is unchanged in API.
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}
const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

console.log("1. cron routes");
const vercel = fs.existsSync(path.join(root, "vercel.json")) ? read("vercel.json") : "";
for (const r of ["app/api/notifications/worker/route.ts", "app/api/notifications/digest/route.ts"]) {
  const c = code(r);
  ok(`${r}: decideCronAuth`, /decideCronAuth\(req\.headers\.get\("authorization"\)\)/.test(c));
  ok(`${r}: never reads CRON_SECRET itself, never a session`, !/process\.env\.CRON_SECRET|getAuthContext|getCurrentUser/.test(c));
  ok(`${r}: not scheduled in vercel.json`, !vercel.includes(r.replace(/^app/, "").replace(/\/route\.ts$/, "")));
}

console.log("2. session routes");
const SESSION_ROUTES = [
  "app/api/notifications/settings/route.ts",
  "app/api/notifications/settings/preferences/[key]/route.ts",
  "app/api/notifications/settings/reset/route.ts",
  "app/api/notifications/test/route.ts",
  "app/api/push/devices/route.ts",
];
for (const r of SESSION_ROUTES) {
  const c = code(r);
  const handlers = (c.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? []).length;
  const actors = (c.match(/await engineActor\(req\)/g) ?? []).length;
  ok(`${r}: every handler takes the session actor behind the flag (${handlers})`, handlers > 0 && actors === handlers, { handlers, actors });
  ok(`${r}: no user / business id from the request`, !/(body|b|searchParams|params)\??\.(userId|businessId)|get\("(userId|businessId)"\)/.test(c));
}
const http = code("lib/notifications/engine/notifications-http.ts");
ok("engineActor: getAuthContext + notificationsEngineEnabled, 401 / 404", /getAuthContext\(req\)/.test(http) && /notificationsEngineEnabled\(/.test(http) && /401/.test(http) && /404/.test(http));
ok("DELETE /api/push/devices/current: session-scoped (sid + user)", /revokeSessionDevices\(ctx\.user\.businessId, ctx\.sessionId, "unregistered", new Date\(\), \{ userId: ctx\.user\.id \}\)/.test(code("app/api/push/devices/current/route.ts")));
ok("the test push targets only the caller (userId = the session user)", /userId: actor\.userId/.test(code("app/api/notifications/test/route.ts")) && /consumeRateLimit/.test(code("app/api/notifications/test/route.ts")));

console.log("3. logs");
for (const f of ["lib/notifications/push/fcm-client.ts", "lib/notifications/push/push-sender.ts", "lib/notifications/push/push-content.ts"]) {
  ok(`${f}: no console call`, !/console\./.test(code(f)));
}
for (const f of ["lib/notifications/engine/push-worker.ts", "lib/notifications/engine/digest.ts", "lib/notifications/engine/devices.ts", "app/api/push/devices/route.ts"]) {
  const logs = code(f).match(/console\.\w+\([^;]*;/g) ?? [];
  ok(`${f}: logs carry no token, endpoint, title or summary`, logs.every((l) => !/token|endpoint|title|summary|\.body\b|email/i.test(l.replace(/JSON\.stringify\(report\)/, ""))), logs);
}

console.log("4. auth hooks");
const logout = code("app/api/auth/logout/route.ts");
ok("logout (device): the hook runs after revokeSessionForLogout", logout.indexOf("revokeSessionForLogout(authDb()") < logout.indexOf("revokeSessionDevicesBestEffort(user.businessId, sessionId as string, \"logout\""));
ok("logout (all): the hook runs after the generation bump", logout.indexOf("tokenVersion: { increment: 1 }") < logout.indexOf("revokeUserDevicesBestEffort(user.businessId, user.id, \"logout_all\")"));
const revoke = code("app/api/auth/refresh/revoke/route.ts");
ok("cookie revoke: only a PROVEN revoke ends the session's push", /if \(outcome\.kind === "revoked"\) await endSessionPush\(outcome\.sessionId\)/.test(revoke) && /catch \{/.test(revoke));
ok("session directory: one session", /revokeSessionDevicesBestEffort\(context\.user\.businessId, id, "session_ended", context\.user\.id\)/.test(code("app/api/security/sessions/[id]/revoke/route.ts")));
ok("session directory: the others", /revokeUserDevicesBestEffort\(context\.user\.businessId, context\.user\.id, "session_ended", \{\s*exceptSessionId: context\.sessionId,?\s*\}\)/.test(code("app/api/security/sessions/revoke-others/route.ts")));
const devices = code("lib/notifications/engine/devices.ts");
ok("the best-effort wrappers never throw", (devices.match(/export async function revoke\w+BestEffort[\s\S]*?\n\}/g) ?? []).every((f) => /try \{[\s\S]*\} catch/.test(f)) && (devices.match(/BestEffort\(/g) ?? []).length >= 2);
ok("the hooks write through tenantTx, never the auth plane", /tenantTx\(/.test(devices) && !/prisma-auth|authDb/.test(devices));
ok("lib/auth/session-directory.ts is untouched by the engine (no tenant write on the auth plane module)", !/notifications|pushSubscription/.test(code("lib/auth/session-directory.ts")));

console.log("5. existing loops and the writer");
for (const f of ["lib/services/tasks/task-reminders.service.ts", "lib/services/booking/booking-notify.ts"]) {
  const c = code(f);
  ok(`${f}: the shared sender, no direct sendWebPush`, /deliverLegacyPush\(/.test(c) && !/sendWebPush\(/.test(c));
  ok(`${f}: web push devices only (https endpoints)`, c.includes(`endpoint: { startsWith: "https://" }`));
}
const writer = code("lib/notifications/notification-writer.ts");
ok("the writer gives owed PUSH rows an expiresAt", /channel === "PUSH" \? \{ expiresAt: pushExpiresAt \}/.test(writer));
const wps = code("lib/push/web-push-sender.ts");
ok("web-push-sender API intact", /export async function sendWebPush\(target: PushTarget, payload: PushPayload, env: Env = process\.env\): Promise<PushOutcome>/.test(wps) && /TTL: 24 \* 60 \* 60/.test(wps));

console.log(`\n[engine-boundary] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
