/**
 * Notification preferences — the tenant store (notifications track spec, 2026-11-12). SERVER-ONLY.
 *
 * Every function takes the actor's (businessId, userId) from the SESSION — never a user id from a request — and
 * runs inside that business's tenant transaction (NotificationSettings / NotificationPreference are FORCE RLS; the
 * same-business trigger refuses a user of another business). Only overrides are stored; "restore defaults"
 * deletes the user's own rows.
 */
import type { Prisma } from "@prisma/client";

import { tenantTx } from "@/lib/tenant/tenant-tx";

import { DEFAULT_TIME_ZONE, normalizeTimeZone } from "./notification-time";
import type { PreferenceBody, StoredPreference, StoredSettings } from "./preferences";

type Tx = Prisma.TransactionClient;

export type Actor = { businessId: number; userId: number };

const SETTINGS_SELECT = {
  pushEnabled: true,
  quietHoursEnabled: true,
  quietStartMinute: true,
  quietEndMinute: true,
  digestEnabled: true,
  digestMinute: true,
  lockScreenDetails: true,
} as const;

/** The user's stored settings row (null = all defaults) and overrides, inside an open tenant transaction. */
export async function readUserPreferences(
  tx: Tx,
  businessId: number,
  userId: number,
): Promise<{ settings: StoredSettings | null; prefs: StoredPreference[] }> {
  const settings = await tx.notificationSettings.findFirst({ where: { businessId, userId }, select: SETTINGS_SELECT });
  const prefs = await tx.notificationPreference.findMany({
    where: { businessId, userId },
    select: { key: true, inApp: true, push: true, delivery: true },
    orderBy: { key: "asc" },
  });
  return { settings, prefs };
}

/** The business's time zone: BookingSettings.timeZone when present (and valid), else Asia/Jerusalem. */
export async function businessTimeZone(tx: Tx, businessId: number): Promise<string> {
  const row = await tx.bookingSettings.findFirst({ where: { businessId }, select: { timeZone: true } });
  return row ? normalizeTimeZone(row.timeZone) : DEFAULT_TIME_ZONE;
}

export async function loadPreferences(actor: Actor) {
  return tenantTx(actor.businessId, async (tx) => ({
    ...(await readUserPreferences(tx, actor.businessId, actor.userId)),
    timeZone: await businessTimeZone(tx, actor.businessId),
  }));
}

/** Apply a validated settings patch (null = back to the default). */
export async function patchSettings(actor: Actor, patch: Partial<StoredSettings>, now: Date): Promise<void> {
  await tenantTx(actor.businessId, async (tx) => {
    await tx.notificationSettings.upsert({
      where: { businessId_userId: { businessId: actor.businessId, userId: actor.userId } },
      create: { businessId: actor.businessId, userId: actor.userId, ...patch, createdAt: now, updatedAt: now },
      update: { ...patch, updatedAt: now },
      select: { id: true },
    });
  });
}

/** Set one override (a validated key and body). A body that leaves every aspect NULL removes the row. */
export async function putPreference(actor: Actor, key: string, body: PreferenceBody, now: Date): Promise<void> {
  await tenantTx(actor.businessId, async (tx) => {
    if (body.inApp === null && body.push === null && body.delivery === null) {
      await tx.notificationPreference.deleteMany({ where: { businessId: actor.businessId, userId: actor.userId, key } });
      return;
    }
    await tx.notificationPreference.upsert({
      where: { businessId_userId_key: { businessId: actor.businessId, userId: actor.userId, key } },
      create: { businessId: actor.businessId, userId: actor.userId, key, ...body, createdAt: now, updatedAt: now },
      update: { ...body, updatedAt: now },
      select: { id: true },
    });
  });
}

export async function deletePreference(actor: Actor, key: string): Promise<number> {
  return tenantTx(actor.businessId, async (tx) =>
    (await tx.notificationPreference.deleteMany({ where: { businessId: actor.businessId, userId: actor.userId, key } })).count,
  );
}

/** "Restore defaults": the user's own settings row and override rows go. */
export async function resetPreferences(actor: Actor): Promise<{ settings: number; preferences: number }> {
  return tenantTx(actor.businessId, async (tx) => ({
    settings: (await tx.notificationSettings.deleteMany({ where: { businessId: actor.businessId, userId: actor.userId } })).count,
    preferences: (await tx.notificationPreference.deleteMany({ where: { businessId: actor.businessId, userId: actor.userId } })).count,
  }));
}
