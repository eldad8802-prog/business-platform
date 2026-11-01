/**
 * Appointments — authority, identity and repeated-request rules, pure proofs (no database, no network). Run:
 *   npx tsx lib/services/appointment/appointment-core.test.ts
 *
 *   - authorizeAppointmentAction: the owner may do every appointment action; anything else is refused, fail-closed;
 *   - owner decision 6: only an OWNER action carries a user — in the appointment, the journal and the sensors;
 *   - the journal refuses free text before the database would;
 *   - Idempotency-Key: form, age, and a digest that binds route, business, user and body;
 *   - an overlap refused by the database is recognised as such;
 *   - a cancel reason appended to the notes never breaks the 4000 code-point rule (P0-1).
 */
process.env.TASK_REQUEST_HMAC_KEY = "appointment-core-test-synthetic-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "t1";

import { authorizeAppointmentAction, type AppointmentAction } from "./appointment-authorization";
import { isValidActor, sensorWho } from "./appointment-actor";
import { AppointmentServiceError } from "./appointment-errors";
import { journalActor, payloadProblem, JOURNAL_KEY, autoJournalKey } from "./appointment-journal";
import { isOverlapViolation, prepareRequest } from "./appointment-request";
import { mergeNote, NOTES_MAX } from "./appointment-notes";
import { uuidV7 } from "@/lib/services/tasks/task-idempotency";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, extra = ""): void {
  total += 1;
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}
function refusedWith(name: string, code: string, fn: () => unknown): void {
  try {
    fn();
    check(name, false, "no refusal");
  } catch (e) {
    check(name, e instanceof AppointmentServiceError && e.code === code, e instanceof Error ? e.message : String(e));
  }
}

console.log("— authorizeAppointmentAction");
const owner = { kind: "OWNER" as const, businessId: 7, userId: 70 };
const actions: AppointmentAction[] = [
  "appointment.read", "appointment.create", "appointment.reschedule", "appointment.status", "appointment.edit",
  "staff.read", "staff.manage", "availability.read", "availability.manage", "policy.read", "policy.manage",
];
for (const a of actions) {
  let ok = true;
  try { authorizeAppointmentAction(owner, a); } catch { ok = false; }
  check(`the owner may ${a}`, ok);
}
refusedWith("no principal → FORBIDDEN", "FORBIDDEN", () => authorizeAppointmentAction(null, "appointment.read"));
refusedWith("a non-owner principal → FORBIDDEN", "FORBIDDEN", () =>
  authorizeAppointmentAction({ kind: "STAFF", businessId: 7, userId: 70 } as unknown as typeof owner, "appointment.read"));
refusedWith("a principal without a business → FORBIDDEN", "FORBIDDEN", () => authorizeAppointmentAction({ ...owner, businessId: 0 }, "appointment.read"));
refusedWith("a principal without a user → FORBIDDEN", "FORBIDDEN", () => authorizeAppointmentAction({ ...owner, userId: -1 }, "appointment.read"));
refusedWith("an unknown action → FORBIDDEN", "FORBIDDEN", () => authorizeAppointmentAction(owner, "appointment.delete" as AppointmentAction));

console.log("— decision 6: who acted");
check("OWNER with a user is valid", isValidActor({ actor: "OWNER", userId: 70, sourceChannel: "INBOX_WEB" }));
check("OWNER without a user is refused", !isValidActor({ actor: "OWNER", userId: null, sourceChannel: "INBOX_WEB" }));
check("OWNER with user 0 is refused", !isValidActor({ actor: "OWNER", userId: 0, sourceChannel: "INBOX_WEB" }));
for (const actor of ["CUSTOMER", "SYSTEM", "BOT"] as const) {
  check(`${actor} without a user is valid`, isValidActor({ actor, userId: null, sourceChannel: "PUBLIC_BOOKING" }));
  check(`${actor} attributed to a user is refused`, !isValidActor({ actor, userId: 70, sourceChannel: "PUBLIC_BOOKING" }));
}
check("an unknown channel is refused", !isValidActor({ actor: "OWNER", userId: 70, sourceChannel: "EMAIL" as never }));
check("journal: OWNER → OWNER_USER with the user",
  JSON.stringify(journalActor({ actor: "OWNER", userId: 70, sourceChannel: "INBOX_WEB" })) === JSON.stringify({ actor: "OWNER_USER", actorUserId: 70 }));
