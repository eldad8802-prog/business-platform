/**
 * Appointments OPEN FOR EVERY BUSINESS (migration 20261121090000_appointments_open_all + catalog default ON) — the REAL
 * route handlers AS the restricted runtime (DATABASE_URL = app_runtime_prod, NOSUPERUSER NOBYPASSRLS) on the
 * Production-shaped lab after `.appt/open-all-lab.sh` released the migration. Real signed session tokens; the owner
 * connection only builds fixtures, flips the lab's switches and reads back.
 *
 * Businesses (from .appt/ui-seed.ts, created BEFORE the release): A = the pilot (override ENABLED, as business 9),
 * B = closed by a platform admin (override DISABLED), C = an existing business with no override. D is created AFTER the
 * release through the real signup service (createAccount — the path every new account takes, the Google Play app
 * included): it gets no override row, so it follows the default.
 *
 *   R. The rule: the catalog says ON for appointments and OFF for public_booking; the resolver opens a business with
 *      no override only while the policy is ON (so the code reaching Production BEFORE the migration opens nothing),
 *      DISABLED and the emergency switch still close it.
 *   E. Existing (C) and new (D): GET /api/business/capabilities says appointments ON (CATALOG_DEFAULT) and
 *      public_booking OFF; the calendar API answers; staff, an appointment, a list.
 *   X. Overlap: the same staff lane at the same time → 409 SLOT_CONFLICT; six simultaneous bookings of one slot →
 *      exactly one.
 *   I. Isolation: D cannot read, list or change C's appointment (404, unchanged); C does not see D's.
 *   K. Decisions kept: B (DISABLED) → capabilities OFF, every route 404, nothing written; A (ENABLED) stays ON.
 *   P. External booking stays closed for D: turning the link on → 409 BOOKING_CLOSED, nothing written; a new link is
 *      refused; the public door answers 404.
 *   S. Stops: the policy's emergency switch closes C, D and A (an ENABLED override does not beat it); the policy back
 *      OFF (= Production before the migration) closes C and D but leaves A. Both restored.
 *
 * Writes { bizD, tokenD } to $OPEN_OUT for the browser e2e. env: OWNER_URL, DATABASE_URL (runtime), SEED_OUT, OPEN_OUT.
 * Synthetic only. ZERO network.
 */
process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || "appt-lab-synthetic-auth-token-secret-0123456789";
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "appt-lab-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
process.env.RATE_LIMIT_BACKEND = "memory";

