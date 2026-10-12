/**
 * Daily Tasks — the pure core and the idempotency primitives (no DB, no network, no clock).
 *
 *   - calendar days and DATE round-trips; weekdays of the calendar day itself;
 *   - the four recurrence rules, the last day of the month for 31, every-N anchored at startOn, no occurrence
 *     before startOn, DST-proof (calendar days, never hours);
 *   - the next occurrence after a close (late: no past days; early: never twice the same day), resume, and the
 *     missed-occurrence count with its 31-date cap;
 *   - the state machine (6.1): exactly the allowed transitions;
 *   - the closed payload (12.6, T-P3): free text, unknown keys, wrong types and amounts are refused;
 *   - Idempotency-Key: UUIDv7 only, 24 h write window, 5 min future tolerance (T-I3);
 *   - the request digest: canonical (key order does not matter), content-sensitive, key-bound, rotation (T-D5).
 *
 * Run: npx tsx lib/services/tasks/task-core.test.ts
 */
import {
  MISSED_DATES_LIMIT,
  TRANSITIONS,
  canTransition,
  dayKeyToDbDate,
  dbDateToDayKey,
  firstOccurrenceOnOrAfter,
  isDayKey,
  missedOccurrences,
  nextOccurrenceAfterClose,
  normalizeRule,
  occurrenceOnResume,
  occursOn,
  validatePayload,
  validateRule,
  validateText,
  weekdayOf,
  type SeriesRule,
  type TaskAction,
  type TaskState,
} from "./task-core";
import {
  canonicalJson,
  checkIdempotencyKey,
  digestKeysFromEnv,
  digestWithKeyId,
  requestDigest,
  sameDigest,
  uuidV7,
  uuidV7Time,
} from "./task-idempotency";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── Calendar days ──────────────────────────────────────────────────────────────────────────────
ok("2026-02-29 is not a day", !isDayKey("2026-02-29"));
ok("2028-02-29 is a day", isDayKey("2028-02-29"));
ok("a timestamp is not a day key", !isDayKey("2026-10-12T00:00:00Z"));
eq("DATE round-trip", dbDateToDayKey(dayKeyToDbDate("2026-10-25")), "2026-10-25");
eq("12 Oct 2026 is a Monday", weekdayOf("2026-10-12"), 1);
eq("25 Oct 2026 (DST end) is a Sunday", weekdayOf("2026-10-25"), 0);

// ── Rules ──────────────────────────────────────────────────────────────────────────────────────
const daily: SeriesRule = { kind: "DAILY" };
const sunThu: SeriesRule = { kind: "WEEKDAYS", weekdays: [4, 0] };
const day31: SeriesRule = { kind: "MONTH_DAY", monthDay: 31 };
const day15: SeriesRule = { kind: "MONTH_DAY", monthDay: 15 };
const every3: SeriesRule = { kind: "EVERY_N_DAYS", intervalDays: 3 };
eq("weekdays are normalised (sorted, unique)", normalizeRule({ kind: "WEEKDAYS", weekdays: [4, 0, 4] }), { kind: "WEEKDAYS", weekdays: [0, 4] });
eq("no weekday is refused", validateRule({ kind: "WEEKDAYS", weekdays: [] }), "WEEKDAYS_EMPTY");
eq("weekday 7 is refused", validateRule({ kind: "WEEKDAYS", weekdays: [7] }), "WEEKDAY_OUT_OF_RANGE");
eq("month day 32 is refused", validateRule({ kind: "MONTH_DAY", monthDay: 32 }), "MONTH_DAY_OUT_OF_RANGE");
eq("every 1 day is refused (that is DAILY)", validateRule({ kind: "EVERY_N_DAYS", intervalDays: 1 }), "INTERVAL_OUT_OF_RANGE");
ok("no occurrence before startOn", !occursOn(daily, "2026-10-12", "2026-10-11"));
ok("Sunday/Thursday rule: Sunday 11 Oct", occursOn(sunThu, "2026-10-01", "2026-10-11"));
ok("Sunday/Thursday rule: not Monday 12 Oct", !occursOn(sunThu, "2026-10-01", "2026-10-12"));
ok("31 = last day: 30 Nov", occursOn(day31, "2026-01-01", "2026-11-30"));
ok("31 = last day: 28 Feb 2027", occursOn(day31, "2026-01-01", "2027-02-28"));
ok("31 = last day: 29 Feb 2028", occursOn(day31, "2026-01-01", "2028-02-29"));
ok("31: not 30 Oct (October has a 31st)", !occursOn(day31, "2026-01-01", "2026-10-30"));
ok("every 3 days is anchored at startOn", occursOn(every3, "2026-10-12", "2026-10-15") && !occursOn(every3, "2026-10-12", "2026-10-14"));
ok("every 3 days across the DST change (24→27 Oct)", occursOn(every3, "2026-10-12", "2026-10-24") && occursOn(every3, "2026-10-12", "2026-10-27"));
eq("first 15th on/after 16 Oct is 15 Nov", firstOccurrenceOnOrAfter(day15, "2026-01-01", "2026-10-16"), "2026-11-15");

