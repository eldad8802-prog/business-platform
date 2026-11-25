/**
 * Customer WhatsApp messages (G1 / G13 / G14, appointments completion program) — the PURE parts. No database, NO
 * NETWORK (every send is simulated or goes to a fake `fetch` / fake sender).
 *
 *   1. templates      one file; every operational template names the business as {{1}}; every template marked
 *                     pending owner + Meta approval; a missing business name refuses the message; parameters are flat.
 *   2. catalog        customer categories are kept out of the user-facing catalog (preferences / settings / push
 *                     untouched); TTLs bounded; reminders respect quiet hours; the owner booking notice is generic on
 *                     the lock screen even with lockScreenDetails ON (G13).
 *   3. transport      simulate is the default, `live` without credentials still simulates, `live` + credentials uses
 *                     the sender; results classified; the graph template request's shape and classification.
 *   4. producer plan  which notice each journal event owes; keys carry the start; reminder offsets sanitised; E.164.
 *   5. lane checks    stillFits (state + start), status timestamps, metering month, the null quota.
 * Run: npx tsx lib/notifications/customer/customer-messages.test.ts
 */
import { getCategory, getCustomerCategory, NOTIFICATION_CATEGORIES, CUSTOMER_MESSAGE_CATEGORIES } from "../catalog";
import { buildPushMessage } from "../push/push-content";
import { planFor, reminderKey, noticeKey, reminderOffsets, startOfKey, toE164 } from "./appointment-messages";
import { platformConfig, platformPhoneNumberId, sendPlatformTemplate } from "./platform-transport";
import { statusInstant } from "./whatsapp-status";
import { stillFits } from "./whatsapp-worker";
import { meteringMonth, withinQuota, customerMessageQuota } from "./usage";
import { buildTemplateParams, renderTemplate, templateByName, templateParam, WHATSAPP_TEMPLATES } from "./whatsapp-templates";
import { sendWhatsAppTemplate } from "@/lib/services/integrations/whatsapp/graph.service";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 600));
  }
}

