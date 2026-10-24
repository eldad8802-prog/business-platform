/**
 * Task reminders + Web Push — pure checks (no database, no network, no clock of their own).
 *
 *   node_modules/.bin/tsx lib/services/tasks/task-reminders.test.ts
 *
 *  1. The reminder moment: Israeli wall clock on both sides of the October 2026 clock change, the offset, and the
 *     shape rules the database also holds (a time needs a day; a reminder needs a time; ranges).
 *  2. Snooze targets: future only, at most 30 days, whole minutes; malformed input refused.
 *  3. The journal: the new payload keys fit the closed schema (an ISO moment is a valid token); free text is not.
 *  4. Push: only https endpoints on the known browser push services (no arbitrary host — no SSRF); VAPID needs all
 *     three variables and a mailto:/https: subject.
 *  5. The dispatcher's door (QStash only): no signature → 401; a signature with no keys → 503; a forged,
 *     wrongly-addressed or wrong-body signature → 401; a valid one for THIS url → accepted.
 */
import { createHash, createHmac } from "node:crypto";

import { isAllowedPushEndpoint, vapidConfig } from "@/lib/push/web-push-sender";

import { authorizeReminderDispatch, REMINDER_DISPATCH_URL } from "./reminder-dispatch-auth";
import { cleanEnvValue, publishFailureFacts } from "./reminder-scheduler";
import { validatePayload } from "./task-core";
import { clockLabel, parseClock, remindAtOf, scheduleProblem, snoozeTarget } from "./task-schedule";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, detail ?? "");
  }
}

// ── 1. The reminder moment ─────────────────────────────────────────────────────────────────────────
// Israel: summer time (UTC+3) until Sunday 2026-10-25 02:00, then UTC+2.
const before = remindAtOf({ dueOn: "2026-10-24", dueMinute: 10 * 60, remindOffsetMinutes: 0 });
const after = remindAtOf({ dueOn: "2026-10-26", dueMinute: 10 * 60, remindOffsetMinutes: 0 });
ok("10:00 on 2026-10-24 (summer) is 07:00 UTC", before?.toISOString() === "2026-10-24T07:00:00.000Z", before?.toISOString());
ok("10:00 on 2026-10-26 (winter) is 08:00 UTC", after?.toISOString() === "2026-10-26T08:00:00.000Z", after?.toISOString());
const dayBefore = remindAtOf({ dueOn: "2026-10-26", dueMinute: 10 * 60, remindOffsetMinutes: 1440 });
ok("a day before 10:00 on 2026-10-26 crosses the change correctly (24h earlier)", dayBefore?.toISOString() === "2026-10-25T08:00:00.000Z", dayBefore?.toISOString());
ok("15 minutes before 09:00", remindAtOf({ dueOn: "2026-11-02", dueMinute: 540, remindOffsetMinutes: 15 })?.toISOString() === "2026-11-02T06:45:00.000Z");
ok("no reminder without an offset", remindAtOf({ dueOn: "2026-11-02", dueMinute: 540, remindOffsetMinutes: null }) === null);
ok("no reminder without a time", remindAtOf({ dueOn: "2026-11-02", dueMinute: null, remindOffsetMinutes: 0 }) === null);
ok("shape: a time needs a day", scheduleProblem({ dueOn: null, dueMinute: 600, remindOffsetMinutes: null })?.problem === "TIME_WITHOUT_DAY");
ok("shape: a reminder needs a time", scheduleProblem({ dueOn: "2026-11-02", dueMinute: null, remindOffsetMinutes: 0 })?.problem === "REMINDER_WITHOUT_TIME");
ok("shape: minute 1440 refused", scheduleProblem({ dueOn: "2026-11-02", dueMinute: 1440, remindOffsetMinutes: null })?.problem === "OUT_OF_RANGE");
ok("shape: more than 7 days before refused", scheduleProblem({ dueOn: "2026-11-02", dueMinute: 600, remindOffsetMinutes: 10081 })?.problem === "OUT_OF_RANGE");
ok("shape: a fractional minute refused", scheduleProblem({ dueOn: "2026-11-02", dueMinute: 600.5, remindOffsetMinutes: null })?.problem === "OUT_OF_RANGE");
ok("shape: valid", scheduleProblem({ dueOn: "2026-11-02", dueMinute: 600, remindOffsetMinutes: 60 }) === null);
ok("clock: 09:05 ↔ 545", parseClock("09:05") === 545 && clockLabel(545) === "09:05");
ok("clock: malformed refused", parseClock("9:5") === null && parseClock("24:00") === null && parseClock("12:60") === null);

