/**
 * Public booking page (Milestone C, segment 3) — the pure rules. Run: npx tsx features/public-booking/public-booking-model.test.ts
 */
import {
  checkContact,
  classify,
  clock,
  durationLabel,
  errorText,
  fieldOf,
  firstOpenDay,
  manageUrl,
  nearestAlternatives,
  newRequestKey,
  priceLabel,
  serviceBookable,
  slotsByDay,
  STATE_LABEL,
  stepsFor,
  stepsForProfile,
  lastBookableDay,
  manageStateLabel,
  tokenFromHash,
  weekDays,
  whenLong,
  whenShort,
} from "./public-booking-model";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else { failures += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

console.log("— steps (D7/D8)");
const staff = [{ id: 1, name: "דנה", color: null }];
eq("no choice: service, time, details", stepsFor({ staffChoice: "NONE" }, { staff }), ["service", "time", "details"]);
eq("optional with visible staff: a staff step", stepsFor({ staffChoice: "OPTIONAL" }, { staff }), ["service", "staff", "time", "details"]);
eq("optional but names hidden: no staff step (any staff member)", stepsFor({ staffChoice: "OPTIONAL" }, {}), ["service", "time", "details"]);
eq("before a service is chosen: the short path", stepsFor({ staffChoice: "OPTIONAL" }, null), ["service", "time", "details"]);
check("required with no visible staff cannot be booked from the link", !serviceBookable({ staffChoice: "REQUIRED" }, {}));
check("required with visible staff can", serviceBookable({ staffChoice: "REQUIRED" }, { staff }));
check("optional is always bookable", serviceBookable({ staffChoice: "OPTIONAL" }, {}));

console.log("— labels");
eq("45 minutes", durationLabel(45), "45 דק׳");
eq("an hour", durationLabel(60), "שעה");
eq("an hour and a half", durationLabel(90), "שעה וחצי");
eq("two hours", durationLabel(120), "שעתיים");
eq("2h15", durationLabel(135), "שעתיים ו־15 דק׳");
eq("three hours", durationLabel(180), "3 שעות");
eq("a fixed price", priceLabel({ mode: "FIXED", amount: 120, max: null, currency: "ILS" }), "₪120");
eq("free", priceLabel({ mode: "FIXED", amount: 0, max: null, currency: "ILS" }), "ללא עלות");
eq("from", priceLabel({ mode: "FROM", amount: 80, max: null, currency: "ILS" }), "החל מ־₪80");
eq("a range", priceLabel({ mode: "RANGE", amount: 100, max: 180, currency: "ILS" }), "₪100–₪180");
eq("a quote", priceLabel({ mode: "QUOTE_REQUIRED", amount: 0, max: null, currency: "ILS" }), "המחיר נקבע בעסק");
eq("a private price shows nothing", priceLabel({ mode: "NO_PUBLIC_PRICE", amount: 50, max: null, currency: "ILS" }), null);
eq("prices hidden by the business", priceLabel(undefined), null);
// November: Jerusalem is UTC+2.
eq("a clock in Jerusalem time", clock("2026-11-03T08:30:00.000Z"), "10:30");
check("the long date names the weekday and the month", /שלישי/.test(whenLong("2026-11-03T08:30:00.000Z")) && /נובמבר/.test(whenLong("2026-11-03T08:30:00.000Z")));
check("…and the end time when given, isolated left-to-right (never reads 11:15–10:30 in Hebrew)",
  whenLong("2026-11-03T08:30:00.000Z", "2026-11-03T09:15:00.000Z").endsWith("⁦10:30–11:15⁩"));
check("a short date's clock is isolated too", whenShort("2026-11-03T08:30:00.000Z").endsWith("⁦10:30⁩"));

console.log("— days and free times");
const slots = [
  { startsAt: "2026-11-03T07:00:00.000Z" }, { startsAt: "2026-11-03T08:30:00.000Z" },
  { startsAt: "2026-11-05T12:00:00.000Z" }, { startsAt: "2026-11-02T22:30:00.000Z" }, // 00:30 on 3.11 in Jerusalem
];
const by = slotsByDay(slots);
eq("grouped by the Jerusalem day (00:30 belongs to the next day)", by.get("2026-11-03"), ["2026-11-02T22:30:00.000Z", "2026-11-03T07:00:00.000Z", "2026-11-03T08:30:00.000Z"]);
const cells = weekDays("2026-11-01", slots, new Date("2026-11-01T10:00:00.000Z"));
eq("seven days", cells.length, 7);
eq("counts per day", cells.map((c) => c.count), [0, 0, 3, 0, 1, 0, 0]);
check("today is marked", cells[0].today && !cells[1].today);
eq("the first open day", firstOpenDay(cells), "2026-11-03");
eq("a week with nothing free", firstOpenDay(weekDays("2026-11-08", slots, new Date("2026-11-01T10:00:00.000Z"))), null);
const day = [8, 9, 10, 11, 12, 13].map((h) => ({ startsAt: `2026-11-03T${String(h).padStart(2, "0")}:00:00.000Z` }));
// 10:00 (Z) was taken: 09:00 and 11:00 are an hour away; 08:00 and 12:00 tie at two hours, the earlier wins.
eq("a taken time: the three nearest, in order, never the taken one",
  nearestAlternatives(day, "2026-11-03T10:00:00.000Z"), ["2026-11-03T08:00:00.000Z", "2026-11-03T09:00:00.000Z", "2026-11-03T11:00:00.000Z"]);
eq("fewer than three left: what there is", nearestAlternatives([{ startsAt: "2026-11-03T09:00:00.000Z" }], "2026-11-03T10:00:00.000Z"), ["2026-11-03T09:00:00.000Z"]);

console.log("— the customer's details (D4)");
eq("a full name and a phone: no error", checkContact("נועה לוי", "052-111-1111", ""), {});
check("one letter is not a name", !!checkContact("נ", "0521111111", "").name);
check("markup is refused in a name", !!checkContact("<b>נועה</b>", "0521111111", "").name);
check("a phone is required", !!checkContact("נועה", "  ", "").phone);
check("letters are not a phone", !!checkContact("נועה", "052-abc-1111", "").phone);
check("too few digits", !!checkContact("נועה", "052-111", "").phone);
check("an international number is fine", !checkContact("נועה", "+972 52 111 1111", "").phone);
check("a note over 500 characters", !!checkContact("נועה", "0521111111", "x".repeat(501)).note);
check("no email is asked for (only name, phone, note)", Object.keys(checkContact("", "", "x".repeat(501))).every((k) => ["name", "phone", "note"].includes(k)));

console.log("— answers");
eq("404 → the link is unavailable", classify(404, "NOT_FOUND"), "unavailable");
eq("taken", classify(409, "SLOT_UNAVAILABLE"), "taken");
eq("the phone's open requests", classify(429, "REQUEST_LIMIT"), "limit");
eq("the IP limiter", classify(429, "rate_limited"), "busy");
eq("the limiter is down (fail closed)", classify(503, "rate_limit_unavailable"), "busy");
eq("an invalid field", classify(400, "INVALID_INPUT"), "field");
eq("the self-cancel window closed", classify(409, "SELF_CANCEL_CLOSED"), "closed");
eq("anything else", classify(500, "INTERNAL"), "generic");
eq("the server's Hebrew wins", errorText("taken", "השעה נתפסה"), "השעה נתפסה");
eq("…else ours", errorText("busy", undefined), "השירות עמוס כרגע. אפשר לנסות שוב בעוד רגע.");
eq("the field the server named", fieldOf({ field: "phone" }), "phone");
eq("…never a field the form does not have", fieldOf({ field: "staffId" }), null);

console.log("— the customer's link (D9, D12)");
const tok = "A".repeat(43);
eq("the token rides in the fragment", manageUrl("https://promaxgroup.co.il", tok), `https://promaxgroup.co.il/book/manage#${tok}`);
eq("read back from the fragment", tokenFromHash(`#${tok}`), tok);
eq("…also as #t=", tokenFromHash(`#t=${tok}`), tok);
eq("a truncated token is nothing", tokenFromHash(`#${tok.slice(0, 20)}`), null);
eq("garbage is nothing", tokenFromHash("#<script>"), null);
check("every state has a Hebrew label", Object.values(STATE_LABEL).every((v) => /[֐-׿]/.test(v)));

console.log("— the idempotency key");
const k = newRequestKey(Date.UTC(2026, 10, 3), (n) => new Uint8Array(n).fill(0xab));
check("a UUIDv7 shape (version 7, RFC variant)", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(k), k);
check("its first 48 bits are the time", parseInt(k.replace(/-/g, "").slice(0, 12), 16) === Date.UTC(2026, 10, 3));
check("two keys differ", newRequestKey() !== newRequestKey());
check("the server's key rule accepts it", /^[A-Za-z0-9_-]{8,128}$/.test(newRequestKey()));

console.log("— design direction A: a steady step count, the service's horizon, the words of a withdrawn request");
eq("the staff step is the business's: there before a service is chosen", stepsForProfile({ staffChoice: "OPTIONAL" }, [{ staff }, {}]), ["service", "staff", "time", "details"]);
eq("…and no staff step when no bookable service shows staff", stepsForProfile({ staffChoice: "OPTIONAL" }, [{}, {}]), ["service", "time", "details"]);
eq("…or when the customer does not choose", stepsForProfile({ staffChoice: "NONE" }, [{ staff }]), ["service", "time", "details"]);
eq("the last bookable day follows the service's horizon", lastBookableDay("2026-11-02", { maxAdvanceDays: 14 }), "2026-11-16");
eq("…12 weeks when none was given", lastBookableDay("2026-11-02", null), "2027-01-25");
eq("a withdrawn request reads הבקשה בוטלה, not התור בוטל", manageStateLabel({ state: "CANCELED", withdrawn: true }), "הבקשה בוטלה");
eq("…a cancelled appointment reads התור בוטל", manageStateLabel({ state: "CANCELED", withdrawn: false }), "התור בוטל");

console.log(`${total - failures} passed, ${failures} failed`);
if (failures) process.exit(1);