// ── Next, resume, missed ───────────────────────────────────────────────────────────────────────
eq("daily, completed late: next is tomorrow, not the missed days", nextOccurrenceAfterClose(daily, "2026-10-01", "2026-10-05", "2026-10-12"), "2026-10-13");
eq("Sun/Thu due Thu 15, completed early Mon 12: next is Sun 18, never Thu 15 again", nextOccurrenceAfterClose(sunThu, "2026-10-01", "2026-10-15", "2026-10-12"), "2026-10-18");
eq("monthly 31 closed in October: next is 30 Nov", nextOccurrenceAfterClose(day31, "2026-01-01", "2026-10-31", "2026-10-31"), "2026-11-30");
eq("resume on a rule day: today", occurrenceOnResume(sunThu, "2026-10-01", "2026-10-15"), "2026-10-15");
eq("resume off a rule day: the next rule day", occurrenceOnResume(sunThu, "2026-10-01", "2026-10-13"), "2026-10-15");
eq("open daily due 10 Oct, today 12 Oct: missed 2", missedOccurrences(daily, "2026-10-01", "2026-10-10", "2026-10-12"), { count: 2, dates: ["2026-10-11", "2026-10-12"] });
eq("not missed when today is the due day", missedOccurrences(daily, "2026-10-01", "2026-10-12", "2026-10-12"), { count: 0, dates: [] });
const longMiss = missedOccurrences(daily, "2026-01-01", "2026-01-01", "2026-03-01");
ok(`missed dates are capped at ${MISSED_DATES_LIMIT}, the count is not`, longMiss.count === 59 && longMiss.dates.length === MISSED_DATES_LIMIT, longMiss.count);

// ── State machine ──────────────────────────────────────────────────────────────────────────────
const allowed: Record<string, string[]> = {};
for (const action of Object.keys(TRANSITIONS) as TaskAction[]) {
  allowed[action] = (["OPEN", "DONE", "CANCELED", "IN_PROGRESS"] as TaskState[]).filter((s) => canTransition(action, s));
}
eq("transitions are exactly 6.1", allowed, {
  EDIT: ["OPEN"], RESCHEDULE: ["OPEN"], SNOOZE: ["OPEN"], COMPLETE: ["OPEN"], CANCEL: ["OPEN"], SKIP: ["OPEN"], REOPEN: ["DONE", "CANCELED"],
});
ok("nothing starts from IN_PROGRESS", Object.values(allowed).every((from) => !from.includes("IN_PROGRESS")));
eq("an empty title is refused", validateText("   ", null), "TITLE_REQUIRED");
eq("a 201-character title is refused", validateText("x".repeat(201), null), "TITLE_TOO_LONG");
eq("a 2001-character note is refused", validateText("t", "x".repeat(2001)), "NOTE_TOO_LONG");

