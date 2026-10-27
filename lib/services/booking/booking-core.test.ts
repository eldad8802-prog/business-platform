/**
 * Public booking (Milestone C) — the pure rules. Run: npx tsx lib/services/booking/booking-core.test.ts
 * D3 expiry and reminders, D4 contact, D8 staff choice, D9 self-cancel, D11 caps, link ids and tokens.
 */
import {
  chooseStaff,
  effectiveOpenCap,
  manageLinkExpiry,
  MANAGE_TOKEN,
  newManageToken,
  newPublicId,
  parseContact,
  PLATFORM_LIMITS,
  PUBLIC_ID,
  DEFAULT_TIME_ZONE,
  hoursWaiting,
  isQuietHours,
  nextReminderAt,
  quietHoursEnd,
  reminderDue,
  requestExpiry,
  requestFingerprint,
  safeTimeZone,
  selfCancel,
  sha256Hex,
  withinBusinessHours,
} from "./booking.core";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else { failures += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
const H = 60 * 60_000;
const t0 = new Date("2026-11-03T08:00:00.000Z");

console.log("— D3: a pending request holds its time for 12 hours or until the start");
eq("12 hours when the appointment is later", requestExpiry(t0, new Date(t0.getTime() + 48 * H)).toISOString(), new Date(t0.getTime() + 12 * H).toISOString());
eq("the start when it comes first", requestExpiry(t0, new Date(t0.getTime() + 3 * H)).toISOString(), new Date(t0.getTime() + 3 * H).toISOString());
eq("the business's own hold (15 minutes) when shorter", requestExpiry(t0, new Date(t0.getTime() + 48 * H), 15).toISOString(), new Date(t0.getTime() + 15 * 60_000).toISOString());

console.log("— D3: reminders every two hours after the last notice");
const J = DEFAULT_TIME_ZONE;
const z = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
// November: Jerusalem is UTC+2, so 12:00Z is 14:00 there.
eq("two hours after the last notice, in the day", iso(nextReminderAt(z("2026-11-03T12:00:00.000Z"), J)), "2026-11-03T14:00:00.000Z");
eq("from 08:00 the next is 10:00", iso(nextReminderAt(z("2026-11-04T06:00:00.000Z"), J)), "2026-11-04T08:00:00.000Z");
eq("21:30 is still the day", iso(nextReminderAt(z("2026-11-03T17:30:00.000Z"), J)), "2026-11-03T19:30:00.000Z");
check("none before its moment", !reminderDue({ lastNotifiedAt: t0, expiresAt: z("2026-11-03T20:00:00.000Z"), now: new Date(t0.getTime() + 2 * H - 1), timeZone: J }));
check("due at its moment", reminderDue({ lastNotifiedAt: t0, expiresAt: z("2026-11-03T20:00:00.000Z"), now: new Date(t0.getTime() + 2 * H), timeZone: J }));
eq("hours waiting, for the wording", hoursWaiting(t0, new Date(t0.getTime() + 4 * H + 5 * 60_000)), 4);
eq("a clock behind the creation: 0 hours", hoursWaiting(t0, new Date(t0.getTime() - H)), 0);

console.log("— quiet hours: 22:00–08:00 in the business's time zone");
check("21:59 is the day", !isQuietHours(z("2026-11-03T19:59:00.000Z"), J));
check("22:00 is quiet", isQuietHours(z("2026-11-03T20:00:00.000Z"), J));
check("03:00 is quiet", isQuietHours(z("2026-11-04T01:00:00.000Z"), J));
check("07:59 is quiet", isQuietHours(z("2026-11-04T05:59:00.000Z"), J));
check("08:00 is the day", !isQuietHours(z("2026-11-04T06:00:00.000Z"), J));
eq("a night begun at 23:30 ends at 08:00 the next day", iso(quietHoursEnd(z("2026-11-03T21:30:00.000Z"), J)), "2026-11-04T06:00:00.000Z");
eq("a night after midnight ends at 08:00 the same day", iso(quietHoursEnd(z("2026-11-04T00:00:00.000Z"), J)), "2026-11-04T06:00:00.000Z");
eq("a reminder due at 22:30 moves to 08:00", iso(nextReminderAt(z("2026-11-03T18:30:00.000Z"), J)), "2026-11-04T06:00:00.000Z");
check("nothing goes out in the night even when long due", !reminderDue({ lastNotifiedAt: z("2026-11-03T12:00:00.000Z"), expiresAt: z("2026-11-04T09:00:00.000Z"), now: z("2026-11-04T02:00:00.000Z"), timeZone: J }));

// Every sweep from creation to expiry; a sent reminder becomes the new anchor (as the claim does).
function simulate(createdAt: string, expiresAt: string, timeZone: string, stepMinutes = 10): string[] {
  const sent: string[] = [];
  let last = z(createdAt);
  const end = z(expiresAt).getTime();
  for (let t = z(createdAt).getTime(); t <= end + 2 * H; t += stepMinutes * 60_000) {
    const now = new Date(t);
    if (reminderDue({ lastNotifiedAt: last, expiresAt: z(expiresAt), now, timeZone })) { sent.push(iso(now)); last = now; }
  }
  return sent;
}
console.log("— quiet hours: a whole request, swept every ten minutes");
eq("13:00 → 01:00: at 15, 17, 19, 21; none at 23:00",
  simulate("2026-11-03T11:00:00.000Z", "2026-11-03T23:00:00.000Z", J),
  ["2026-11-03T13:00:00.000Z", "2026-11-03T15:00:00.000Z", "2026-11-03T17:00:00.000Z", "2026-11-03T19:00:00.000Z"]);
eq("21:00 → 09:00: one reminder at 08:00, nothing for the night, nothing after expiry",
  simulate("2026-11-03T19:00:00.000Z", "2026-11-04T07:00:00.000Z", J), ["2026-11-04T06:00:00.000Z"]);
eq("23:30 → 11:30: one at 08:00, then the rhythm resumes at 10:00",
  simulate("2026-11-03T21:30:00.000Z", "2026-11-04T09:30:00.000Z", J), ["2026-11-04T06:00:00.000Z", "2026-11-04T08:00:00.000Z"]);
eq("created at 20:30, lapses at 08:00 sharp: no reminder (expiry is never extended)",
  simulate("2026-11-03T18:30:00.000Z", "2026-11-04T06:00:00.000Z", J), []);
eq("an appointment at 07:00: the request lapses in the night, no reminder at all",
  simulate("2026-11-03T21:00:00.000Z", "2026-11-04T05:00:00.000Z", J), []);
eq("swept every minute: the same reminders, no duplicate",
  simulate("2026-11-03T21:30:00.000Z", "2026-11-04T09:30:00.000Z", J, 1), ["2026-11-04T06:00:00.000Z", "2026-11-04T08:00:00.000Z"]);
check("just sent at 08:00: the 08:10 sweep sends nothing", !reminderDue({ lastNotifiedAt: z("2026-11-04T06:00:00.000Z"), expiresAt: z("2026-11-04T09:30:00.000Z"), now: z("2026-11-04T06:10:00.000Z"), timeZone: J }));
check("a sweeper that was down till 09:15 sends one then", reminderDue({ lastNotifiedAt: z("2026-11-03T19:00:00.000Z"), expiresAt: z("2026-11-04T09:30:00.000Z"), now: z("2026-11-04T07:15:00.000Z"), timeZone: J }));
eq("…and the next two hours after it", iso(nextReminderAt(z("2026-11-04T07:15:00.000Z"), J)), "2026-11-04T09:15:00.000Z");

console.log("— quiet hours: time zones and daylight saving");
const NY = "America/New_York";
check("one instant: night in Jerusalem (23:00), day in New York (16:00)", isQuietHours(z("2026-11-03T21:00:00.000Z"), J) && !isQuietHours(z("2026-11-03T21:00:00.000Z"), NY));
check("New York 21:30 is the day", !isQuietHours(z("2026-11-04T02:30:00.000Z"), NY));
check("New York 22:30 is quiet", isQuietHours(z("2026-11-04T03:30:00.000Z"), NY));
eq("New York's night ends at 08:00 EST", iso(quietHoursEnd(z("2026-11-04T03:30:00.000Z"), NY)), "2026-11-04T13:00:00.000Z");
eq("UTC's night ends at 08:00Z", iso(quietHoursEnd(z("2026-11-03T23:00:00.000Z"), "UTC")), "2026-11-04T08:00:00.000Z");
eq("summer in Jerusalem (UTC+3): 08:00 is 05:00Z", iso(quietHoursEnd(z("2026-07-01T20:00:00.000Z"), J)), "2026-07-02T05:00:00.000Z");
eq("the night the clocks go back (25 Oct): 08:00 winter time", iso(quietHoursEnd(z("2026-10-24T21:00:00.000Z"), J)), "2026-10-25T06:00:00.000Z");
eq("the night the clocks go forward (26 Mar 2027): 08:00 summer time", iso(quietHoursEnd(z("2027-03-25T21:00:00.000Z"), J)), "2027-03-26T05:00:00.000Z");
eq("a request across the clocks going back: one at 08:00 winter time",
  simulate("2026-10-24T18:30:00.000Z", "2026-10-25T07:30:00.000Z", J), ["2026-10-25T06:00:00.000Z"]);
eq("an unknown zone falls back to Jerusalem", safeTimeZone("Mars/Olympus"), J);
check("…and never throws in the sweep", isQuietHours(z("2026-11-03T21:00:00.000Z"), "Mars/Olympus"));

console.log("— D8: who takes it");
const c = [{ id: 7, sortOrder: 20, dayLoad: 3 }, { id: 4, sortOrder: 10, dayLoad: 3 }, { id: 9, sortOrder: 30, dayLoad: 1 }];
eq("balanced: the fewest appointments that day", chooseStaff(c, "BALANCED"), 9);
eq("balanced tie: the owner's order", chooseStaff([c[0], c[1]], "BALANCED"), 4);
eq("balanced tie on order too: the lower id (stable)", chooseStaff([{ id: 8, sortOrder: 0, dayLoad: 0 }, { id: 5, sortOrder: 0, dayLoad: 0 }], "BALANCED"), 5);
eq("priority: the owner's order, whatever the load", chooseStaff(c, "PRIORITY"), 4);
eq("nobody free: null", chooseStaff([], "BALANCED"), null);
eq("the same inputs in another order pick the same person", chooseStaff([...c].reverse(), "BALANCED"), 9);

console.log("— the link offers a time only inside the business's own hours (owner decision 2026-10-28)");
// Sunday 1.11.2026 (Jerusalem UTC+2): the business is open 09:00–17:00; on Monday it has no weekly hours.
const SUN = "2026-11-01", MON = "2026-11-02";
const at = (day: string, hhmm: string) => new Date(`${day}T${String(Number(hhmm.slice(0, 2)) - 2).padStart(2, "0")}:${hhmm.slice(3)}:00.000Z`);
const span = (day: string, from: string, minutes: number) => ({ startsAt: at(day, from), endsAt: new Date(at(day, from).getTime() + minutes * 60_000) });
const sunday = { rules: [{ weekday: 0, startMinute: 9 * 60, endMinute: 17 * 60 }], exceptions: [] as { dayKey: string; kind: "CLOSED" | "OPEN_HOURS"; startMinute: number | null; endMinute: number | null }[] };
check("inside the hours", withinBusinessHours(span(SUN, "09:00", 45), sunday));
check("ending exactly at closing is inside", withinBusinessHours(span(SUN, "16:15", 45), sunday));
check("a service that runs past closing is outside (its length counts)", !withinBusinessHours(span(SUN, "16:30", 45), sunday));
check("after closing — a staff member's later own hours never widen it", !withinBusinessHours(span(SUN, "17:00", 45), sunday));
check("before opening", !withinBusinessHours(span(SUN, "08:30", 45), sunday));
check("a weekday the business has no hours", !withinBusinessHours(span(MON, "10:00", 45), sunday));
const lunch = { rules: sunday.rules, exceptions: [{ dayKey: SUN, kind: "CLOSED" as const, startMinute: 12 * 60, endMinute: 14 * 60 }] };
check("a partial closure of the business is respected", !withinBusinessHours(span(SUN, "12:30", 45), lunch));
check("…and the rest of the day stays open", withinBusinessHours(span(SUN, "11:00", 45), lunch) && withinBusinessHours(span(SUN, "14:00", 45), lunch));
check("a service may not run into the closure", !withinBusinessHours(span(SUN, "11:30", 45), lunch));
check("a whole-day closure", !withinBusinessHours(span(SUN, "10:00", 45), { rules: sunday.rules, exceptions: [{ dayKey: SUN, kind: "CLOSED", startMinute: null, endMinute: null }] }));
const special = { rules: sunday.rules, exceptions: [{ dayKey: MON, kind: "OPEN_HOURS" as const, startMinute: 10 * 60, endMinute: 14 * 60 }] };
check("special opening hours on a closed weekday count", withinBusinessHours(span(MON, "10:00", 45), special));
check("…but only within them", !withinBusinessHours(span(MON, "13:30", 45), special));
const split = { rules: [{ weekday: 0, startMinute: 9 * 60, endMinute: 12 * 60 }, { weekday: 0, startMinute: 13 * 60, endMinute: 17 * 60 }], exceptions: [] };
check("split hours: a time across the gap is outside", !withinBusinessHours(span(SUN, "11:30", 45), split));
check("a business with no hours at all offers nothing on the link", !withinBusinessHours(span(SUN, "10:00", 45), { rules: [], exceptions: [] }));

console.log("— D9: self-cancel");
const start = new Date(t0.getTime() + 48 * H);
eq("off: never", selfCancel({ enabled: false, windowHours: 24 }, start, t0), { allowed: false, until: null });
check("on, 24 h, two days ahead: allowed until a day before", (() => { const r = selfCancel({ enabled: true, windowHours: 24 }, start, t0); return r.allowed && r.until?.getTime() === start.getTime() - 24 * H; })());
check("…and not inside the window", !selfCancel({ enabled: true, windowHours: 24 }, start, new Date(start.getTime() - 23 * H)).allowed);
check("window 0: until the start", selfCancel({ enabled: true, windowHours: 0 }, start, new Date(start.getTime() - 60_000)).allowed);

console.log("— D11: the per-phone cap");
eq("the business's 1 is kept", effectiveOpenCap(1), 1);
eq("the business can never exceed the platform", effectiveOpenCap(9), PLATFORM_LIMITS.maxOpenRequestsPerPhone);
eq("missing → the platform's", effectiveOpenCap(null), PLATFORM_LIMITS.maxOpenRequestsPerPhone);
eq("nonsense → the platform's", effectiveOpenCap(0), PLATFORM_LIMITS.maxOpenRequestsPerPhone);

console.log("— D4: contact");
eq("a name and an Israeli mobile → normalized", parseContact({ name: "  נועה   לוי ", phone: "052-111-1111" }), { ok: true, contact: { name: "נועה לוי", phone: "972521111111", note: null } });
eq("a note is kept, trimmed", parseContact({ name: "רון", phone: "+972 54 444 4444", note: "  פעם ראשונה " }), { ok: true, contact: { name: "רון", phone: "972544444444", note: "פעם ראשונה" } });
eq("a one-letter name is refused", parseContact({ name: "ר", phone: "0521111111" }), { ok: false, field: "name" });
eq("markup in a name is refused", parseContact({ name: "<b>x</b>", phone: "0521111111" }), { ok: false, field: "name" });
eq("letters in a phone are refused", parseContact({ name: "רון", phone: "05two" }), { ok: false, field: "phone" });
eq("a too-short phone is refused", parseContact({ name: "רון", phone: "123" }), { ok: false, field: "phone" });
eq("no phone is refused (D4)", parseContact({ name: "רון" }), { ok: false, field: "phone" });
eq("a note over 500 is refused", parseContact({ name: "רון", phone: "0521111111", note: "x".repeat(501) }), { ok: false, field: "note" });

console.log("— the link id and the manage token");
const ids = new Set(Array.from({ length: 200 }, newPublicId));
check("a link id matches the database's own check and is 24 characters", [...ids].every((x) => PUBLIC_ID.test(x) && x.length === 24));
check("200 link ids, 200 different", ids.size === 200);
const tok = newManageToken();
check("a manage token is 43 url-safe characters", MANAGE_TOKEN.test(tok));
check("only its sha256 (64 hex) would be stored", /^[0-9a-f]{64}$/.test(sha256Hex(tok)) && sha256Hex(tok) !== tok);
check("a request fingerprint is 64 hex and differs per business", /^[0-9a-f]{64}$/.test(requestFingerprint(9, "k")) && requestFingerprint(9, "k") !== requestFingerprint(10, "k"));
check("a manage link lives a week past the start", manageLinkExpiry(t0, start).getTime() === start.getTime() + 7 * 24 * H);
check("…never beyond the table's bound", manageLinkExpiry(t0, new Date(t0.getTime() + 500 * 24 * H)).getTime() <= t0.getTime() + 399 * 24 * H);

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