async function main() {
  // Never a real network call from this file.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("NETWORK FORBIDDEN IN TESTS"); }) as typeof fetch;

  console.log("1. templates");
  const all = Object.values(WHATSAPP_TEMPLATES);
  ok("nine templates, unique names, Meta-safe names", all.length === 9 && new Set(all.map((t) => t.name)).size === 9 && all.every((t) => /^[a-z0-9_]{1,64}$/.test(t.name)));
  ok("every template is marked pending owner AND Meta approval", all.every((t) => t.approval === "pending_owner_and_meta"));
  ok("every template is Hebrew", all.every((t) => t.language === "he" && /[֐-׿]/.test(t.body)));
  ok("every template names the business (a `business` parameter, used in the body)",
    all.every((t) => t.params.includes("business") && t.body.includes(`{{${t.params.indexOf("business") + 1}}}`)));
  ok("operational templates: the business is {{1}}", all.filter((t) => t.messageClass === "OPERATIONAL").every((t) => t.params[0] === "business"));
  ok("placeholders match the parameter count", all.every((t) => {
    const nums = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length === t.params.length && nums.every((n, i) => n === i + 1);
  }));
  ok("the link templates have a link; the no-link forms none", all.every((t) => t.name.endsWith("_nolink") ? !t.params.includes("link") : true)
    && ["dubiz_appt_confirmed", "dubiz_appt_changed", "dubiz_appt_reminder", "dubiz_appt_received"].every((n) => templateByName(n)!.params.includes("link")));
  ok("only the code is VERIFICATION", all.filter((t) => t.messageClass === "VERIFICATION").map((t) => t.name).join() === "dubiz_booking_code");
  const conf = WHATSAPP_TEMPLATES.appt_confirmed;
  ok("no business name ⇒ refused", buildTemplateParams(conf, { service: "תספורת", date: "א׳", time: "10:00", link: "https://x/book/manage" }) === null);
  ok("blank business name ⇒ refused", buildTemplateParams(conf, { business: "  ", service: "s", date: "d", time: "t", link: "l" }) === null);
  ok("a missing value ⇒ refused", buildTemplateParams(conf, { business: "מספרת דנה", service: "s", date: "d", time: "t" }) === null);
  const p = buildTemplateParams(conf, { business: "מספרת\nדנה    בע\"מ", service: "תספורת", date: "יום ב׳", time: "10:00", link: "https://app.example/book/manage#abc" });
  ok("parameters are flat (no new line, no run of spaces)", p !== null && p.every((x) => !/[\n\t]| {2,}/.test(x)), p);
  ok("rendered text names the business", p !== null && renderTemplate(conf, p).includes("מספרת דנה"));
  ok("templateParam keeps digits and text, flattens every line break", templateParam("10:00 בשעה 2028") === "10:00 בשעה 2028"
    && templateParam(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x85)}c\r\nd`) === "a b c d");
  ok("templateParam bounds the length", templateParam("א".repeat(500)).length <= 120 && templateParam("") === "-");

  console.log("2. catalog");
  const keys = CUSTOMER_MESSAGE_CATEGORIES.map((c) => c.key);
  ok("six customer categories", keys.length === 6 && new Set(keys).size === 6);
  ok("none of them is in the user-facing catalog (preferences, settings, push untouched)",
    keys.every((k) => getCategory(k) === null) && NOTIFICATION_CATEGORIES.every((c) => !keys.includes(c.key)));
  ok("all CUSTOMER / WHATSAPP / appointments, entitled by public_booking",
    CUSTOMER_MESSAGE_CATEGORIES.every((c) => c.recipient === "CUSTOMER" && c.channel === "WHATSAPP" && c.domain === "appointments" && c.featureKey === "public_booking"));
  ok("every template a category names exists", CUSTOMER_MESSAGE_CATEGORIES.every((c) => templateByName(c.template.withLink) && templateByName(c.template.noLink)));
  ok("TTL set on every category (stale messages are never sent)", CUSTOMER_MESSAGE_CATEGORIES.every((c) => Number.isInteger(c.ttlMinutes) && c.ttlMinutes > 0));
  ok("reminders, confirmations, changes, cancellations respect quiet hours", ["appointments.customer_reminder", "appointments.customer_confirmed", "appointments.customer_changed", "appointments.customer_cancelled"].every((k) => getCustomerCategory(k)!.quietBypass === false));
  ok("the verification code: VERIFICATION class, 5-minute TTL", getCustomerCategory("appointments.customer_verification")!.messageClass === "VERIFICATION" && getCustomerCategory("appointments.customer_verification")!.ttlMinutes === 5);
  const br = getCategory("booking.request_waiting")!;
  ok("G13: booking notices entitled under `appointments` (Basic)", br.featureKey === "appointments");
  const stored = { id: 1, title: "בקשה לתור: ישראל ישראלי", summary: "תספורת · א׳ 10:00", href: "/calendar?view=requests&request=7", entityType: "booking_request", entityId: 7 };
  const withDetails = buildPushMessage(br, stored, { lockScreenDetails: true, ttlSeconds: 600 });
  ok("G13: the lock screen stays generic even with lockScreenDetails ON (no customer name)",
    withDetails.title === br.lockScreen.title && withDetails.body === br.lockScreen.body && !JSON.stringify(withDetails).includes("ישראל"));
  const other = getCategory("inventory.critical_stock")!;
  ok("regression: other categories still show details when the user asked", buildPushMessage(other, { ...stored, entityType: "x" }, { lockScreenDetails: true, ttlSeconds: 600 }).title === stored.title);
  ok("regression: default (details OFF) unchanged", buildPushMessage(other, stored, { lockScreenDetails: false, ttlSeconds: 600 }).body === other.lockScreen.body);

  console.log("3. transport");
  ok("default: simulate", platformConfig({}).mode === "simulate");
  ok("unknown mode: simulate", platformConfig({ WHATSAPP_PLATFORM_SEND_MODE: "LIVE!", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "123456789", WHATSAPP_PLATFORM_ACCESS_TOKEN: "t" }).mode === "simulate");
  const mis = platformConfig({ WHATSAPP_PLATFORM_SEND_MODE: "live", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "123456789" });
  ok("live without a token: still simulate (live_misconfigured)", mis.mode === "simulate" && mis.reason === "live_misconfigured");
  ok("live with a malformed id: simulate", platformConfig({ WHATSAPP_PLATFORM_SEND_MODE: "live", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "abc", WHATSAPP_PLATFORM_ACCESS_TOKEN: "t" }).mode === "simulate");
  const liveEnv = { WHATSAPP_PLATFORM_SEND_MODE: "live", WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "123456789", WHATSAPP_PLATFORM_ACCESS_TOKEN: "tok" };
  ok("live + both credentials: live", platformConfig(liveEnv).mode === "live");
  ok("platform phone id read for the webhook (also in simulate)", platformPhoneNumberId({ WHATSAPP_PLATFORM_PHONE_NUMBER_ID: "123456789" }) === "123456789" && platformPhoneNumberId({}) === null);
  const msg = { toPhone: "+972501234567", templateName: "dubiz_appt_confirmed", languageCode: "he", bodyParams: ["a", "b"] };
  let senderCalls = 0;
  const sim = await sendPlatformTemplate(msg, { env: {}, send: async () => { senderCalls += 1; return { ok: true, providerMessageId: "wamid.X" }; } });
  ok("simulate: SENT with a sim:<uuid> id, the sender never called", sim.kind === "sent" && sim.simulated && /^sim:[0-9a-f-]{36}$/.test(sim.providerMessageId) && senderCalls === 0, sim);
  const liveOk = await sendPlatformTemplate(msg, { env: liveEnv, send: async (i) => { senderCalls += 1; return i.phoneNumberId === "123456789" && i.accessToken === "tok" ? { ok: true, providerMessageId: "wamid.ABC=" } : { ok: false, kind: "permanent", code: "x", message: "x" }; } });
  ok("live: the fake sender gets the platform credentials, its id is returned", liveOk.kind === "sent" && !liveOk.simulated && liveOk.providerMessageId === "wamid.ABC=" && senderCalls === 1);
  const tr = await sendPlatformTemplate(msg, { env: liveEnv, send: async () => ({ ok: false, kind: "transient", code: "template_429", message: "" }) });
  const au = await sendPlatformTemplate(msg, { env: liveEnv, send: async () => ({ ok: false, kind: "auth", code: "template_401", message: "" }) });
  const pe = await sendPlatformTemplate(msg, { env: liveEnv, send: async () => ({ ok: false, kind: "permanent", code: "template_400_132001", message: "" }) });
  ok("transient → transient; auth → transient (bounded retry); permanent → permanent", tr.kind === "transient" && au.kind === "transient" && pe.kind === "permanent");

  const calls: { url: string; body: unknown; auth: string }[] = [];
  const fakeFetch = (status: number, json: unknown) => (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  }) as unknown as typeof fetch;
  const base = { phoneNumberId: "123456789", accessToken: "tok", toPhone: "+972501234567", templateName: "dubiz_appt_confirmed", languageCode: "he", bodyParams: ["מספרה", "תספורת"] };
  const g1 = await sendWhatsAppTemplate({ ...base, fetchImpl: fakeFetch(200, { messages: [{ id: "wamid.HBg=" }] }) });
  const sent = calls[0]?.body as { to: string; type: string; template: { name: string; language: { code: string }; components: { type: string; parameters: { type: string; text: string }[] }[] } };
  ok("graph: POST /<id>/messages, a template, digits-only recipient, body params as text",
    g1.ok && calls[0].url.endsWith("/123456789/messages") && calls[0].auth === "Bearer tok" && sent.to === "972501234567" && sent.type === "template" &&
    sent.template.name === "dubiz_appt_confirmed" && sent.template.language.code === "he" &&
    sent.template.components[0].parameters.map((x) => x.text).join("|") === "מספרה|תספורת", sent);
  const c429 = await sendWhatsAppTemplate({ ...base, fetchImpl: fakeFetch(429, { error: { code: 130429 } }) });
  const c500 = await sendWhatsAppTemplate({ ...base, fetchImpl: fakeFetch(503, {}) });
  const c401 = await sendWhatsAppTemplate({ ...base, fetchImpl: fakeFetch(401, { error: { code: 190 } }) });
  const c400 = await sendWhatsAppTemplate({ ...base, fetchImpl: fakeFetch(400, { error: { code: 132001, message: "template does not exist" } }) });
  ok("graph: 429 / 5xx transient, 401 auth, unknown template permanent",
    !c429.ok && c429.kind === "transient" && !c500.ok && c500.kind === "transient" && !c401.ok && c401.kind === "auth" && !c400.ok && c400.kind === "permanent");
  const thrown = await sendWhatsAppTemplate({ ...base, fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
  ok("graph: a network error is transient", !thrown.ok && thrown.kind === "transient");
  ok("graph: missing inputs refused without a call", !(await sendWhatsAppTemplate({ ...base, accessToken: "" })).ok);

  console.log("4. producer plan");
  const now = new Date("2026-12-01T08:00:00.000Z");
  const later = new Date("2026-12-03T10:00:00.000Z");
  const P = (ev: string, status: string, pub: boolean, from: string | null = null, startsAt: Date | null = later) =>
    planFor(ev, { status, startsAt }, { publicRequest: pub, from, now });
  ok("created CONFIRMED ⇒ confirmed + reminders", P("APPOINTMENT_CREATED", "CONFIRMED", false).notice?.kind === "confirmed" && P("APPOINTMENT_CREATED", "CONFIRMED", false).reminders);
  ok("created PROPOSED from the link ⇒ received, no reminders", P("APPOINTMENT_CREATED", "PROPOSED", true).notice?.kind === "received" && !P("APPOINTMENT_CREATED", "PROPOSED", true).reminders);
  ok("created PROPOSED by the owner ⇒ nothing", P("APPOINTMENT_CREATED", "PROPOSED", false).notice === null);
  ok("confirmed ⇒ confirmed + reminders", P("APPOINTMENT_CONFIRMED", "CONFIRMED", true).notice?.kind === "confirmed" && P("APPOINTMENT_CONFIRMED", "CONFIRMED", true).reminders);
  ok("moved (confirmed) ⇒ changed", P("APPOINTMENT_RESCHEDULED", "CONFIRMED", false).notice?.kind === "changed");
  ok("self-rescheduled ⇒ changed", P("SELF_RESCHEDULED", "CONFIRMED", true).notice?.kind === "changed");
  ok("moved owner PROPOSED ⇒ nothing", P("APPOINTMENT_RESCHEDULED", "PROPOSED", false).notice === null);
  ok("cancelled from CONFIRMED ⇒ cancelled, no reminders", P("APPOINTMENT_CANCELED", "CANCELED", false, "CONFIRMED").notice?.kind === "cancelled" && !P("APPOINTMENT_CANCELED", "CANCELED", false, "CONFIRMED").reminders);
  ok("declined / expired public request ⇒ cancelled", P("APPOINTMENT_CANCELED", "CANCELED", true, "PROPOSED").notice?.kind === "cancelled");
  ok("cancelled owner PROPOSED (customer never told) ⇒ nothing", P("APPOINTMENT_CANCELED", "CANCELED", false, "PROPOSED").notice === null);
  ok("a past appointment ⇒ nothing at all", P("APPOINTMENT_CONFIRMED", "CONFIRMED", false, null, new Date("2026-11-30T10:00:00Z")).notice === null);
  ok("an untimed appointment ⇒ nothing", P("APPOINTMENT_CONFIRMED", "CONFIRMED", false, null, null).notice === null);
  ok("completed / no-show ⇒ no notice, no reminders", P("APPOINTMENT_COMPLETED", "COMPLETED", false).notice === null && !P("APPOINTMENT_COMPLETED", "COMPLETED", false).reminders);
  ok("details changed (confirmed) ⇒ no notice, reminders kept", P("APPOINTMENT_DETAILS_CHANGED", "CONFIRMED", false).notice === null && P("APPOINTMENT_DETAILS_CHANGED", "CONFIRMED", false).reminders);
  const rk = reminderKey(7, later, 1440);
  ok("the reminder key carries the start and the offset", rk === "wa:reminder:a7:2026-12-03T10:00:00.000Z:o1440" && startOfKey(rk)?.getTime() === later.getTime());
  ok("the notice key carries the start and the version", startOfKey(noticeKey("changed", 7, later, 3))?.getTime() === later.getTime() && noticeKey("changed", 7, later, 3).endsWith(":v3"));
  ok("a moved start ⇒ a different key", reminderKey(7, later, 1440) !== reminderKey(7, new Date(later.getTime() + 3600_000), 1440));
  ok("startOfKey refuses foreign keys", startOfKey("booking-request:7") === null && startOfKey("wa:verify:c1:s1") === null);
  ok("offsets: default 1440; invalid dropped; max 3; deduped", JSON.stringify(reminderOffsets(null)) === "[1440]" && JSON.stringify(reminderOffsets([10, 60, 60, 120, 1440, 20000, 2880])) === "[60,120,1440]");
  ok("E.164 from stored phones", toE164("0501234567") === "+972501234567" && toE164("972501234567") === "+972501234567" && toE164("12") === null && toE164(null) === null);

  console.log("5. lane checks");
  const cat = (k: string) => getCustomerCategory(k)!;
  const a = { status: "CONFIRMED", startsAt: later, erasedAt: null };
  ok("reminder fits a confirmed appointment at its start", stillFits(cat("appointments.customer_reminder"), a, rk));
  ok("reminder does not fit after a move", !stillFits(cat("appointments.customer_reminder"), { ...a, startsAt: new Date(later.getTime() + 60_000) }, rk));
  ok("reminder does not fit a cancelled one", !stillFits(cat("appointments.customer_reminder"), { ...a, status: "CANCELED" }, rk));
  ok("received does not fit once confirmed", !stillFits(cat("appointments.customer_received"), a, noticeKey("received", 7, later, 1)));
  ok("cancelled fits a cancelled one", stillFits(cat("appointments.customer_cancelled"), { ...a, status: "CANCELED" }, noticeKey("cancelled", 7, later, 2)));
  ok("an erased appointment never fits", !stillFits(cat("appointments.customer_confirmed"), { ...a, erasedAt: new Date() }, noticeKey("confirmed", 7, later, 1)));
  const sNow = new Date("2026-12-01T08:00:00Z");
  ok("status time: Meta's epoch seconds; absurd / future / missing ⇒ now",
    statusInstant("1764576000", sNow).getTime() === 1764576000_000 && statusInstant("9999999999", sNow) === sNow && statusInstant(null, sNow) === sNow && statusInstant("abc", sNow) === sNow);
  const m = meteringMonth(new Date("2026-11-30T22:30:00Z")); // 00:30 on 1 Dec in Jerusalem
  ok("metering month is Jerusalem's calendar month", m.period === "2026-12" && m.from.toISOString() === "2026-11-30T22:00:00.000Z" && m.to.toISOString() === "2026-12-31T22:00:00.000Z", m);
  ok("quota hook: null (no number invented) and null allows", (await customerMessageQuota(1)) === null && withinQuota(1_000_000, null) && !withinQuota(5, 5));

  globalThis.fetch = realFetch;
  console.log(`\n[customer-messages] PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
