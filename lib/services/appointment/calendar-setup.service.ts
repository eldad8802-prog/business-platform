/**
 * The calendar's first-time setup (G9, owner-approved new screen, design a). SERVER-ONLY.
 *
 * Owner rules 2026-11-24:
 *   - offered only to a business that has NOT configured its calendar: no weekly hours of the business and no active
 *     catalog service (`needsSetup`);
 *   - skippable (the screen's own choice; nothing is written by skipping);
 *   - NEVER overwrites: each part is written only while it is still empty — the business's weekly hours only when it
 *     has none, services only when the catalog has no service, staff only when there is no staff member. A part that
 *     is no longer empty (configured meanwhile in another tab, or a repeated submit) is reported as `kept`, untouched;
 *   - adding staff is optional (an empty list writes nothing).
 * One transaction under the per-business appointments lock, so two submits cannot both see "empty". Services go
 * through the catalog's own creator (one catalog for all of Dubiz); hours through the same merge as the hours screen.
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";
import { createBusinessService } from "@/lib/services/offering/business-service.service";

import { authorizeAppointmentAction, type AppointmentPrincipal } from "./appointment-authorization";
import { invalid } from "./appointment-errors";
import { lockBusinessAppointments } from "./appointment-request";
import { isValidWindow, mergeWindows, type MinuteWindow } from "./availability.core";

type Tx = Prisma.TransactionClient;
const isIntIn = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
export const SETUP_LIMITS = { services: 20, staff: 20, rules: 70, serviceName: 120, staffName: 80, maxPrice: 1_000_000 } as const;

export type SetupState = { needsSetup: boolean; hasHours: boolean; hasServices: boolean; hasStaff: boolean };

async function stateWithinTx(tx: Tx, businessId: number): Promise<SetupState> {
  const [rules, services, staff] = await Promise.all([
    tx.availabilityRule.count({ where: { businessId, staffMemberId: null, removedAt: null } }),
    tx.businessService.count({ where: { businessId, type: "SERVICE", active: true } }),
    tx.staffMember.count({ where: { businessId, erasedAt: null } }),
  ]);
  return { needsSetup: rules === 0 && services === 0, hasHours: rules > 0, hasServices: services > 0, hasStaff: staff > 0 };
}

export async function getSetupState(principal: AppointmentPrincipal): Promise<SetupState> {
  authorizeAppointmentAction(principal, "availability.read");
  return tenantTx(principal.businessId, (tx) => stateWithinTx(tx, principal.businessId));
}

export type SetupInput = { hours?: unknown; services?: unknown; staff?: unknown };
export type ParsedSetup = {
  hours: Array<{ weekday: number } & MinuteWindow> | null;
  services: Array<{ name: string; durationMinutes: number; priceAmount: number | null }> | null;
  staff: Array<{ displayName: string }> | null;
};

/** Validates the whole request before anything is written (pure; shared with the tests). */
export function parseSetup(input: SetupInput): ParsedSetup {
  let hours: ParsedSetup["hours"] = null;
  if (input.hours !== undefined && input.hours !== null) {
    if (!Array.isArray(input.hours) || input.hours.length > SETUP_LIMITS.rules) throw invalid("hours");
    hours = (input.hours as Array<Record<string, unknown>>).map((r) => {
      if (!r || typeof r !== "object" || !isIntIn(r.weekday, 0, 6)) throw invalid("weekday");
      const w = { startMinute: r.startMinute as number, endMinute: r.endMinute as number };
      if (!isValidWindow(w)) throw invalid("window");
      return { weekday: r.weekday, ...w };
    });
  }
  let services: ParsedSetup["services"] = null;
  if (input.services !== undefined && input.services !== null) {
    if (!Array.isArray(input.services) || input.services.length > SETUP_LIMITS.services) throw invalid("services");
    services = (input.services as Array<Record<string, unknown>>).map((s) => {
      if (!s || typeof s !== "object" || typeof s.name !== "string") throw invalid("name");
      const name = s.name.trim();
      if (!name || name.length > SETUP_LIMITS.serviceName) throw invalid("name");
      if (!isIntIn(s.durationMinutes, 5, 1440)) throw invalid("durationMinutes");
      const price = s.priceAmount === undefined || s.priceAmount === null ? null : s.priceAmount;
      if (price !== null && (typeof price !== "number" || !Number.isFinite(price) || price < 0 || price > SETUP_LIMITS.maxPrice)) throw invalid("priceAmount");
      return { name, durationMinutes: s.durationMinutes, priceAmount: price as number | null };
    });
    if (new Set(services.map((s) => s.name)).size !== services.length) throw invalid("services");
  }
  let staff: ParsedSetup["staff"] = null;
  if (input.staff !== undefined && input.staff !== null) {
    if (!Array.isArray(input.staff) || input.staff.length > SETUP_LIMITS.staff) throw invalid("staff");
    staff = (input.staff as Array<Record<string, unknown>>).map((m) => {
      if (!m || typeof m !== "object" || typeof m.displayName !== "string") throw invalid("displayName");
      const displayName = m.displayName.trim();
      if (!displayName || displayName.length > SETUP_LIMITS.staffName) throw invalid("displayName");
      return { displayName };
    });
  }
  return { hours, services, staff };
}

export type SetupPart = "written" | "kept" | "skipped";
export type SetupResult = { hours: SetupPart; services: SetupPart; staff: SetupPart; state: SetupState };

export async function applySetup(principal: AppointmentPrincipal, input: SetupInput): Promise<SetupResult> {
  authorizeAppointmentAction(principal, "availability.manage");
  authorizeAppointmentAction(principal, "staff.manage");
  const parsed = parseSetup(input);
  const businessId = principal.businessId;
  return tenantTx(businessId, async (tx) => {
    // Serialises with every appointment write of the business, and with a second setup submit.
    await lockBusinessAppointments(tx, businessId);
    const before = await stateWithinTx(tx, businessId);
    const result: Omit<SetupResult, "state"> = { hours: "skipped", services: "skipped", staff: "skipped" };

    if (parsed.hours && parsed.hours.length) {
      if (before.hasHours) result.hours = "kept";
      else {
        const byDay = new Map<number, MinuteWindow[]>();
        for (const r of parsed.hours) byDay.set(r.weekday, [...(byDay.get(r.weekday) ?? []), { startMinute: r.startMinute, endMinute: r.endMinute }]);
        for (const [weekday, windows] of byDay) {
          for (const w of mergeWindows(windows)) {
            await tx.availabilityRule.create({ data: { businessId, staffMemberId: null, weekday, startMinute: w.startMinute, endMinute: w.endMinute } });
          }
        }
        result.hours = "written";
      }
    }
    if (parsed.services && parsed.services.length) {
      if (before.hasServices) result.services = "kept";
      else {
        for (const s of parsed.services) {
          await createBusinessService({
            businessId, name: s.name, durationMinutes: s.durationMinutes,
            price: s.priceAmount !== null ? { priceMode: "FIXED", priceAmount: s.priceAmount } : { priceMode: "NO_PUBLIC_PRICE" },
          }, tx);
        }
        result.services = "written";
      }
    }
    if (parsed.staff && parsed.staff.length) {
      if (before.hasStaff) result.staff = "kept";
      else {
        let order = 0;
        for (const m of parsed.staff) await tx.staffMember.create({ data: { businessId, displayName: m.displayName, sortOrder: order++ } });
        result.staff = "written";
      }
    }
    return { ...result, state: await stateWithinTx(tx, businessId) };
  });
}