// ── 2. Snooze targets ──────────────────────────────────────────────────────────────────────────────
const NOW = new Date("2026-10-22T10:00:30.000Z");
const t1 = snoozeTarget("2026-10-22T11:00:45.123Z", NOW);
ok("snooze: normalised to the whole minute", "at" in t1 && t1.at.toISOString() === "2026-10-22T11:00:00.000Z");
ok("snooze: the past refused", "problem" in snoozeTarget("2026-10-22T09:00:00.000Z", NOW));
ok("snooze: now refused (not in the future)", "problem" in snoozeTarget("2026-10-22T10:00:00.000Z", NOW));
ok("snooze: more than 30 days refused", "problem" in snoozeTarget("2026-12-01T10:00:00.000Z", NOW));
ok("snooze: malformed refused", "problem" in snoozeTarget("tomorrow", NOW) && "problem" in snoozeTarget(42, NOW));

// ── 3. The journal ─────────────────────────────────────────────────────────────────────────────────
ok("journal: a reminder snooze fits (ISO moments are tokens)", validatePayload("TASK_SNOOZED", { remindFrom: "2026-10-22T07:00:00.000Z", remindTo: "2026-10-22T08:00:00.000Z" }) === null);
ok("journal: reschedule with time and reminder fits", validatePayload("TASK_RESCHEDULED", { from: "2026-10-22", to: "2026-10-23", dueMinute: 600, remindOffsetMinutes: 0, remindAt: "2026-10-23T07:00:00.000Z" }) === null);
ok("journal: create with time fits", validatePayload("TASK_CREATED", { dueOn: "2026-10-23", origin: "OWNER", dueMinute: 600, remindOffsetMinutes: 15 }) === null);
ok("journal: free text in a token refused", validatePayload("TASK_SNOOZED", { remindTo: "call the supplier at 10" }) !== null);
ok("journal: an unknown key refused", validatePayload("TASK_SNOOZED", { title: "x" }) !== null);

// ── 4. Push ────────────────────────────────────────────────────────────────────────────────────────
for (const u of [
  "https://fcm.googleapis.com/fcm/send/abc:def",
  "https://web.push.apple.com/QGx-abc",
  "https://updates.push.services.mozilla.com/wpush/v2/abc",
  "https://wns2-par02p.notify.windows.com/w/?token=abc",
]) ok(`push: allowed ${new URL(u).hostname}`, isAllowedPushEndpoint(u));
for (const u of [
  "http://fcm.googleapis.com/fcm/send/abc",
  "https://evil.example/fcm.googleapis.com",
  "https://fcm.googleapis.com.evil.example/x",
  "https://fcm.googleapis.com:8443/x",
  "https://user:pw@fcm.googleapis.com/x",
  "https://169.254.169.254/latest/meta-data",
  "not a url",
]) ok(`push: refused ${u.slice(0, 40)}`, !isAllowedPushEndpoint(u));
ok("vapid: off without all three", vapidConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" }) === null);
ok("vapid: off with a bad subject", vapidConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "owner" }) === null);
ok("vapid: on", vapidConfig({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "mailto:x@y.z" })?.subject === "mailto:x@y.z");

// ── 5. The dispatcher's door ───────────────────────────────────────────────────────────────────────
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function qstashJwt(key: string, url: string, body: string, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const bodyHash = b64url(createHash("sha256").update(body).digest());
  const claims = b64url(JSON.stringify({ iss: "Upstash", sub: url, exp: nowSec + 300, nbf: nowSec - 5, iat: nowSec, jti: "t", body: bodyHash }));
  const sig = b64url(createHmac("sha256", key).update(`${header}.${claims}`).digest());
  return `${header}.${claims}.${sig}`;
}