import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });
const seed = JSON.parse(readFileSync(process.env.SEED_OUT!, "utf8")) as { bizA: number; bizB: number; bizC: number; tokenA: string; tokenB: string; tokenC: string };

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const { createAccount } = await import("@/lib/auth/signup");
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const { getPlatformFeatureCatalogEntry } = await import("@/lib/services/feature-access/platform-feature-catalog");
  const { resolveFeatureAccessFromInputs } = await import("@/lib/services/feature-access/resolve-feature-access");
  const routes = {
    capabilities: await import("@/app/api/business/capabilities/route"),
    root: await import("@/app/api/appointments/route"),
    one: await import("@/app/api/appointments/[id]/route"),
    details: await import("@/app/api/appointments/[id]/details/route"),
    staff: await import("@/app/api/appointments/staff/route"),
    settings: await import("@/app/api/appointments/booking/settings/route"),
    link: await import("@/app/api/appointments/booking/settings/link/route"),
    door: await import("@/app/api/public/booking/[publicId]/route"),
  };

  const BASE = "https://app.example.com";
  const req = (path: string, token: string | null, init: { method?: string; body?: unknown; key?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return new NextRequest(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
  const body = async (r: Response) => { try { return await r.json(); } catch { return null; } };
  const n = async (sql: string) => Number(((await owner.$queryRawUnsafe(sql)) as { n: number }[])[0].n);
  const key = () => uuidV7(new Date());
  const day = addCalendarDays(jerusalemDayKey(new Date()), 7);
  const at = (h: number, m = 0) => jerusalemInstantAt(day, h, m).toISOString();
  const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(jerusalemInstantAt(addCalendarDays(day, 1), 0, 0).toISOString())}`;
  const caps = async (token: string) => (await body(await routes.capabilities.GET(req("/api/business/capabilities", token))))?.features ?? {};
  const list = (token: string) => routes.root.GET(req(`/api/appointments?${range}`, token));

  // ── R. The rule ────────────────────────────────────────────────────────────────────────────────
  console.log("R. the rule");
  ok("R1 the catalog: appointments ON by default, public_booking still OFF",
    getPlatformFeatureCatalogEntry("appointments").defaultEnabled === true && getPlatformFeatureCatalogEntry("public_booking").defaultEnabled === false);
  const rule = (policy: { globalEnabled: boolean; emergencyDisabled: boolean } | null, state: "ENABLED" | "DISABLED" | null) =>
    resolveFeatureAccessFromInputs({ featureKey: "appointments", catalogDefaultEnabled: true, policy, override: state ? { state } : null } as Parameters<typeof resolveFeatureAccessFromInputs>[0]);
  const r2 = rule({ globalEnabled: true, emergencyDisabled: false }, null);
  ok("R2 policy ON, no override → open (CATALOG_DEFAULT)", r2.allowed && r2.reasonCode === "CATALOG_DEFAULT", JSON.stringify(r2));
  const r3 = rule({ globalEnabled: false, emergencyDisabled: false }, null);
  ok("R3 policy still OFF (Production before the migration), no override → closed (GLOBAL_DEFAULT): the code alone opens nothing",
    !r3.allowed && r3.reasonCode === "GLOBAL_DEFAULT", JSON.stringify(r3));
  const r4 = rule({ globalEnabled: true, emergencyDisabled: false }, "DISABLED");
  ok("R4 policy ON, override DISABLED → closed (BUSINESS_DISABLED)", !r4.allowed && r4.reasonCode === "BUSINESS_DISABLED");
  const r5 = rule({ globalEnabled: true, emergencyDisabled: true }, "ENABLED");
  ok("R5 the emergency switch beats an ENABLED override (EMERGENCY_DISABLED)", !r5.allowed && r5.reasonCode === "EMERGENCY_DISABLED");

  // ── D, a new account after the release ─────────────────────────────────────────────────────────
  const tag = `appt-open-${Date.now()}`;
  const account = await createAccount({ email: `${tag}@lab.test`, passwordHash: "x", name: "בעלת עסק חדש", businessName: `${tag}-D`, now: new Date() });
  const bizD = account.businessId;
  const tokenD = signAuthToken(account.userId, account.tokenVersion);
  ok("D0 the real signup creates the business with no feature override (it follows the default)",
    (await n(`SELECT count(*)::int AS n FROM "BusinessFeatureAccess" WHERE "businessId" = ${bizD}`)) === 0);

  // ── E. Existing and new ────────────────────────────────────────────────────────────────────────
  console.log("E. existing (C) and new (D)");
  const ids: Record<string, number> = {};
  for (const [label, token, biz] of [["C existing", seed.tokenC, seed.bizC], ["D new", tokenD, bizD]] as const) {
    const f = await caps(token);
    ok(`E1 ${label}: capabilities — appointments ON (CATALOG_DEFAULT), public_booking OFF`,
      f.appointments?.allowed === true && f.appointments?.reasonCode === "CATALOG_DEFAULT" && f.public_booking?.allowed === false, JSON.stringify({ a: f.appointments, p: f.public_booking }));
    let r = await list(token);
    ok(`E2 ${label}: GET /api/appointments → 200`, r.status === 200, String(r.status));
    r = await routes.staff.POST(req("/api/appointments/staff", token, { method: "POST", body: { displayName: "נועם" } }));
    const staff = (await body(r))?.staffMember;
    ok(`E3 ${label}: a staff member is created (201)`, r.status === 201 && staff?.id > 0, String(r.status));
    ids[`staff${label[0]}`] = staff?.id;
    r = await routes.root.POST(req("/api/appointments", token, { method: "POST", key: key(), body: { kind: "INTERNAL", title: "פגישת היכרות", startsAt: at(10), durationMinutes: 30, staffMemberId: staff?.id } }));
    const appt = (await body(r))?.appointment;
    ok(`E4 ${label}: an appointment is created (201) in its own business`, r.status === 201 && appt?.id > 0
      && (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE id = ${Number(appt?.id) || 0} AND "businessId" = ${biz}`)) === 1, String(r.status));
    ids[`appt${label[0]}`] = appt?.id;
    const listed = (await body(await list(token)))?.appointments ?? [];
    ok(`E5 ${label}: the list holds it`, listed.some((a: { id: number }) => a.id === appt?.id));
  }

  // ── X. Overlap ─────────────────────────────────────────────────────────────────────────────────
  console.log("X. overlap");
  let r = await routes.root.POST(req("/api/appointments", tokenD, { method: "POST", key: key(), body: { kind: "INTERNAL", title: "חפיפה", startsAt: at(10, 15), durationMinutes: 30, staffMemberId: ids.staffD } }));
  const clash = await body(r);
  ok("X1 the same lane over an existing appointment → 409 SLOT_CONFLICT naming it", r.status === 409 && clash?.error === "SLOT_CONFLICT"
    && JSON.stringify(clash.details?.conflictingAppointmentIds) === JSON.stringify([ids.apptD]), JSON.stringify(clash));
  const race = await Promise.all(Array.from({ length: 6 }, () =>
    routes.root.POST(req("/api/appointments", tokenD, { method: "POST", key: key(), body: { kind: "INTERNAL", title: "מרוץ", startsAt: at(13), durationMinutes: 30, staffMemberId: ids.staffD } }))));
  const codes = race.map((x) => x.status);
  ok("X2 six simultaneous bookings of one slot → exactly one 201, five 409", codes.filter((c) => c === 201).length === 1 && codes.filter((c) => c === 409).length === 5, codes.join(","));
  ok("X3 …and one row holds that slot", (await n(`SELECT count(*)::int AS n FROM "Appointment" WHERE "businessId" = ${bizD} AND "startsAt" = '${at(13)}'::timestamptz AND status::text <> 'CANCELED'`)) === 1);

  // ── I. Isolation ───────────────────────────────────────────────────────────────────────────────
  console.log("I. isolation");
  r = await routes.one.GET(req(`/api/appointments/${ids.apptC}`, tokenD), p({ id: String(ids.apptC) }));
  ok("I1 D reads C's appointment → 404", r.status === 404, String(r.status));
  const before = await owner.appointment.findUniqueOrThrow({ where: { id: ids.apptC } });
  r = await routes.details.PATCH(req(`/api/appointments/${ids.apptC}/details`, tokenD, { method: "PATCH", key: key(), body: { title: "נגיעה זרה", expectedVersion: before.version } }), p({ id: String(ids.apptC) }));
  const after = await owner.appointment.findUniqueOrThrow({ where: { id: ids.apptC } });
  ok("I2 D changes C's appointment → 404, unchanged", r.status === 404 && after.title === before.title && after.version === before.version, String(r.status));
  const dList = (await body(await list(tokenD)))?.appointments ?? [];
  const cList = (await body(await list(seed.tokenC)))?.appointments ?? [];
  ok("I3 each list holds only its own business", dList.every((a: { businessId?: number; id: number }) => a.id !== ids.apptC)
    && cList.every((a: { id: number }) => a.id !== ids.apptD) && cList.length >= 1 && dList.length >= 2);

  // ── K. Decisions kept ──────────────────────────────────────────────────────────────────────────
  console.log("K. decisions kept");
  const fB = await caps(seed.tokenB);
  ok("K1 B (override DISABLED): capabilities OFF (BUSINESS_DISABLED)", fB.appointments?.allowed === false && fB.appointments?.reasonCode === "BUSINESS_DISABLED", JSON.stringify(fB.appointments));
  r = await list(seed.tokenB);
  const rs = await routes.staff.POST(req("/api/appointments/staff", seed.tokenB, { method: "POST", body: { displayName: "x" } }));
  ok("K2 B: the API answers 404 to a read and a write, and nothing is written", r.status === 404 && rs.status === 404
    && (await n(`SELECT count(*)::int AS n FROM "StaffMember" WHERE "businessId" = ${seed.bizB}`)) === 0, `${r.status},${rs.status}`);
  const fA = await caps(seed.tokenA);
  ok("K3 A (the pilot, override ENABLED) stays ON (BUSINESS_ENABLED)", fA.appointments?.allowed === true && fA.appointments?.reasonCode === "BUSINESS_ENABLED");

  // ── P. External booking stays closed ───────────────────────────────────────────────────────────
  console.log("P. external booking stays closed");
  r = await routes.settings.PUT(req("/api/appointments/booking/settings", tokenD, { method: "PUT", body: { enabled: true, staffChoiceMode: "OPTIONAL" } }));
  const closed = await body(r);
  ok("P1 D turns its link on → 409 BOOKING_CLOSED, nothing switched on", r.status === 409 && closed?.error === "BOOKING_CLOSED"
    && (await n(`SELECT count(*)::int AS n FROM "BookingSettings" WHERE "businessId" = ${bizD} AND (enabled OR "publicId" IS NOT NULL)`)) === 0, JSON.stringify(closed));
  r = await routes.link.POST(req("/api/appointments/booking/settings/link", tokenD, { method: "POST", body: {} }));
  ok("P2 D asks for a new link → 409 BOOKING_CLOSED", r.status === 409 && (await body(r))?.error === "BOOKING_CLOSED", String(r.status));
  r = await routes.door.GET(req(`/api/public/booking/${"x".repeat(22)}`, null), p({ publicId: "x".repeat(22) }));
  ok("P3 the public door → 404", r.status === 404, String(r.status));

  // ── S. Stops ───────────────────────────────────────────────────────────────────────────────────
  console.log("S. stops");
  await owner.platformFeaturePolicy.update({ where: { featureKey: "appointments" }, data: { emergencyDisabled: true } });
  const sc = [(await list(seed.tokenC)).status, (await list(tokenD)).status, (await list(seed.tokenA)).status];
  const fE = await caps(tokenD);
  ok("S1 the emergency switch closes C, D and the pilot A → 404 ×3 (EMERGENCY_DISABLED)", sc.every((c) => c === 404) && fE.appointments?.reasonCode === "EMERGENCY_DISABLED", sc.join(","));
  await owner.platformFeaturePolicy.update({ where: { featureKey: "appointments" }, data: { emergencyDisabled: false, globalEnabled: false } });
  const so = [(await list(seed.tokenC)).status, (await list(tokenD)).status, (await list(seed.tokenA)).status];
  ok("S2 the policy back OFF (Production before the migration): C and D closed, the pilot A open", so[0] === 404 && so[1] === 404 && so[2] === 200, so.join(","));
  await owner.platformFeaturePolicy.update({ where: { featureKey: "appointments" }, data: { globalEnabled: true } });
  const sr = [(await list(seed.tokenC)).status, (await list(tokenD)).status];
  ok("S3 restored: C and D open again", sr.every((c) => c === 200), sr.join(","));

  writeFileSync(process.env.OPEN_OUT!, JSON.stringify({ bizD, tokenD }, null, 2));
  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => owner.$disconnect());