check("journal: CUSTOMER → CUSTOMER with no user",
  JSON.stringify(journalActor({ actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" })) === JSON.stringify({ actor: "CUSTOMER", actorUserId: null }));
for (const actor of ["SYSTEM", "BOT"] as const) {
  check(`journal: ${actor} → SYSTEM with no user`,
    JSON.stringify(journalActor({ actor, userId: null, sourceChannel: "WHATSAPP_BOT" })) === JSON.stringify({ actor: "SYSTEM", actorUserId: null }));
}
check("sensor: the owner is named", sensorWho({ actor: "OWNER", userId: 70, sourceChannel: "INBOX_WEB" }).actor.type === "OWNER_USER");
check("sensor: a customer is never named", sensorWho({ actor: "CUSTOMER", userId: null, sourceChannel: "PUBLIC_BOOKING" }).actor.type === "SYSTEM");
check("sensor: an OWNER context without a user is never named", sensorWho({ actor: "OWNER", userId: null, sourceChannel: "INBOX_WEB" }).actor.type === "SYSTEM");

console.log("— the journal's closed payload");
check("tokens, numbers, booleans, nulls and arrays pass",
  payloadProblem({ kind: "CUSTOMER", staffMemberId: 3, timed: true, from: null, fields: ["title", "notes"] }) === null);
check("an ISO instant passes", payloadProblem({ startsAt: "2026-12-06T07:00:00.000Z" }) === null);
check("free text is refused", payloadProblem({ note: "the customer said hello" }) !== null);
check("Hebrew is refused", payloadProblem({ title: "תספורת" }) !== null);
check("a long token is refused", payloadProblem({ k: "x".repeat(65) }) !== null);
check("free text inside an array is refused", payloadProblem({ fields: ["ok", "not ok"] }) !== null);
check("an automatic key fits the journal key", JOURNAL_KEY.test(autoJournalKey()));
check("two automatic keys differ", autoJournalKey() !== autoJournalKey());

console.log("— Idempotency-Key");
const now = new Date("2026-12-06T10:00:00Z");
const key = uuidV7(now);
refusedWith("a malformed key → IDEMPOTENCY_KEY_INVALID", "IDEMPOTENCY_KEY_INVALID", () =>
  prepareRequest(owner, { idempotencyKey: "not a key!", now }, "POST /api/appointments", {}));
const a1 = prepareRequest(owner, { idempotencyKey: key, now }, "POST /api/appointments", { startsAt: "x", b: 1 });
const a2 = prepareRequest(owner, { idempotencyKey: key, now }, "POST /api/appointments", { b: 1, startsAt: "x" });
check("the same request → the same digest (key order irrelevant)", a1.digest.value === a2.digest.value && a1.digest.keyId === "t1");
check("a different body → a different digest",
  prepareRequest(owner, { idempotencyKey: key, now }, "POST /api/appointments", { startsAt: "y", b: 1 }).digest.value !== a1.digest.value);
check("a different route → a different digest",
  prepareRequest(owner, { idempotencyKey: key, now }, "POST /api/appointments/[id]/status", { startsAt: "x", b: 1 }).digest.value !== a1.digest.value);
check("another business → a different digest",
  prepareRequest({ ...owner, businessId: 8 }, { idempotencyKey: key, now }, "POST /api/appointments", { startsAt: "x", b: 1 }).digest.value !== a1.digest.value);
check("another user → a different digest",
  prepareRequest({ ...owner, userId: 71 }, { idempotencyKey: key, now }, "POST /api/appointments", { startsAt: "x", b: 1 }).digest.value !== a1.digest.value);

console.log("— overlap refusals from the database");
check("23P01 is an overlap", isOverlapViolation({ code: "P2010", meta: { code: "23P01" } }));
check("the constraint name is an overlap", isOverlapViolation(new Error('conflicting key value violates exclusion constraint "Appointment_no_overlap"')));
check("a unique violation is not", !isOverlapViolation({ code: "P2002" }));
check("a check violation is not", !isOverlapViolation(new Error('new row violates check constraint "Appointment_time_shape"')));

console.log("— refusal codes");
check("SLOT_CONFLICT is 409", new AppointmentServiceError("SLOT_CONFLICT").status === 409);
check("NOT_FOUND is 404", new AppointmentServiceError("NOT_FOUND").status === 404);
check("FORBIDDEN is 403", new AppointmentServiceError("FORBIDDEN").status === 403);
check("INVALID_INPUT is 400", new AppointmentServiceError("INVALID_INPUT").status === 400);

console.log("— cancel reason appended to the notes (P0-1: never past 4000, never a 500)");
{
  const len = (s: string | null) => (s === null ? 0 : Array.from(s).length);
  const notes3990 = "א".repeat(3990);
  const reason500 = "ב".repeat(500);
  const m = mergeNote(notes3990, reason500);
  check("3990 notes + 500 reason: within 4000", len(m) <= NOTES_MAX, String(len(m)));
  check("3990 notes + 500 reason: the notes are kept whole", m !== null && m.startsWith(notes3990 + "\n"));
  check("3990 notes + 500 reason: the reason is cut with …", m !== null && m.endsWith("…") && m.includes("בבבבבבבב"));
  check("3990 notes + 500 reason: exactly 4000", len(m) === NOTES_MAX, String(len(m)));
  check("empty notes: the reason alone", mergeNote(null, "  הלקוח ביקש  ") === "הלקוח ביקש");
  check("blank notes: the reason alone", mergeNote("   ", "ביטול") === "ביטול");
  check("empty reason: notes unchanged", mergeNote("הערה", "") === "הערה" && mergeNote("הערה", null) === "הערה" && mergeNote("הערה", "   ") === "הערה");
  check("both empty: null stays null", mergeNote(null, null) === null);
  check("short: appended on a new line", mergeNote("הערה", "סיבה") === "הערה\nסיבה");
  const full = "x".repeat(4000);
  check("notes already at 4000: unchanged", mergeNote(full, "סיבה") === full);
  check("notes at 3999: unchanged (no room for a character and a newline)", mergeNote("x".repeat(3999), "סיבה") === "x".repeat(3999));
  check("notes at 3998: one character fits exactly", mergeNote("x".repeat(3998), "ס") === "x".repeat(3998) + "\nס");
  const emoji = "😀".repeat(600); // 600 code points, 1200 UTF-16 units
  const e = mergeNote("y".repeat(3500), emoji);
  check("emoji: counted as code points, within 4000", len(e) <= NOTES_MAX, String(len(e)));
  check("emoji: no surrogate pair is split", e !== null && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(e));
  check("Hebrew with niqqud fits whole when short", mergeNote("הערה", "שָׁלוֹם") === "הערה\nשָׁלוֹם");
  check("deterministic: same input, same output", mergeNote(notes3990, reason500) === m);
  check("a 4000-char reason alone is cut to 4000", len(mergeNote(null, "z".repeat(4500))) === NOTES_MAX);
}

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
