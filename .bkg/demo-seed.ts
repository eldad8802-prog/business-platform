/**
 * Milestone C — a local demo of the owner's screens (not CI): one synthetic business with staff, services, hours, the
 * booking link on, and requests submitted through the REAL public routes (pending, one from a known customer's phone,
 * one confirmed automatically, one withdrawn by its customer). Writes { token, publicId, businessId } to SEED_OUT.
 * env: OWNER_URL, DATABASE_URL (runtime), AUTH_TOKEN_SECRET, SEED_OUT. Synthetic only — never point it at Production.
 */
process.env.TASK_REQUEST_HMAC_KEY = process.env.TASK_REQUEST_HMAC_KEY || "bkg-demo-synthetic-request-hmac-key-0123456789abcdef";
process.env.TASK_REQUEST_HMAC_KEY_ID = process.env.TASK_REQUEST_HMAC_KEY_ID || "lab1";
process.env.AUTH_PLANE_ENABLED = "true";
process.env.AUTH_DATABASE_URL = process.env.AUTH_DATABASE_URL || process.env.OWNER_URL;
process.env.RATE_LIMIT_BACKEND = "memory";

import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const owner = new PrismaClient({ datasourceUrl: process.env.OWNER_URL! });

async function main() {
  const { signAuthToken } = await import("@/lib/auth-token");
  const { uuidV7 } = await import("@/lib/services/tasks/task-idempotency");
  const r = {
    submit: await import("@/app/api/public/booking/[publicId]/requests/route"),
    manage: await import("@/app/api/public/booking/manage/route"),
    settings: await import("@/app/api/appointments/booking/settings/route"),
    staff: await import("@/app/api/appointments/staff/route"),
    staffOne: await import("@/app/api/appointments/staff/[staffId]/route"),
    staffServices: await import("@/app/api/appointments/staff/[staffId]/services/route"),
    availability: await import("@/app/api/appointments/availability/route"),
    exceptions: await import("@/app/api/appointments/availability/exceptions/route"),
    policy: await import("@/app/api/appointments/services/[serviceId]/policy/route"),
    root: await import("@/app/api/appointments/route"),
  };
  const biz = (await owner.business.create({ data: { name: "סטודיו דנה — הדגמה" } })).id;
  const user = (await owner.user.create({ data: { email: `bkg-demo-${Date.now()}@lab.test`, password: "x", businessId: biz } })).id;
  const token = signAuthToken(user, 0);
  await owner.businessFeatureAccess.createMany({ data: [
    { businessId: biz, featureKey: "appointments", state: "ENABLED", reason: "local demo" },
    { businessId: biz, featureKey: "public_booking", state: "ENABLED", reason: "local demo" },
  ] });
  const svc = async (name: string, durationMinutes: number, price: number) => (await owner.businessService.create({ data: { businessId: biz, name, type: "SERVICE", durationMinutes, priceMode: "FIXED", priceAmount: price } })).id;
  const haircut = await svc("תספורת", 45, 120), color = await svc("צבע", 90, 280), consult = await svc("ייעוץ", 30, 0);
  await owner.customer.create({ data: { businessId: biz, name: "נועה לוי", phone: "972521111111" } });

  let ip = 1;
  const req = (path: string, init: { method?: string; body?: unknown; key?: string; token?: string | null } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.77.0.${ip++}` };
    if (init.token !== null) headers.authorization = `Bearer ${init.token ?? token}`;
    if (init.key) headers["idempotency-key"] = init.key;
    return new NextRequest(`https://demo.local${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
  const json = async (res: Response) => res.json().catch(() => null);
  const mk = async (displayName: string, color: string) => (await json(await r.staff.POST(req("/api/appointments/staff", { method: "POST", body: { displayName, color } }))))?.staffMember;
  const shira = await mk("שירה", "#2f6fb5"), avi = await mk("אבי", "#c2410c");
  await r.staffServices.PUT(req(`/api/appointments/staff/${shira.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: haircut }, { businessServiceId: color }] } }), p({ staffId: String(shira.id) }));
  await r.staffServices.PUT(req(`/api/appointments/staff/${avi.id}/services`, { method: "PUT", body: { services: [{ businessServiceId: haircut }, { businessServiceId: consult }] } }), p({ staffId: String(avi.id) }));
  for (const s of [shira, avi]) await r.staffOne.PATCH(req(`/api/appointments/staff/${s.id}`, { method: "PATCH", body: { publicBookable: true, expectedVersion: (await owner.staffMember.findUniqueOrThrow({ where: { id: s.id } })).version } }), p({ staffId: String(s.id) }));
  await r.availability.PUT(req("/api/appointments/availability", { method: "PUT", body: { rules: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 })).concat([{ weekday: 5, startMinute: 540, endMinute: 780 }]) } }));
  const pol = (sid: number, body: Record<string, unknown>) => r.policy.PUT(req(`/api/appointments/services/${sid}/policy`, { method: "PUT", body }), p({ serviceId: String(sid) }));
  await pol(haircut, { publicBookable: true, approvalMode: "MANUAL", slotStepMinutes: 15 });
  await pol(color, { publicBookable: true, approvalMode: "AUTO", slotStepMinutes: 30 });
  await pol(consult, { publicBookable: false });
  const st = await json(await r.settings.PUT(req("/api/appointments/booking/settings", { method: "PUT", body: { enabled: true, staffChoiceMode: "OPTIONAL", showStaffNames: true } })));
  const publicId = st.settings.publicId as string;

  const { addCalendarDays, jerusalemDayKey, jerusalemInstantAt } = await import("@/lib/utils/jerusalem-day");
  const day = (n: number) => addCalendarDays(jerusalemDayKey(new Date()), n);
  let d1 = day(2); while ([5, 6].includes(new Date(`${d1}T12:00:00Z`).getUTCDay())) d1 = addCalendarDays(d1, 1);
  let d2 = addCalendarDays(d1, 1); while ([5, 6].includes(new Date(`${d2}T12:00:00Z`).getUTCDay())) d2 = addCalendarDays(d2, 1);
  const at = (d: string, h: number, m = 0) => jerusalemInstantAt(d, h, m).toISOString();
  const submit = async (body: Record<string, unknown>) => json(await r.submit.POST(req(`/api/public/booking/${publicId}/requests`, { method: "POST", key: uuidV7(new Date()), body, token: null }), p({ publicId })));
  await submit({ serviceId: haircut, startsAt: at(d1, 10), name: "רון אברהם", phone: "054-444-4444", note: "פעם ראשונה אצלכם" });
  await submit({ serviceId: haircut, staffId: avi.id, startsAt: at(d1, 12), name: "נועה לוי", phone: "052-111-1111" });
  await submit({ serviceId: haircut, startsAt: at(d2, 9, 30), name: "מאיה פרץ", phone: "053-333-3333" });
  await submit({ serviceId: color, startsAt: at(d2, 13), name: "שירן כהן", phone: "050-555-5555" });
  const gone = await submit({ serviceId: haircut, startsAt: at(d2, 15), name: "דניאל לוי", phone: "058-888-8888" });
  await r.manage.POST(req("/api/public/booking/manage", { method: "POST", body: { token: gone.manageToken, action: "cancel" }, token: null }));
  // One request has waited a little over two hours (its first reminder is due).
  const older = await owner.bookingRequest.findFirst({ where: { businessId: biz, contactName: "מאיה פרץ" } });
  if (older) await owner.bookingRequest.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - 2.2 * 3600_000) } });
  writeFileSync(process.env.SEED_OUT!, JSON.stringify({ token, publicId, businessId: biz, day1: d1, day2: d2 }, null, 2));
  console.log(`demo business ${biz}, link ${publicId}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => owner.$disconnect());
