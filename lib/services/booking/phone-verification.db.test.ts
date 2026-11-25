/**
 * Appointments completion, workstream G (G2 / G3 / G15 / G16 / G24) — end to end on a real database AS THE RESTRICTED
 * RUNTIME (app_runtime_prod: NOSUPERUSER NOBYPASSRLS) over every migration including 20261226090000_appointments_completion.
 * The WhatsApp transport is SIMULATED (workstream F's sendBookingVerificationCode with transport env {} — never a network
 * call: the global fetch throws). The owner role (OWNER_URL) writes fixtures and reads back only.
 *
 *   A. the door        no WhatsApp path that can deliver a code → the link answers 404 (G3: unavailable until Meta)
 *   B. a code          hashes only (no phone / code / IP in the row), 5-minute lifetime, one VERIFICATION delivery (SENT,
 *                      sim: id, the code stored nowhere); the cooldown; a wrong code counts an attempt
 *   C. mandatory       (owner requirement 8) a business whose stored requireVerification is FALSE: no token / a forged
 *                      token / a token for another phone → 403, nothing written; the stored value is never changed
 *   D. single use      verify once; the code cannot be verified again; the token books once (consumed in the request's
 *                      transaction, BookingRequest.phoneVerifiedAt set), a second request with it → 403
 *   E. supersede       a new code (after the cooldown) kills the previous one
 *   F. attempts        five wrong codes lock it: the right code afterwards fails too
 *   G. lifetime        an expired code fails; the database's guard refuses verifying it even directly
 *   H. caps            3 codes per phone per business per hour; the phone across businesses; the IP; the business
 *   I. isolation       A's code / token / rows are useless and invisible from B; the definer returns counts only
 *   J. no oracle       a phone with bookings and one without get the same answers (code request, unverified submit)
 *   K. G24             a verified customer's name with a bidi override is refused; a phone pasted with bidi marks works
 *   L. G3 enable       turning the link on needs eligibility, hours, services and the WhatsApp path (BOOKING_NOT_READY)
 *   M. G15             the self-reschedule window, free times excluding the appointment itself, the move journalled as
 *                      SELF_RESCHEDULED by the CUSTOMER with F's "changed" message owed, an occupied time refused, the
 *                      horizon, the manage link's expiry following the appointment's end
 *   N. G16             an unanswered request expires (system), the owner's list shows it, F's customer message is owed
 *
 * env: DATABASE_URL / DIRECT_URL = app_runtime_prod, OWNER_URL = the migration role. Synthetic only.
 * Run: npx tsx lib/services/booking/phone-verification.db.test.ts
 */
import { PrismaClient } from "@prisma/client";

delete process.env.WHATSAPP_PLATFORM_SEND_MODE;
delete process.env.WHATSAPP_PLATFORM_ACCESS_TOKEN;
delete process.env.BOOKING_OTP_ALLOW_SIMULATED;
process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID = "100200300400";
process.env.TASK_REQUEST_HMAC_KEY = "g-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = "g1";
process.env.APP_BASE_URL = "https://app.dubiz.example";
process.env.RATE_LIMIT_BACKEND = "memory";
globalThis.fetch = (async () => { throw new Error("NETWORK FORBIDDEN IN TESTS"); }) as typeof fetch;

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else { failed += 1; console.log(`  [FAIL] ${name}`, extra === undefined ? "" : JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? Number(v) : v)).slice(0, 900)); }
}
const codeOf = (e: unknown) => (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e));
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v, code: "" }), (e) => ({ ok: false as const, v: null, code: codeOf(e), details: (e as { details?: unknown })?.details }));

