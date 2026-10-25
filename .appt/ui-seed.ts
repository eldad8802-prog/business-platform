/**
 * Appointments milestone B — the demo / end-to-end fixtures, on the Production-shaped lab (.appt/lab.sh --with-appt).
 * Two synthetic businesses: A with `appointments` ON (a per-business override, the way a pilot is opened), B with it
 * OFF. A gets two staff members, weekly hours, three services, customers (one with an open lead) and this week's
 * appointments — all written through the REAL services AS app_runtime_prod (DATABASE_URL); only the business, users,
 * catalog, customers, lead and the flag override are owner fixtures. Writes the session tokens and ids to $SEED_OUT.
 *
 * env: OWNER_URL, DATABASE_URL (runtime), AUTH_TOKEN_SECRET, SEED_OUT. Synthetic only.
 */
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "appt-ui-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";

import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const schedule = await import("@/lib/services/appointment/appointment-schedule.service");
  const config = await import("@/lib/services/appointment/appointment-config.service");
  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");

  const tag = `appt-ui-${Date.now()}`;
  const bizA = (await owner.business.create({ data: { name: "סטודיו דנה — הדגמה" } })).id;
  const bizB = (await owner.business.create({ data: { name: `${tag}-B` } })).id;
  const userA = (await owner.user.create({ data: { email: `${tag}-a@lab.test`, password: "x", businessId: bizA } })).id;
  const userB = (await owner.user.create({ data: { email: `${tag}-b@lab.test`, password: "x", businessId: bizB } })).id;
  await owner.businessFeatureAccess.create({ data: { businessId: bizA, featureKey: "appointments", state: "ENABLED", reason: "lab demo" } });

  const svc = async (name: string, durationMinutes: number) =>
    (await owner.businessService.create({ data: { businessId: bizA, name, type: "SERVICE", durationMinutes } })).id;
  const haircut = await svc("תספורת", 45);
  const color = await svc("צבע", 90);
  const consult = await svc("ייעוץ", 30);
  const cust = async (name: string, phone: string) => (await owner.customer.create({ data: { businessId: bizA, name, phone } })).id;
  const noa = await cust("נועה לוי", "0521111111");
  const yossi = await cust("יוסי כהן", "0522222222");
  const maya = await cust("מאיה פרץ", "0523333333");
  const ron = await cust("רון אברהם", "0524444444");
  // Ron's open lead has no phone and another name: only the customer link finds it (GET /api/leads?customerId=).
  await owner.lead.create({ data: { businessId: bizA, customerId: ron, customerName: "ר. א.", status: "OPEN" } });
  await owner.customer.create({ data: { businessId: bizB, name: "לקוח של עסק אחר", phone: "0529999999" } });
  // 120 newer customers: the demo customers are outside any "recent 100" list — names come with the appointments.
  await owner.customer.createMany({ data: Array.from({ length: 120 }, (_, i) => ({ businessId: bizA, name: `לקוח מילוי ${i + 1}` })) });

  const principal = { kind: "OWNER" as const, businessId: bizA, userId: userA };
  const shira = (await config.createStaff(principal, { displayName: "שירה", color: "#2f6fb5" })).id;
  const avi = (await config.createStaff(principal, { displayName: "אבי", color: "#c2410c" })).id;
  await config.setStaffServices(principal, shira, { services: [{ businessServiceId: haircut }, { businessServiceId: color, durationOverrideMinutes: 75 }] });
  await config.setStaffServices(principal, avi, { services: [{ businessServiceId: haircut }, { businessServiceId: consult }] });
  const week = [0, 1, 2, 3, 4].flatMap((weekday) => [{ weekday, startMinute: 9 * 60, endMinute: 18 * 60 }]);
  await config.replaceWeeklyRules(principal, { rules: [...week, { weekday: 5, startMinute: 9 * 60, endMinute: 13 * 60 }] });
  await config.upsertServicePolicy(principal, color, { bufferAfterMinutes: 15 });

  const today = jerusalemDayKey(new Date());
  const at = (day: string, h: number, m = 0) => jerusalemInstantAt(day, h, m).toISOString();
  const book = (input: Record<string, unknown>) => schedule.createAppointment(principal, { idempotencyKey: uuidV7(new Date()) }, input);
  const ids: Record<string, number> = {};
  ids.todayNoa = (await book({ startsAt: at(today, 10), businessServiceId: haircut, staffMemberId: shira, customerId: noa })).appointment.id;
  ids.todayYossi = (await book({ startsAt: at(today, 11), businessServiceId: consult, staffMemberId: avi, customerId: yossi, status: "PROPOSED" })).appointment.id;
  ids.todayMaya = (await book({ startsAt: at(today, 14), businessServiceId: color, staffMemberId: shira, customerId: maya, notes: "גוון 7.1, לבדוק רגישות" })).appointment.id;
  ids.lunch = (await book({ kind: "BLOCK", startsAt: at(today, 13), durationMinutes: 45, title: "הפסקת צהריים" })).appointment.id;
  ids.meeting = (await book({ kind: "INTERNAL", startsAt: at(addCalendarDays(today, 1), 9), durationMinutes: 30, title: "ישיבת צוות", staffMemberId: avi })).appointment.id;
  for (const [d, h, s, c, sv] of [[1, 12, shira, yossi, haircut], [2, 10, avi, noa, consult], [3, 15, shira, maya, haircut], [-1, 16, avi, noa, haircut]] as const) {
    await book({ startsAt: at(addCalendarDays(today, d), h), businessServiceId: sv, staffMemberId: s, customerId: c });
  }
  // A move and a cancellation, so the journal and the month show history.
  const moved = (await book({ startsAt: at(addCalendarDays(today, 2), 16), businessServiceId: haircut, staffMemberId: avi, customerId: maya })).appointment;
  await schedule.moveAppointment(principal, { idempotencyKey: uuidV7(new Date()) }, moved.id, { startsAt: at(addCalendarDays(today, 2), 17), expectedVersion: moved.version });
  const canceled = (await book({ startsAt: at(addCalendarDays(today, 4), 11), businessServiceId: consult, customerId: yossi })).appointment;
  await schedule.changeStatus(principal, { idempotencyKey: uuidV7(new Date()) }, canceled.id, { to: "CANCELED", cancelReason: "CUSTOMER_CANCELED", expectedVersion: canceled.version });

  const out = {
    tokenA: signAuthToken(userA, 0), tokenB: signAuthToken(userB, 0), bizA, bizB, today,
    staff: { shira, avi }, services: { haircut, color, consult }, customers: { noa, yossi, maya, ron }, ids,
  };
  writeFileSync(process.env.SEED_OUT!, JSON.stringify(out, null, 2));
  console.log(`seeded: business ${bizA} (appointments ON) and ${bizB} (OFF); today ${today}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    await owner.$disconnect();
    const { prisma } = await import("@/lib/prisma");
    await prisma.$disconnect();
  });
