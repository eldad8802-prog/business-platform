/**
 * Appointments completion, workstream G (G2 / G3 / G15 / G24) — the pure rules. No DB, no network (fetch throws), no
 * real clock. Run: npx tsx lib/services/booking/booking-secure-self-service.test.ts
 *
 *   A. OTP policy      5-minute lifetime, 5 attempts, 60 s cooldown, 6 random digits; the PILOT send caps (owner D7: business 9 pilot only)
 *   B. secrets         keyed hashes (domain separated, never the phone / code), constant-time compare, key rotation,
 *                      the browser's verification token bound to business + challenge + moment
 *   C. delivery path   simulate (the default) is NOT a path that can deliver a code; live needs every credential; the
 *                      lab switch never works on Vercel production
 *   D. G24 text        bidi controls / control characters refused in names and notes, stripped from phones — server
 *                      (parseContact) and page (checkContact) agree
 *   E. G15             the self-reschedule window, the business horizon narrows only, the manage link's expiry
 *   F. the page        the verify step, code digits, countdown, phone shown, error kinds for the new codes
 */
globalThis.fetch = (async () => { throw new Error("NETWORK FORBIDDEN IN TESTS"); }) as typeof fetch;
process.env.TASK_REQUEST_HMAC_KEY = "g-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "g1";

import {
  capExceeded,
  codeHashOf,
  codeMatches,
  cooldownLeftSeconds,
  ipHashOf,
  newOtpCode,
  OTP_CODE,
  OTP_POLICY,
  PILOT_OTP_SEND_CAPS,
  otpKeysFromEnv,
  phoneHashesOf,
  phoneHashOf,
  sameSecret,
  tokenMatches,
  VERIFICATION_TOKEN,
  verificationDeliveryAvailable,
  verificationTokenOf,
  type OtpCounts,
} from "./phone-verification.core";
import { effectiveHorizonDays, manageLinkExpiry, MANAGE_LINK_GRACE_DAYS, parseContact, parsePublicPhone, selfReschedule } from "./booking.core";
import { hasBidiControl, nameTextProblem, noteTextProblem, stripPhoneBidi } from "./public-text";
import { checkContact, classify, codeDigits, countdown, phoneShown, retryAfterOf, stepsForProfile } from "@/features/public-booking/public-booking-model";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  total += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else { failures += 1; console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
}

const MIN = 60_000, H = 60 * MIN;

console.log("A. OTP policy");
check("A1 lifetime is 5 minutes (owner requirement 3)", OTP_POLICY.lifetimeMinutes === 5);
check("A2 five attempts (the table's CHECK 0..5)", OTP_POLICY.maxAttempts === 5);
check("A3 resend cooldown 60 s", OTP_POLICY.resendCooldownSeconds === 60);
const codes = Array.from({ length: 2000 }, () => newOtpCode());
check("A4 every code is exactly 6 digits (leading zeros kept)", codes.every((c) => OTP_CODE.test(c)));
check("A5 codes are random (2000 draws, ≥ 1990 distinct; every first digit 0–9 seen)", new Set(codes).size >= 1990 && new Set(codes.map((c) => c[0])).size === 10);
const zero: OtpCounts = { phoneHour: 0, phoneDay: 0, ipHour: 0, ipDay: 0, businessHour: 0, businessDay: 0, phoneBusinessHour: 0 };
check("A6 caps: nothing sent yet → allowed", capExceeded(zero) === null);
check("A7 caps: 3 codes to one phone at one business in an hour → refused (phone)", capExceeded({ ...zero, phoneBusinessHour: 3 }) === "phone" && capExceeded({ ...zero, phoneBusinessHour: 2 }) === null);
check("A8 caps: the phone across businesses (hour / day)", capExceeded({ ...zero, phoneHour: PILOT_OTP_SEND_CAPS.perPhonePerHour }) === "phone" && capExceeded({ ...zero, phoneDay: PILOT_OTP_SEND_CAPS.perPhonePerDay }) === "phone");
check("A9 caps: one IP (hour / day)", capExceeded({ ...zero, ipHour: PILOT_OTP_SEND_CAPS.perIpPerHour }) === "ip" && capExceeded({ ...zero, ipDay: PILOT_OTP_SEND_CAPS.perIpPerDay }) === "ip");
check("A10 caps: one business (hour / day)", capExceeded({ ...zero, businessHour: PILOT_OTP_SEND_CAPS.perBusinessPerHour }) === "business" && capExceeded({ ...zero, businessDay: PILOT_OTP_SEND_CAPS.perBusinessPerDay }) === "business");
const t0 = new Date("2026-12-01T10:00:00.000Z");
check("A11 cooldown: 60 s after a code → 60; after 59.5 s → 1; after 60 s → 0; none before → 0",
  cooldownLeftSeconds(t0, t0) === 60 && cooldownLeftSeconds(t0, new Date(t0.getTime() + 59_500)) === 1
  && cooldownLeftSeconds(t0, new Date(t0.getTime() + 60_000)) === 0 && cooldownLeftSeconds(null, t0) === 0);