// ── The closed payload (T-P3) ───────────────────────────────────────────────────────────────────
eq("a token payload passes", validatePayload("OCCURRENCES_MISSED", { count: 2, dates: ["2026-10-11", "2026-10-12"] }), null);
eq("free text is refused", validatePayload("TASK_EDITED", { fields: ["call Dana about the invoice"] }), { key: "fields", problem: "NOT_A_TOKEN" });
eq("an unknown key is refused", validatePayload("TASK_EDITED", { title: "x" }), { key: "title", problem: "UNKNOWN_KEY" });
eq("an amount can never be journaled (no key for it)", validatePayload("TASK_COMPLETED", { amount: 1200 }), { key: "amount", problem: "UNKNOWN_KEY" });
eq("a wrong type is refused", validatePayload("TASK_RESCHEDULED", { to: "tomorrow" }), { key: "to", problem: "WRONG_TYPE" });
eq("an unknown event type is refused", validatePayload("TASK_EXPLODED", {}), { key: "TASK_EXPLODED", problem: "UNKNOWN_EVENT" });

// ── Idempotency keys (T-I3) ─────────────────────────────────────────────────────────────────────
const NOW = new Date("2026-10-12T09:00:00.000Z");
const k = uuidV7(NOW);
ok("a generated key is a UUIDv7 that carries its time", uuidV7Time(k)?.getTime() === NOW.getTime(), k);
ok("a fresh key may write", checkIdempotencyKey(k, NOW).ok === true);
eq("a 25-hour-old key is stale", checkIdempotencyKey(uuidV7(new Date(NOW.getTime() - 25 * 3600_000)), NOW), { ok: false, code: "IDEMPOTENCY_KEY_STALE" });
ok("a 23-hour-old key may write", checkIdempotencyKey(uuidV7(new Date(NOW.getTime() - 23 * 3600_000)), NOW).ok === true);
eq("a key 10 minutes in the future is stale", checkIdempotencyKey(uuidV7(new Date(NOW.getTime() + 10 * 60_000)), NOW), { ok: false, code: "IDEMPOTENCY_KEY_STALE" });
eq("a v4 UUID is not accepted", checkIdempotencyKey("3f2c1d7e-8a6b-4c3d-9e1f-0a1b2c3d4e5f", NOW), { ok: false, code: "IDEMPOTENCY_KEY_INVALID" });
eq("a key with spaces is not accepted", checkIdempotencyKey("not a key at all", NOW), { ok: false, code: "IDEMPOTENCY_KEY_INVALID" });

// ── The digest (T-D5) ───────────────────────────────────────────────────────────────────────────
const keys = digestKeysFromEnv({ TASK_REQUEST_HMAC_KEY: "a".repeat(40), TASK_REQUEST_HMAC_KEY_ID: "k2", TASK_REQUEST_HMAC_KEY_PREVIOUS: "b".repeat(40), TASK_REQUEST_HMAC_KEY_PREVIOUS_ID: "k1" });
const req = { route: "task.create", businessId: 7, userId: 9, body: { title: "חשבונית", dueOn: "2026-10-13" } };
const d = requestDigest(keys.current, req);
eq("canonical JSON ignores key order", canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
ok("the digest is 64 hex characters", /^[0-9a-f]{64}$/.test(d));
ok("same request, reordered body → same digest", sameDigest(d, requestDigest(keys.current, { ...req, body: { dueOn: "2026-10-13", title: "חשבונית" } })));
ok("a different title → a different digest", !sameDigest(d, requestDigest(keys.current, { ...req, body: { ...req.body, title: "חשבונית!" } })));
ok("another user → a different digest", !sameDigest(d, requestDigest(keys.current, { ...req, userId: 10 })));
ok("another business → a different digest", !sameDigest(d, requestDigest(keys.current, { ...req, businessId: 8 })));
ok("a digest signed with the previous key is still checked during a rotation",
  sameDigest(digestWithKeyId(keys, "k1", req)!, requestDigest(keys.previous!, req)));
ok("an unknown key id cannot be checked (the reuse is refused)", digestWithKeyId(keys, "k0", req) === null);
let threw = false;
try { digestKeysFromEnv({ TASK_REQUEST_HMAC_KEY: "short" }); } catch { threw = true; }
ok("a missing or short server key fails loud", threw);

console.log(failed === 0 ? `\ntask core: all ${checks} checks hold.` : `\n${failed} of ${checks} FAILED`);
process.exit(failed === 0 ? 0 : 1);
