/**
 * Notification time math — quiet hours and the digest moment, pure (Intl only).
 *
 *   npx tsx lib/notifications/notification-time.test.ts
 *
 *  1. Wall clock ↔ instant in Asia/Jerusalem on both clock changes of 2026 (Friday 27 March 02:00 → 03:00;
 *     Sunday 25 October 02:00 → 01:00): offsets, the skipped hour, the repeated hour (earlier wins).
 *  2. Quiet hours 22:00–07:00 across midnight: inside / outside, the end instant on ordinary nights and on both
 *     clock-change nights (07:00 local, not 07:00 + an hour), a window not wrapping midnight, disabled, start = end.
 *  3. Another zone (America/New_York, changes 8 March / 1 November 2026) and UTC.
 *  4. The digest moment: due at / after the minute, the local day key (late evening UTC is already tomorrow in
 *     Jerusalem), invalid zones fall back to Asia/Jerusalem.
 */
import {
  DEFAULT_TIME_ZONE,
  addDaysToKey,
  digestMoment,
  localDayKey,
  localMinuteOfDay,
  minuteInWindow,
  normalizeTimeZone,
  offsetMinutes,
  quietUntil,
  wallClockToInstant,
} from "./notification-time";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}`, detail ?? ""); }
}
const J = "Asia/Jerusalem";
const NY = "America/New_York";
const iso = (d: Date | null) => d?.toISOString() ?? null;
const Q = { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 };

console.log("1. Asia/Jerusalem clock changes");
ok("winter offset +120", offsetMinutes(new Date("2026-01-15T12:00:00Z"), J) === 120);
ok("summer offset +180", offsetMinutes(new Date("2026-07-15T12:00:00Z"), J) === 180);
ok("spring: 01:59 local is still winter (23:59Z)", iso(wallClockToInstant("2026-03-27", 119, J)) === "2026-03-26T23:59:00.000Z");
ok("spring: 03:00 local is summer (00:00Z)", iso(wallClockToInstant("2026-03-27", 180, J)) === "2026-03-27T00:00:00.000Z");
ok("spring: the skipped 02:30 moves forward to 03:30 (00:30Z)", iso(wallClockToInstant("2026-03-27", 150, J)) === "2026-03-27T00:30:00.000Z");
ok("autumn: the repeated 01:30 resolves to the earlier (22:30Z)", iso(wallClockToInstant("2026-10-25", 90, J)) === "2026-10-24T22:30:00.000Z");
ok("autumn: 07:00 on the change day is 05:00Z", iso(wallClockToInstant("2026-10-25", 420, J)) === "2026-10-25T05:00:00.000Z");
ok("spring: 07:00 on the change day is 04:00Z", iso(wallClockToInstant("2026-03-27", 420, J)) === "2026-03-27T04:00:00.000Z");
ok("round trip local minute", localMinuteOfDay(wallClockToInstant("2026-06-01", 8 * 60 + 15, J), J) === 495);

console.log("2. quiet hours 22:00–07:00");
ok("window wraps midnight: 23:00 in, 06:59 in, 07:00 out, 21:59 out, 22:00 in",
  minuteInWindow(1380, 1320, 420) && minuteInWindow(419, 1320, 420) && !minuteInWindow(420, 1320, 420) && !minuteInWindow(1319, 1320, 420) && minuteInWindow(1320, 1320, 420));
ok("non-wrapping window 13:00–15:00", minuteInWindow(800, 780, 900) && !minuteInWindow(900, 780, 900) && !minuteInWindow(779, 780, 900));
ok("start = end is no window", !minuteInWindow(600, 600, 600));
ok("12:00 Jerusalem (winter) is not quiet", quietUntil(new Date("2026-01-15T10:00:00Z"), J, Q) === null);
ok("23:30 Jerusalem (winter) → quiet until 07:00 tomorrow = 05:00Z", iso(quietUntil(new Date("2026-01-15T21:30:00Z"), J, Q)) === "2026-01-16T05:00:00.000Z");
ok("03:00 Jerusalem (summer) → quiet until 07:00 today = 04:00Z", iso(quietUntil(new Date("2026-07-15T00:00:00Z"), J, Q)) === "2026-07-15T04:00:00.000Z");
// The autumn change night: 22:00 Saturday 24 Oct (summer, 19:00Z) → 07:00 Sunday 25 Oct (winter, 05:00Z): 10 hours.
const autumnEve = new Date("2026-10-24T19:30:00Z");
ok("autumn change night: quiet from 22:30 ends at 07:00 winter time (05:00Z)", iso(quietUntil(autumnEve, J, Q)) === "2026-10-25T05:00:00.000Z");
ok("…inside the repeated hour (01:30 the second time, 23:30Z) still 05:00Z", iso(quietUntil(new Date("2026-10-24T23:30:00Z"), J, Q)) === "2026-10-25T05:00:00.000Z");
// The spring change night: 22:00 Thursday 26 Mar (winter, 20:00Z) → 07:00 Friday 27 Mar (summer, 04:00Z).
ok("spring change night: quiet from 23:00 ends at 07:00 summer time (04:00Z)", iso(quietUntil(new Date("2026-03-26T21:00:00Z"), J, Q)) === "2026-03-27T04:00:00.000Z");
ok("…from 03:30 (just after the jump, 00:30Z) still 04:00Z", iso(quietUntil(new Date("2026-03-27T00:30:00Z"), J, Q)) === "2026-03-27T04:00:00.000Z");
ok("disabled ⇒ never quiet", quietUntil(new Date("2026-01-15T21:30:00Z"), J, { ...Q, enabled: false }) === null);
ok("a daytime window 13:00–15:00 ends today", iso(quietUntil(new Date("2026-01-15T11:30:00Z"), J, { enabled: true, startMinute: 780, endMinute: 900 })) === "2026-01-15T13:00:00.000Z");

console.log("3. another zone");
ok("New York winter offset −300, summer −240", offsetMinutes(new Date("2026-01-15T12:00:00Z"), NY) === -300 && offsetMinutes(new Date("2026-07-15T12:00:00Z"), NY) === -240);
ok("New York spring change (8 Mar): 23:00 → 07:00 EDT = 11:00Z", iso(quietUntil(new Date("2026-03-08T04:00:00Z"), NY, Q)) === "2026-03-08T11:00:00.000Z");
ok("New York autumn change (1 Nov): 23:00 EDT → 07:00 EST = 12:00Z", iso(quietUntil(new Date("2026-11-01T03:00:00Z"), NY, Q)) === "2026-11-01T12:00:00.000Z");
ok("UTC: 23:00 → 07:00Z next day", iso(quietUntil(new Date("2026-05-05T23:00:00Z"), "UTC", Q)) === "2026-05-06T07:00:00.000Z");

console.log("4. the digest moment");
ok("07:59 Jerusalem: not due", !digestMoment(new Date("2026-01-15T05:59:00Z"), J, 480).due);
ok("08:00 Jerusalem: due", digestMoment(new Date("2026-01-15T06:00:00Z"), J, 480).due);
ok("08:00 summer = 05:00Z: due", digestMoment(new Date("2026-07-15T05:00:00Z"), J, 480).due && !digestMoment(new Date("2026-07-15T04:59:00Z"), J, 480).due);
ok("the local day: 22:30Z on the 15th is the 16th in Jerusalem (summer)", localDayKey(new Date("2026-07-15T22:30:00Z"), J) === "2026-07-16");
ok("digest day key = local day", digestMoment(new Date("2026-07-15T22:30:00Z"), J, 0).dayKey === "2026-07-16");
ok("addDaysToKey crosses months and years", addDaysToKey("2026-12-31", 1) === "2027-01-01" && addDaysToKey("2026-03-01", -1) === "2026-02-28");
ok("an invalid zone falls back to Asia/Jerusalem", normalizeTimeZone("Mars/Olympus") === DEFAULT_TIME_ZONE && normalizeTimeZone(null) === DEFAULT_TIME_ZONE && normalizeTimeZone(NY) === NY);

console.log(`\n[notification-time] PASS=${passed} FAIL=${failed}`);
if (failed > 0) process.exit(1);
