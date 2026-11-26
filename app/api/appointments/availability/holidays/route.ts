import { applyHolidays } from "@/lib/services/appointment/appointment-daily-use.service";
import { upcomingHolidayDays } from "@/lib/services/appointment/israeli-holidays";
import { appointmentsRoute, json, jsonBody } from "@/lib/services/appointment/appointments-http";
import { jerusalemDayKey } from "@/lib/utils/jerusalem-day";

export const runtime = "nodejs";

/** GET — the Israeli holidays and eves still ahead (the static table, lib/services/appointment/israeli-holidays.ts). */
export async function GET(req: Request) {
  return appointmentsRoute(req, async () => json({ holidays: upcomingHolidayDays(jerusalemDayKey(new Date())) }));
}

/**
 * POST — "סגירה בחגים": { holidays: ["5787:YOM_KIPPUR", …], eveClosingMinute, staffMemberId?, dryRun? }. Holidays are
 * closed all day, eves from the closing time; the dates come from the table, never from the request. `dryRun: true`
 * is the preview. Appointments on those days are counted (a warning) and never cancelled.
 */
export async function POST(req: Request) {
  return appointmentsRoute(req, async ({ principal }) => {
    const out = await applyHolidays(principal, await jsonBody(req));
    return json(out, out.dryRun ? 200 : 201);
  });
}
