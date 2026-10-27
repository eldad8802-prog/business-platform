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
  reminderDueAt,
  reminderOrdinal,
  requestExpiry,
  requestFingerprint,
  selfCancel,
  sha256Hex,
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

console.log("— D3: reminders every two hours");
eq("none before two hours", reminderOrdinal(t0, new Date(t0.getTime() + 2 * H - 1)), 0);
eq("the first at two hours", reminderOrdinal(t0, new Date(t0.getTime() + 2 * H)), 1);
eq("the second at four", reminderOrdinal(t0, new Date(t0.getTime() + 4 * H + 5 * 60_000)), 2);
eq("a clock behind the creation: none", reminderOrdinal(t0, new Date(t0.getTime() - H)), 0);
eq("reminder 3 is due at six hours", reminderDueAt(t0, 3).toISOString(), new Date(t0.getTime() + 6 * H).toISOString());

console.log("— D8: who takes it");
const c = [{ id: 7, sortOrder: 20, dayLoad: 3 }, { id: 4, sortOrder: 10, dayLoad: 3 }, { id: 9, sortOrder: 30, dayLoad: 1 }];
eq("balanced: the fewest appointments that day", chooseStaff(c, "BALANCED"), 9);
eq("balanced tie: the owner's order", chooseStaff([c[0], c[1]], "BALANCED"), 4);
eq("balanced tie on order too: the lower id (stable)", chooseStaff([{ id: 8, sortOrder: 0, dayLoad: 0 }, { id: 5, sortOrder: 0, dayLoad: 0 }], "BALANCED"), 5);
eq("priority: the owner's order, whatever the load", chooseStaff(c, "PRIORITY"), 4);
eq("nobody free: null", chooseStaff([], "BALANCED"), null);
eq("the same inputs in another order pick the same person", chooseStaff([...c].reverse(), "BALANCED"), 9);

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