console.log("B. secrets");
const keys = otpKeysFromEnv();
const e164 = "+972501234567";
const ph = phoneHashOf(keys.current, e164);
check("B1 the phone hash is 64 hex and never contains the number", /^[0-9a-f]{64}$/.test(ph) && !ph.includes("501234567"));
check("B2 phone / IP / code hashes are domain separated (the same input never collides across them)", phoneHashOf(keys.current, "1.2.3.4") !== ipHashOf(keys.current, "1.2.3.4"));
const ch = codeHashOf(keys.current, 7, ph, "123456");
check("B3 the code hash binds the business: the same phone + code at another business does not match", codeMatches(keys, ch, 7, [ph], "123456") && !codeMatches(keys, ch, 8, [ph], "123456"));
check("B4 …and the phone, and the code", !codeMatches(keys, ch, 7, [phoneHashOf(keys.current, "+972501234568")], "123456") && !codeMatches(keys, ch, 7, [ph], "123457"));
check("B5 constant-time compare: equal / different / different length", sameSecret("abc", "abc") && !sameSecret("abc", "abd") && !sameSecret("abc", "abcd"));
const rotated = otpKeysFromEnv({ TASK_REQUEST_HMAC_KEY: "g-lab-NEW-synthetic-request-hmac-key-0123456789", TASK_REQUEST_HMAC_KEY_PREVIOUS: process.env.TASK_REQUEST_HMAC_KEY });
check("B6 key rotation: a code written under the previous key still verifies within its 5 minutes", codeMatches(rotated, ch, 7, phoneHashesOf(rotated, e164), "123456"));
let threw = false;
try { otpKeysFromEnv({}); } catch { threw = true; }
check("B7 no key → refuses to run (fail closed)", threw);
const vAt = new Date("2026-12-01T10:01:02.345Z");
const tok = verificationTokenOf(keys.current, 7, 41, vAt);
check("B8 the verification token: 43 url-safe chars, bound to business + challenge + moment", VERIFICATION_TOKEN.test(tok)
  && tokenMatches(keys, tok, 7, 41, vAt) && !tokenMatches(keys, tok, 8, 41, vAt) && !tokenMatches(keys, tok, 7, 42, vAt) && !tokenMatches(keys, tok, 7, 41, new Date(vAt.getTime() + 1)));

console.log("C. the delivery path");
check("C1 nothing configured (simulate) → no path: the link stays unavailable", verificationDeliveryAvailable({}) === false);
check("C2 live without the token → still no path", verificationDeliveryAvailable({ WHATSAPP_PLATFORM_SEND_MODE: "live", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "100200300400" }) === false);
check("C3 live with every credential → a path", verificationDeliveryAvailable({ WHATSAPP_PLATFORM_SEND_MODE: "live", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "100200300400", WHATSAPP_PLATFORM_ACCESS_TOKEN: "x" }) === true);
check("C4 the lab switch opens a simulated path off production only", verificationDeliveryAvailable({ BOOKING_OTP_ALLOW_SIMULATED: "1" }) === true
  && verificationDeliveryAvailable({ BOOKING_OTP_ALLOW_SIMULATED: "1", VERCEL_ENV: "production" }) === false
  && verificationDeliveryAvailable({ BOOKING_OTP_ALLOW_SIMULATED: "true" }) === false);

console.log("D. G24 — what a customer may type");
const RLO = "\u202E", LRI = "\u2066", PDI = "\u2069", RLM = "\u200F";
check("D1 a name with a right-to-left override is refused (server)", parseContact({ name: `Dana${RLO}nhoj`, phone: "0501234567" }).ok === false
  && (parseContact({ name: `Dana${RLO}nhoj`, phone: "0501234567" }) as { field?: string }).field === "name");
check("D2 a name with an isolate or a mark is refused", nameTextProblem(`${LRI}Dana${PDI}`) && nameTextProblem(`Dana${RLM}`));
check("D3 a name with a control character (NUL, ESC, U+2028) is refused", nameTextProblem("Da\u0000na") && nameTextProblem("Da\u001bna") && nameTextProblem("Da\u2028na"));
check("D4 a note with a bidi control is refused; line breaks and tabs are fine", parseContact({ name: "דנה כהן", phone: "0501234567", note: `שלום${RLO}` }).ok === false
  && parseContact({ name: "דנה כהן", phone: "0501234567", note: "שורה 1\r\nשורה 2\tסוף" }).ok === true && noteTextProblem("a\u0007b"));
const pasted = "\u202A+972 50-123-4567\u202C";
check("D5 a phone pasted from WhatsApp (wrapped in U+202A … U+202C) is the same number", parsePublicPhone(pasted) === "972501234567" && parsePublicPhone("050-1234567") === "972501234567");
check("D6 a phone with any other control character is refused", parsePublicPhone("050\u00001234567") === null && parsePublicPhone("050\u20281234567") === null);
check("D7 stripPhoneBidi removes every bidi character", !hasBidiControl(stripPhoneBidi(`${RLM}${LRI}0501234567${PDI}\u061C`)));
check("D8 Hebrew, Arabic and Latin names and emoji pass", parseContact({ name: "נועה لينا Noa 🙂", phone: "0501234567" }).ok === true);
check("D9 the page agrees: a name with an override is flagged, a pasted WhatsApp number is not", !!checkContact(`Dana${RLO}x`, "0501234567", "").name && !checkContact("דנה כהן", pasted, "").phone);
check("D10 the page flags a note with a bidi control", !!checkContact("דנה כהן", "0501234567", `x${LRI}`).note);