async function door() {
  const keys = { QSTASH_CURRENT_SIGNING_KEY: "sig_current_test_key", QSTASH_NEXT_SIGNING_KEY: "sig_next_test_key" };
  const nowSec = Math.floor(Date.now() / 1000);
  const none = await authorizeReminderDispatch({ signature: null, body: "" }, keys);
  ok("door: no signature → 401 (there is no bearer path)", !none.ok && none.status === 401);
  const noKeys = await authorizeReminderDispatch({ signature: "x.y.z", body: "" }, {});
  ok("door: a signature with no keys configured → 503", !noKeys.ok && noKeys.status === 503);
  const forged = await authorizeReminderDispatch({ signature: qstashJwt("another_key", REMINDER_DISPATCH_URL, "{}", nowSec), body: "{}" }, keys);
  ok("door: a forged signature → 401", !forged.ok && forged.status === 401);
  const wrongUrl = await authorizeReminderDispatch({ signature: qstashJwt(keys.QSTASH_CURRENT_SIGNING_KEY, "https://promaxgroup.co.il/api/intake/sweep", "{}", nowSec), body: "{}" }, keys);
  ok("door: a valid signature for ANOTHER url → 401", !wrongUrl.ok && wrongUrl.status === 401);
  const wrongBody = await authorizeReminderDispatch({ signature: qstashJwt(keys.QSTASH_CURRENT_SIGNING_KEY, REMINDER_DISPATCH_URL, "{}", nowSec), body: "{\"x\":1}" }, keys);
  ok("door: a valid signature over another body → 401", !wrongBody.ok && wrongBody.status === 401);
  const good = await authorizeReminderDispatch({ signature: qstashJwt(keys.QSTASH_CURRENT_SIGNING_KEY, REMINDER_DISPATCH_URL, "{}", nowSec), body: "{}" }, keys);
  ok("door: a valid QStash signature for THIS url → accepted", good.ok === true && good.via === "qstash", good);
}

// ── the publish token as pasted, and what a failure may log ──
{
  const tok = Buffer.from(JSON.stringify({ UserID: "u", Password: "p" })).toString("base64");
  ok("token: a clean value is kept", cleanEnvValue(tok, "QSTASH_TOKEN") === tok);
  ok("token: quotes are removed", cleanEnvValue(`"${tok}"`, "QSTASH_TOKEN") === tok);
  ok("token: a pasted NAME=\"value\" line is reduced to the value", cleanEnvValue(`QSTASH_TOKEN="${tok}"\n`, "QSTASH_TOKEN") === tok);
  ok("token: blank → none", cleanEnvValue("  ", "QSTASH_TOKEN") === undefined && cleanEnvValue(`""`, "QSTASH_TOKEN") === undefined);
  ok("token: an unmatched quote is not touched", cleanEnvValue(`"ab'`, "QSTASH_TOKEN") === `"ab'`);
  const facts = publishFailureFacts(`"${tok}"`, tok, "https://qstash.upstash.io", new Error(`401 {"error":"invalid token ${tok}"}`));
  const logged = JSON.stringify(facts);
  ok("failure facts: never the token", !logged.includes(tok) && !logged.includes(tok.slice(0, 12)), logged);
  ok("failure facts: shape only", facts.tokenLength === tok.length && facts.decodesToUserId === true && facts.rawWasCleaned === true && facts.looksLikeSigningKey === false);
  ok("failure facts: a signing key pasted as the token is named", publishFailureFacts("sig_abc", "sig_abc", "x", new Error("401")).looksLikeSigningKey === true);
}

door().then(() => {
  console.log(`\ntask reminders: ${failed ? `${failed} of ${passed + failed} FAILED` : `${passed} checks passed`}`);
  if (failed) process.exit(1);
});