async function main() {
  const pb = await import("./public-booking.service");
  const pv = await import("./phone-verification.service");
  const admin = await import("./booking-admin.service");
  const { tenantTx } = await import("@/lib/tenant/tenant-tx");
  const { appendAppointmentEvent } = await import("@/lib/services/appointment/appointment-journal");
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const { prisma } = await import("@/lib/prisma");

  const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const stamp = Date.now();
  const RLO = String.fromCharCode(0x202e), LRE = String.fromCharCode(0x202a), PDF = String.fromCharCode(0x202c);

  /* ── fixtures (owner) ───────────────────────────────────────────────────────────────────────────── */
  for (const key of ["appointments", "public_booking", "notifications_engine"]) {
    await owner.$executeRawUnsafe(`INSERT INTO "PlatformFeatureDefinition" ("key", "displayName", "category", "description", "defaultEnabled", "mutable")
      VALUES ($1, $1, 'lab', 'lab', false, true) ON CONFLICT ("key") DO NOTHING`, key);
  }
  const biz = async (name: string, features: string[]) => {
    const b = await owner.business.create({ data: { name } });
    for (const k of features) {
      await owner.$executeRawUnsafe(`INSERT INTO "BusinessFeatureAccess" ("businessId", "featureKey", "state", "updatedAt") VALUES ($1, $2, 'ENABLED', now())`, b.id, k);
    }
    return b.id;
  };
  const publicIdOf = () => `g${stamp}${Math.random().toString(36).slice(2, 14)}`.padEnd(24, "x").slice(0, 24);
  const setup = async (b: number, requireVerification: boolean) => {
    const publicId = publicIdOf();
    await owner.bookingSettings.create({ data: { businessId: b, enabled: true, publicId, requireVerification, selfRescheduleEnabled: true, selfRescheduleWindowHours: 24, defaultApprovalMode: "AUTO" } });
    for (let weekday = 0; weekday < 7; weekday++) await owner.availabilityRule.create({ data: { businessId: b, weekday, startMinute: 480, endMinute: 1200 } });
    const svc = await owner.businessService.create({ data: { businessId: b, name: "טיפול פנים", type: "SERVICE", durationMinutes: 60 } });
    await owner.serviceBookingPolicy.create({ data: { businessId: b, businessServiceId: svc.id, publicBookable: true, approvalMode: "AUTO", slotStepMinutes: 30, maxAdvanceDays: 60 } });
    return { publicId, serviceId: svc.id };
  };
  const A = await biz(`סטודיו G ${stamp}`, ["appointments", "public_booking"]);
  const B = await biz(`עסק G-ב ${stamp}`, ["appointments", "public_booking"]);
  const C = await biz(`עסק G-ג ${stamp}`, ["appointments", "public_booking"]);
  const D = await biz(`עסק G-ד ${stamp}`, ["appointments", "public_booking"]);
  const sA = await setup(A, false); // stored requireVerification = FALSE — verification must still be mandatory
  const sB = await setup(B, true);
  const sC = await setup(C, true);
  const userD = (await owner.user.create({ data: { email: `g-d-${stamp}@apc.lab`, password: "x", businessId: D } })).id;

  const day = addCalendarDays(jerusalemDayKey(new Date()), 10);
  const at = (h: number, m = 0, d = day) => jerusalemInstantAt(d, h, m).toISOString();
  let phoneSeq = 30000000;
  const newPhone = () => `05${(phoneSeq++).toString().padStart(8, "0")}`;
  const digitsOf = (p: string) => `972${p.slice(1)}`;
  const codes: string[] = [];
  let nextCode = "";
  const send = { transport: { env: {} } };
  pv.__setOtpTestHooks({ deliveryAvailable: () => false, generateCode: () => { const c = nextCode || String(100000 + Math.floor(Math.random() * 899999)); nextCode = ""; codes.push(c); return c; }, send });
  const lastCode = () => codes[codes.length - 1];
  let ipSeq = 1;
  const ip = () => `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
  const issue = (publicId: string, phone: string, now?: Date, theIp = ip()) => settle(pb.requestPublicCode(publicId, { phone }, { ip: theIp, now }));
  const verify = (publicId: string, phone: string, code: string, now?: Date) => settle(pb.verifyPublicCode(publicId, { phone, code }, now));
  let keySeq = 0;
  const key = () => `g-key-${stamp}-${keySeq++}`;
  const submit = (s: { publicId: string; serviceId: number }, phone: string, startsAt: string, token?: string, name = "דנה כהן") =>
    settle(pb.submitPublicRequest(s.publicId, { serviceId: s.serviceId, startsAt, name, phone, ...(token ? { verificationToken: token } : {}) }, key()));
  const verifiedToken = async (s: { publicId: string }, phone: string) => {
    const r1 = await issue(s.publicId, phone);
    const r2 = await verify(s.publicId, phone, lastCode());
    if (!r1.ok || !r2.ok) throw new Error(`could not verify ${phone}: ${r1.code} ${r2.code}`);
    return r2.v!.verificationToken;
  };
  const challengesOf = (b: number) => owner.bookingPhoneChallenge.findMany({ where: { businessId: b }, orderBy: { id: "asc" } });
  const apptCount = (b: number) => owner.appointment.count({ where: { businessId: b } });

  /* ── A. the door ─────────────────────────────────────────────────────────────────────────────────── */
  console.log("A. the door (G3)");
  // One variable for every step answer (each a different shape): read loosely, checked field by field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: { ok: boolean; v: any; code: string; details?: unknown } = await settle(pb.getPublicProfile(sA.publicId));
  const r0 = await issue(sA.publicId, newPhone());
  ok("A1 no WhatsApp path that can deliver a code (simulate, the default): profile and code answer 404 — the link is unavailable", !r.ok && r.code === "NOT_FOUND" && !r0.ok && r0.code === "NOT_FOUND", { r, r0 });
  pv.__setOtpTestHooks({ deliveryAvailable: () => true, generateCode: () => { const c = nextCode || String(100000 + Math.floor(Math.random() * 899999)); nextCode = ""; codes.push(c); return c; }, send });
  r = await settle(pb.getPublicProfile(sA.publicId));
  ok("A2 with a delivery path: the profile opens and says verification is required (always)", r.ok && (r.v as { verification?: { required: boolean } }).verification?.required === true);

  /* ── B. a code ───────────────────────────────────────────────────────────────────────────────────── */
  console.log("B. a code");
  const p1 = newPhone();
  const t1 = new Date();
  const i1 = await issue(sA.publicId, p1, t1);
  let ch = await challengesOf(A);
  const c1 = ch[ch.length - 1];
  ok("B1 sent: 5-minute lifetime, resend in 60 s", i1.ok && i1.v!.expiresInSeconds === 300 && i1.v!.resendInSeconds === 60, i1);
  ok("B2 the row holds keyed hashes only — never the phone, the code or the IP", !!c1 && /^[0-9a-f]{64}$/.test(c1.phoneHash ?? "") && /^[0-9a-f]{64}$/.test(c1.codeHash ?? "") && /^[0-9a-f]{64}$/.test(c1.ipHash ?? "")
    && !JSON.stringify(c1).includes(p1.slice(1)) && !JSON.stringify(c1).includes(lastCode()));
  ok("B3 expiresAt = createdAt + 5 minutes; one send; no attempt yet", c1.expiresAt.getTime() - c1.createdAt.getTime() === 5 * MIN && c1.sends === 1 && c1.attempts === 0);
  const del = await owner.notificationDelivery.findMany({ where: { businessId: A, messageClass: "VERIFICATION" }, include: { notification: true } });
  ok("B4 one VERIFICATION delivery: SENT with a sim: id, template dubiz_booking_code, the code stored nowhere", del.length === 1 && del[0].status === "SENT" && (del[0].providerMessageId ?? "").startsWith("sim:")
    && del[0].templateKey === "dubiz_booking_code" && !JSON.stringify(del).includes(lastCode()), del);
  const i1b = await issue(sA.publicId, p1, new Date(t1.getTime() + 10_000));
  ok("B5 a second code 10 s later → OTP_COOLDOWN (retry in ~50 s), the first one still open", !i1b.ok && i1b.code === "OTP_COOLDOWN"
    && ((i1b as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds ?? 0) >= 49 && (await challengesOf(A)).length === ch.length);
  const code1 = lastCode();
  const wrong = code1 === "000000" ? "111111" : "000000";
  r = await verify(sA.publicId, p1, wrong);
  ok("B6 a wrong code → OTP_INVALID, one attempt counted", !r.ok && r.code === "OTP_INVALID" && (await owner.bookingPhoneChallenge.findUniqueOrThrow({ where: { id: c1.id } })).attempts === 1);
  r = await verify(sA.publicId, p1, "12ab");
  ok("B7 a malformed code → INVALID_INPUT (no attempt spent)", !r.ok && r.code === "INVALID_INPUT" && (await owner.bookingPhoneChallenge.findUniqueOrThrow({ where: { id: c1.id } })).attempts === 1);

  /* ── C. mandatory ────────────────────────────────────────────────────────────────────────────────── */
  console.log("C. mandatory verification (owner requirement 8)");
  const before = await apptCount(A);
  const n1 = await submit(sA, p1, at(10));
  const n2 = await submit(sA, p1, at(10), "A".repeat(43));
  ok("C1 business with requireVerification = FALSE: no token → PHONE_NOT_VERIFIED; a forged token → the same; nothing written",
    !n1.ok && n1.code === "PHONE_NOT_VERIFIED" && !n2.ok && n2.code === "PHONE_NOT_VERIFIED" && (await apptCount(A)) === before, { n1, n2 });

  /* ── D. single use ───────────────────────────────────────────────────────────────────────────────── */
  console.log("D. single use");
  const v1 = await verify(sA.publicId, p1, code1);
  ok("D1 the right code → a verification token; verifiedAt set", v1.ok && /^[A-Za-z0-9_-]{43}$/.test(v1.v!.verificationToken) && (await owner.bookingPhoneChallenge.findUniqueOrThrow({ where: { id: c1.id } })).verifiedAt !== null);
  r = await verify(sA.publicId, p1, code1);
  ok("D2 the same code again → OTP_INVALID (single use)", !r.ok && r.code === "OTP_INVALID");
  const other = await submit(sA, newPhone(), at(10), v1.v!.verificationToken);
  ok("D3 the token with another phone → PHONE_NOT_VERIFIED", !other.ok && other.code === "PHONE_NOT_VERIFIED");
  const b1 = await submit(sA, p1, at(10), v1.v!.verificationToken);
  const req1 = await owner.bookingRequest.findFirst({ where: { businessId: A, contactPhone: digitsOf(p1) } });
  const c1after = await owner.bookingPhoneChallenge.findUniqueOrThrow({ where: { id: c1.id } });
  ok("D4 the request with its token → CONFIRMED; phoneVerifiedAt = the verification moment; the challenge consumed", b1.ok && b1.v!.status === "CONFIRMED"
    && req1?.phoneVerifiedAt?.getTime() === c1after.verifiedAt?.getTime() && c1after.consumedAt !== null, { b1, req1 });
  const again = await submit(sA, p1, at(12), v1.v!.verificationToken);
  ok("D5 the same token for a second request → PHONE_NOT_VERIFIED", !again.ok && again.code === "PHONE_NOT_VERIFIED");
  ok("D6 the stored requireVerification is untouched (still FALSE)", (await owner.bookingSettings.findUniqueOrThrow({ where: { businessId: A } })).requireVerification === false);

  /* ── E. supersede ────────────────────────────────────────────────────────────────────────────────── */
  console.log("E. supersede");
  const p2 = newPhone();
  const tE = new Date();
  await issue(sA.publicId, p2, tE);
  const e1 = lastCode();
  await issue(sA.publicId, p2, new Date(tE.getTime() + 61_000));
  const e2 = lastCode();
  ch = (await challengesOf(A)).slice(-2);
  ok("E1 a new code after the cooldown supersedes the open one (one open per business + phone)", ch[0].supersededAt !== null && ch[1].supersededAt === null);
  r = e1 === e2 ? { ok: false, v: null, code: "OTP_INVALID" } as const : await verify(sA.publicId, p2, e1, new Date(tE.getTime() + 62_000));
  ok("E2 the superseded code → OTP_INVALID", !r.ok && r.code === "OTP_INVALID");
  r = await verify(sA.publicId, p2, e2, new Date(tE.getTime() + 63_000));
  ok("E3 the new code → verified", r.ok);

  /* ── F. attempts ─────────────────────────────────────────────────────────────────────────────────── */
  console.log("F. attempts");
  const p3 = newPhone();
  await issue(sA.publicId, p3);
  const f1 = lastCode();
  const bad = f1 === "999999" ? "888888" : "999999";
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push(await verify(sA.publicId, p3, bad));
  r = await verify(sA.publicId, p3, f1);
  const fRow = (await challengesOf(A)).slice(-1)[0];
  ok("F1 five wrong codes → five OTP_INVALID; then the RIGHT code fails too (locked); attempts = 5", tries.every((x) => !x.ok && x.code === "OTP_INVALID") && !r.ok && fRow.attempts === 5 && fRow.verifiedAt === null, fRow);
  const burstPhone = newPhone();
  await issue(sA.publicId, burstPhone);
  const bCode = lastCode();
  const guesses = Array.from({ length: 12 }, (_, i) => String((Number(bCode) + 1 + i) % 1_000_000).padStart(6, "0"));
  await Promise.all(guesses.map((g) => verify(sA.publicId, burstPhone, g)));
  const bRow = (await challengesOf(A)).slice(-1)[0];
  ok("F2 twelve parallel wrong guesses: the counter never passes 5 and never wraps (row locked per check)", bRow.attempts === 5);

  /* ── G. lifetime ─────────────────────────────────────────────────────────────────────────────────── */
  console.log("G. lifetime");
  const p4 = newPhone();
  const old = new Date(Date.now() - 6 * MIN);
  await issue(sA.publicId, p4, old);
  r = await verify(sA.publicId, p4, lastCode());
  ok("G1 a code issued 6 minutes ago → OTP_INVALID (expired)", !r.ok && r.code === "OTP_INVALID");
  const gRow = (await challengesOf(A)).slice(-1)[0];
  const direct = await settle(tenantTx(A, (tx) => tx.bookingPhoneChallenge.update({ where: { id: gRow.id }, data: { verifiedAt: new Date() } })));
  ok("G2 even directly, the database's guard refuses verifying an expired code (DZA05)", !direct.ok && /DZA05|BOOKING_CHALLENGE_GUARD/.test(JSON.stringify(direct)), direct);

  /* ── H. caps ─────────────────────────────────────────────────────────────────────────────────────── */
  console.log("H. caps (proposed values)");
  const p5 = newPhone();
  const tH = new Date();
  const h = [];
  for (let i = 0; i < 4; i++) h.push(await issue(sA.publicId, p5, new Date(tH.getTime() + i * 61_000)));
  ok("H1 one phone at one business: 3 codes in an hour, the 4th → OTP_LIMIT", h.slice(0, 3).every((x) => x.ok) && !h[3].ok && h[3].code === "OTP_LIMIT", h.map((x) => x.code));
  const h2 = [await issue(sB.publicId, p5, new Date(tH.getTime() + 300_000)), await issue(sB.publicId, p5, new Date(tH.getTime() + 361_000)), await issue(sB.publicId, p5, new Date(tH.getTime() + 422_000))];
  ok("H2 the same phone at another business: 2 more allowed (5 per hour platform-wide), the 3rd → OTP_LIMIT", h2[0].ok && h2[1].ok && !h2[2].ok && h2[2].code === "OTP_LIMIT", h2.map((x) => x.code));
  const ipX = "10.250.0.9";
  const hashes = await import("./phone-verification.core");
  const keys = hashes.otpKeysFromEnv();
  const ipHash = hashes.ipHashOf(keys.current, ipX);
  for (let i = 0; i < 10; i++) {
    await owner.bookingPhoneChallenge.create({ data: { businessId: C, phoneHash: hashes.phoneHashOf(keys.current, `+97252${String(i).padStart(7, "0")}`), codeHash: "0".repeat(64), ipHash, createdAt: new Date(Date.now() - 20 * MIN), expiresAt: new Date(Date.now() - 15 * MIN), supersededAt: new Date(Date.now() - 15 * MIN) } });
  }
  const hIp = await issue(sB.publicId, newPhone(), undefined, ipX);
  ok("H3 one IP: 10 codes in the last hour (at another business) → the 11th anywhere → OTP_LIMIT", !hIp.ok && hIp.code === "OTP_LIMIT", hIp);
  for (let i = 0; i < 30; i++) {
    await owner.bookingPhoneChallenge.create({ data: { businessId: C, phoneHash: hashes.phoneHashOf(keys.current, `+97253${String(i).padStart(7, "0")}`), codeHash: "0".repeat(64), createdAt: new Date(Date.now() - 30 * MIN), expiresAt: new Date(Date.now() - 25 * MIN), supersededAt: new Date(Date.now() - 25 * MIN) } });
  }
  const hBiz = await issue(sC.publicId, newPhone());
  ok("H4 one business: 30+ codes in the last hour → OTP_LIMIT (a ceiling on what one link can cost)", !hBiz.ok && hBiz.code === "OTP_LIMIT", hBiz);
  const counts = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM public.booking_otp_send_counts($1, $2, (now() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 hour')`, hashes.phoneHashOf(keys.current, `+972${p5.slice(1)}`), ipHash);
  ok("H5 the platform-wide counts come from a definer that returns counts only (phoneSends, ipSends)", Object.keys(counts[0]).sort().join() === "ipSends,phoneSends" && Number(counts[0].ipSends) === 10 && Number(counts[0].phoneSends) === 5, counts);

  /* ── I. isolation ────────────────────────────────────────────────────────────────────────────────── */
  console.log("I. isolation");
  const p6 = newPhone();
  await issue(sA.publicId, p6);
  const aCode = lastCode();
  r = await verify(sB.publicId, p6, aCode);
  ok("I1 A's code typed on B's link → OTP_INVALID (the challenge is A's)", !r.ok && r.code === "OTP_INVALID");
  const aTok = await verify(sA.publicId, p6, aCode);
  const onB = await submit(sB, p6, at(10), aTok.v?.verificationToken);
  ok("I2 A's verification token on B's link → PHONE_NOT_VERIFIED", aTok.ok && !onB.ok && onB.code === "PHONE_NOT_VERIFIED");
  const seen = await tenantTx(B, (tx) => tx.bookingPhoneChallenge.count({ where: { businessId: A } }));
  const changed = await tenantTx(B, (tx) => tx.bookingPhoneChallenge.updateMany({ where: { businessId: A }, data: { attempts: 5 } }));
  ok("I3 B's tenant transaction sees none of A's challenges and changes none (FORCE RLS)", seen === 0 && changed.count === 0, { seen, changed });
  const noCtx = await settle(prisma.bookingPhoneChallenge.count());
  ok("I4 the runtime with no tenant context sees no challenge at all", (noCtx.ok && noCtx.v === 0) || !noCtx.ok, noCtx);
  const insB = await settle(tenantTx(B, (tx) => tx.bookingPhoneChallenge.create({ data: { businessId: A, phoneHash: "a".repeat(64), codeHash: "b".repeat(64) } })));
  ok("I5 B cannot write a challenge for A", !insB.ok);

  /* ── J. no oracle ────────────────────────────────────────────────────────────────────────────────── */
  console.log("J. no oracle");
  const known = p1; // has a CONFIRMED booking at A (D4)
  const fresh = newPhone();
  const jk = await issue(sA.publicId, known, new Date(Date.now() + 10 * MIN));
  const jf = await issue(sA.publicId, fresh, new Date(Date.now() + 10 * MIN));
  ok("J1 a code for a phone WITH bookings and one without: the same answer", jk.ok && jf.ok && JSON.stringify(jk.v) === JSON.stringify(jf.v), { jk, jf });
  const uk = await submit(sA, known, at(14));
  const uf = await submit(sA, fresh, at(14));
  ok("J2 an unverified request for either: the same refusal (PHONE_NOT_VERIFIED, before any booking is looked at)", !uk.ok && !uf.ok && uk.code === uf.code && uk.code === "PHONE_NOT_VERIFIED");

  /* ── K. G24 ──────────────────────────────────────────────────────────────────────────────────────── */
  console.log("K. bidi and control characters");
  const p7 = newPhone();
  const pasted = `${LRE}+972 ${p7.slice(1, 3)}-${p7.slice(3, 6)}-${p7.slice(6)}${PDF}`;
  const tok7 = await verifiedToken(sA, pasted);
  const k1 = await submit(sA, p7, at(15), tok7, `Dana${RLO}nhoJ`);
  ok("K1 a phone pasted with bidi marks verifies; a name with a right-to-left override is refused (INVALID_INPUT name)", !k1.ok && k1.code === "INVALID_INPUT" && (k1 as { details?: { field?: string } }).details?.field === "name", k1);
  const k2 = await submit(sA, p7, at(15), tok7, "Dana Cohen");
  ok("K2 …the refused request did not spend the verification: the same token books with a clean name", k2.ok, k2);

  /* ── L. G3 enable ────────────────────────────────────────────────────────────────────────────────── */
  console.log("L. turning the link on (G3)");
  const principalD = { kind: "OWNER" as const, businessId: D, userId: userD };
  r = await settle(admin.updateBookingSettings(principalD, { enabled: true }));
  ok("L1 no hours, no open service → BOOKING_NOT_READY naming them", !r.ok && r.code === "BOOKING_NOT_READY" && JSON.stringify((r as { details?: unknown }).details).includes("hours") && JSON.stringify((r as { details?: unknown }).details).includes("services"), r);
  const sD = await (async () => {
    for (let weekday = 0; weekday < 7; weekday++) await owner.availabilityRule.create({ data: { businessId: D, weekday, startMinute: 480, endMinute: 1200 } });
    const svc = await owner.businessService.create({ data: { businessId: D, name: "ייעוץ", type: "SERVICE", durationMinutes: 30 } });
    await owner.serviceBookingPolicy.create({ data: { businessId: D, businessServiceId: svc.id, publicBookable: true, approvalMode: "AUTO" } });
    return svc.id;
  })();
  pv.__setOtpTestHooks({ deliveryAvailable: () => false, send });
  r = await settle(admin.updateBookingSettings(principalD, { enabled: true }));
  ok("L2 hours + a service, but no WhatsApp path → BOOKING_NOT_READY [whatsapp]", !r.ok && r.code === "BOOKING_NOT_READY" && JSON.stringify((r as { details?: unknown }).details) === JSON.stringify({ missing: ["whatsapp"] }), r);
  pv.__setOtpTestHooks({ deliveryAvailable: () => true, generateCode: () => { const c = String(100000 + Math.floor(Math.random() * 899999)); codes.push(c); return c; }, send });
  r = await settle(admin.updateBookingSettings(principalD, { enabled: true, requireVerification: false } as Record<string, unknown>));
  const dRow = await owner.bookingSettings.findUnique({ where: { businessId: D } });
  ok("L3 everything ready → the owner turns it on; requireVerification is not accepted from the input (stays the column default)", r.ok && dRow?.enabled === true && dRow.requireVerification === true && sD > 0, { r, dRow });
  r = await settle(admin.getBookingSettings(principalD));
  ok("L4 the settings answer carries readiness (ready, verification required) and the new fields", r.ok && (r.v as { readiness: { ready: boolean; verification: string } }).readiness.ready === true
    && (r.v as { readiness: { verification: string } }).readiness.verification === "required" && (r.v as { settings: { bookingHorizonDays: number } }).settings.bookingHorizonDays === 60);
  r = await settle(admin.updateBookingSettings(principalD, { reminderOffsetsMinutes: [60, 1440, 180, 30] }));
  const r2 = await settle(admin.updateBookingSettings(principalD, { reminderOffsetsMinutes: [60, 1440], bookingHorizonDays: 30, selfRescheduleEnabled: true, selfRescheduleWindowHours: 12, showLogo: true }));
  ok("L5 four reminder times refused; up to three accepted with the other new fields", !r.ok && r.code === "INVALID_INPUT" && r2.ok
    && JSON.stringify((await owner.bookingSettings.findUniqueOrThrow({ where: { businessId: D } })).reminderOffsetsMinutes) === "[1440,60]");

  /* ── M. G15 ──────────────────────────────────────────────────────────────────────────────────────── */
  console.log("M. self-reschedule and the manage link");
  const manageToken = (b1.v as { manageToken: string }).manageToken;
  const appt1 = await owner.appointment.findFirstOrThrow({ where: { id: req1!.appointmentId } });
  const tok1 = await owner.appointmentManageToken.findFirstOrThrow({ where: { appointmentId: appt1.id, revokedAt: null } });
  ok("M1 the manage link expires 7 days after the appointment ENDS", tok1.expiresAt.getTime() === appt1.endsAt!.getTime() + 7 * DAY, { tok1, appt1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let view: { ok: boolean; v: any; code: string; details?: unknown } = await settle(pb.viewByToken(manageToken));
  ok("M2 confirmed, 10 days ahead, window 24 h → may reschedule", view.ok && view.v!.canReschedule === true && view.v!.selfRescheduleEnabled === true);
  const sl = await settle(pb.rescheduleSlotsByToken(manageToken, { fromDay: day, toDay: day }));
  const starts = sl.ok ? sl.v!.slots.map((x) => x.startsAt) : [];
  ok("M3 free times exclude the current start but include 10:30 (overlapping its own hour — itself is not busy)", sl.ok && !starts.includes(at(10)) && starts.includes(at(10, 30)), sl);
  const pBusy = newPhone();
  const busyBooked = await submit(sA, pBusy, at(13), await verifiedToken(sA, pBusy));
  r = await settle(pb.rescheduleByToken(manageToken, { startsAt: at(13) }));
  ok("M4 moving onto another booking's time → SLOT_UNAVAILABLE", busyBooked.ok && !r.ok && r.code === "SLOT_UNAVAILABLE", r);
  r = await settle(pb.rescheduleByToken(manageToken, { startsAt: at(10, 30) }));
  const appt1b = await owner.appointment.findFirstOrThrow({ where: { id: appt1.id } });
  const ev = await owner.appointmentEvent.findFirst({ where: { appointmentId: appt1.id, eventType: "SELF_RESCHEDULED" } });
  const changedMsg = await owner.notificationDelivery.count({ where: { businessId: A, appointmentId: appt1.id, notification: { semanticCategory: "appointments.customer_changed" } } });
  const tok1b = await owner.appointmentManageToken.findFirstOrThrow({ where: { id: tok1.id } });
  ok("M5 moved to 10:30: journalled SELF_RESCHEDULED by the CUSTOMER", r.ok && appt1b.startsAt!.toISOString() === at(10, 30) && ev?.actor === "CUSTOMER" && appt1b.version === appt1.version + 1, { r, ev });
  ok("M6 …F's 'changed' WhatsApp is owed (no extra call) and the manage link follows the new end", changedMsg >= 1 && tok1b.expiresAt.getTime() === appt1b.endsAt!.getTime() + 7 * DAY, { changedMsg, tok1b });
  const bell = await owner.notification.findFirst({ where: { businessId: A, dedupeKey: `booking-request:${req1!.id}` } });
  ok("M7 the owner is told in the bell (name isolated)", !!bell && bell.title.includes("שינה/תה את מועד התור"), bell?.title);
  await owner.bookingSettings.update({ where: { businessId: A }, data: { selfRescheduleWindowHours: 720 } });
  view = await settle(pb.viewByToken(manageToken));
  r = await settle(pb.rescheduleByToken(manageToken, { startsAt: at(11) }));
  ok("M8 inside the window (720 h) → canReschedule false and the move → SELF_RESCHEDULE_CLOSED", view.ok && view.v!.canReschedule === false && !r.ok && r.code === "SELF_RESCHEDULE_CLOSED");
  await owner.bookingSettings.update({ where: { businessId: A }, data: { selfRescheduleWindowHours: 24, selfRescheduleEnabled: false } });
  r = await settle(pb.rescheduleByToken(manageToken, { startsAt: at(11) }));
  ok("M9 self-reschedule switched off → SELF_RESCHEDULE_CLOSED", !r.ok && r.code === "SELF_RESCHEDULE_CLOSED");
  await owner.bookingSettings.update({ where: { businessId: A }, data: { selfRescheduleEnabled: true, bookingHorizonDays: 5 } });
  const far = await settle(pb.getPublicSlots(sA.publicId, { serviceId: sA.serviceId, fromDay: day, toDay: day }));
  const prof = await settle(pb.getPublicProfile(sA.publicId));
  ok("M10 the business horizon (5 days) closes day 10 and narrows the service's 60 days", far.ok && far.v!.slots.length === 0
    && prof.ok && (prof.v as { services: { maxAdvanceDays: number }[] }).services[0].maxAdvanceDays === 5, far);
  await owner.bookingSettings.update({ where: { businessId: A }, data: { bookingHorizonDays: 60 } });
  const late = new Date(appt1b.endsAt!.getTime() + 7 * DAY + MIN);
  view = await settle(pb.viewByToken(manageToken, late));
  ok("M11 a minute after end + 7 days the manage link no longer opens (404)", !view.ok && view.code === "NOT_FOUND", view);
  await tenantTx(A, (tx) => tx.appointment.update({ where: { id: appt1.id }, data: { startsAt: new Date(appt1b.startsAt!.getTime() + 20 * DAY), endsAt: new Date(appt1b.endsAt!.getTime() + 20 * DAY), version: { increment: 1 } } }));
  await tenantTx(A, (tx) => appendAppointmentEvent(tx, { businessId: A, appointmentId: appt1.id, eventType: "APPOINTMENT_RESCHEDULED", ctx: { actor: "SYSTEM", userId: null, sourceChannel: "PUBLIC_BOOKING" }, payload: { lab: true } }));
  const tok1c = await owner.appointmentManageToken.findFirstOrThrow({ where: { id: tok1.id } });
  ok("M12 an owner move 20 days later re-anchors the link through the journal (it does not die before the appointment)", tok1c.expiresAt.getTime() === appt1b.endsAt!.getTime() + 27 * DAY, tok1c);

  /* ── N. G16 ──────────────────────────────────────────────────────────────────────────────────────── */
  console.log("N. an unanswered request expires");
  const manualSvc = await owner.businessService.create({ data: { businessId: B, name: "באישור", type: "SERVICE", durationMinutes: 30 } });
  await owner.serviceBookingPolicy.create({ data: { businessId: B, businessServiceId: manualSvc.id, publicBookable: true, approvalMode: "MANUAL", slotStepMinutes: 30 } });
  const p8 = newPhone();
  const pend = await submit({ publicId: sB.publicId, serviceId: manualSvc.id }, p8, at(16), await verifiedToken(sB, p8));
  const reqP = await owner.bookingRequest.findFirstOrThrow({ where: { businessId: B, contactPhone: digitsOf(p8) } });
  await owner.bookingRequest.update({ where: { id: reqP.id }, data: { expiresAt: new Date(Date.now() - MIN) } });
  const done = await tenantTx(B, (tx) => pb.expireDueRequests(tx, B, new Date()));
  const reqP2 = await owner.bookingRequest.findUniqueOrThrow({ where: { id: reqP.id } });
  const cancelledMsg = await owner.notificationDelivery.count({ where: { businessId: B, appointmentId: reqP.appointmentId, notification: { semanticCategory: "appointments.customer_cancelled" } } });
  const listed = await admin.listBookingRequests({ kind: "OWNER", businessId: B, userId: 0 });
  ok("N1 a pending request past its hold → EXPIRED by the system, the time released", pend.ok && pend.v!.status === "PENDING" && done.includes(reqP.id) && reqP2.status === "EXPIRED");
  ok("N2 the owner's list shows it as expired (recent), and F's customer message is owed (category customer_cancelled)", listed.recent.some((x) => x.id === reqP.id && x.status === "EXPIRED") && cancelledMsg === 1, { cancelledMsg });

  pv.__setOtpTestHooks(null);
  await owner.$disconnect();
  await prisma.$disconnect();
  console.log(`\n${checks - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