console.log("E. G15");
const start = new Date("2026-12-10T08:00:00.000Z");
check("E1 self-reschedule OFF → never", selfReschedule({ enabled: false, windowHours: 24 }, start, new Date(start.getTime() - 100 * H)).allowed === false);
check("E2 ON, 24 h window: 25 h before → allowed until start − 24 h", (() => { const r = selfReschedule({ enabled: true, windowHours: 24 }, start, new Date(start.getTime() - 25 * H)); return r.allowed && r.until?.getTime() === start.getTime() - 24 * H; })());
check("E3 …23 h before → closed", selfReschedule({ enabled: true, windowHours: 24 }, start, new Date(start.getTime() - 23 * H)).allowed === false);
check("E4 window 0 → until the start itself", selfReschedule({ enabled: true, windowHours: 0 }, start, new Date(start.getTime() - MIN)).allowed && !selfReschedule({ enabled: true, windowHours: 0 }, start, new Date(start.getTime() + MIN)).allowed);
check("E5 the business horizon narrows a service's own, never widens it", effectiveHorizonDays(90, 30) === 30 && effectiveHorizonDays(30, 45) === 30 && effectiveHorizonDays(30, null) === 30 && effectiveHorizonDays(400, 500) === 365);
check("E5b D12: the default 60 keeps a service's longer horizon (90 stays 90, 365 stays 365); below 60 it is the service's own", effectiveHorizonDays(90, 60) === 90 && effectiveHorizonDays(365, 60) === 365 && effectiveHorizonDays(30, 60) === 30 && effectiveHorizonDays(60, 60) === 60);
check("E5c D12: any other business value narrows (61 caps a 90-day service at 61)", effectiveHorizonDays(90, 61) === 61 && effectiveHorizonDays(90, 59) === 59);
const end = new Date(start.getTime() + 45 * MIN);
const issued = new Date("2026-12-01T10:00:00.000Z");
check("E6 a manage link lives until 7 days after the appointment ENDS", MANAGE_LINK_GRACE_DAYS === 7 && manageLinkExpiry(issued, start, end).getTime() === end.getTime() + 7 * 24 * H);
check("E7 …without an end, 7 days after the start (unchanged for old callers)", manageLinkExpiry(issued, start).getTime() === start.getTime() + 7 * 24 * H);
check("E8 …at least an hour from now (an appointment already past)", manageLinkExpiry(issued, new Date(issued.getTime() - 30 * 24 * H)).getTime() === issued.getTime() + H);
check("E9 …and within 399 days of the link's issue, even when re-anchored later", manageLinkExpiry(new Date(issued.getTime() + 300 * 24 * H), new Date(issued.getTime() + 500 * 24 * H), null, issued).getTime() === issued.getTime() + 399 * 24 * H);

console.log("F. the page");
check("F1 the code step follows the details when the business requires it (always)", stepsForProfile({ staffChoice: "NONE", verification: { required: true, channel: "WHATSAPP" } }, []).join() === "service,time,details,verify");
check("F2 …and with the staff step: 5 steps (design c: 'שלב 4 מתוך 5')", stepsForProfile({ staffChoice: "OPTIONAL", verification: { required: true, channel: "WHATSAPP" } }, [{ staff: [{ id: 1, name: "דנה", color: null }] }]).length === 5);
check("F3 code digits: a pasted '123 456' / '123-456' → 123456; letters dropped; max 6", codeDigits("123 456") === "123456" && codeDigits("12-34-56-78") === "123456" && codeDigits("a1b2") === "12");
check("F4 countdown 0:42 / 1:00 / 0:00", countdown(42) === "0:42" && countdown(60) === "1:00" && countdown(-3) === "0:00");
check("F5 the phone shown: 050-123-4567 for an Israeli mobile, also from +972 and a WhatsApp paste", phoneShown("0501234567") === "050-123-4567" && phoneShown("+972501234567") === "050-123-4567" && phoneShown(pasted) === "050-123-4567");
check("F6 error kinds for the new codes", classify(403, "PHONE_NOT_VERIFIED") === "verify" && classify(422, "OTP_INVALID") === "code" && classify(429, "OTP_COOLDOWN") === "cooldown"
  && classify(429, "OTP_LIMIT") === "otpLimit" && classify(409, "SELF_RESCHEDULE_CLOSED") === "closed");
check("F7 retry-after read from details only when sane", retryAfterOf({ retryAfterSeconds: 42 }) === 42 && retryAfterOf({ retryAfterSeconds: -1 }) === null && retryAfterOf(null) === null);

console.log(`\n${total - failures} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
