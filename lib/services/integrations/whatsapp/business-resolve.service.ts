/**
 * Resolves a Meta `phone_number_id` to an internal `businessId`.
 *
 * # Routing source-of-truth (Bot-MVP-1 →)
 *
 *   PRIMARY:  database — `WhatsAppConnection` row with `status = CONNECTED`.
 *
 *   FALLBACK: process-env JSON map (`WHATSAPP_PHONE_NUMBER_BUSINESS_MAP`).
 *             Used ONLY when `WHATSAPP_ALLOW_ENV_FALLBACK=1`. The fallback
 *             exists so the existing `webhook-pr2.routing.test.ts` test
 *             suite — which seeds the env map directly — keeps passing
 *             without modification during the migration window.
 *
 *   In production: do NOT set `WHATSAPP_ALLOW_ENV_FALLBACK`. The env path
 *   will be removed in a future sprint once the test suite is migrated to
 *   DB fixtures.
 */

import { resolveBusinessIdByPhoneNumberId } from "./connection.service";
import {
  loadPhoneNumberBusinessMap,
  type PhoneNumberBusinessMap,
} from "./config";

export type ResolveBusinessResult =
  | { ok: true; businessId: number; phoneNumberId: string }
  | {
      ok: false;
      reason:
        | "missing_phone_number_id"
        | "mapping_not_configured"
        | "unknown_phone_number_id";
      phoneNumberId: string | null;
    };

let cachedEnvMap: PhoneNumberBusinessMap | null | undefined;

function envFallbackEnabled(): boolean {
  return process.env.WHATSAPP_ALLOW_ENV_FALLBACK === "1";
}

function getEnvMap(): PhoneNumberBusinessMap | null {
  if (cachedEnvMap === undefined) {
    cachedEnvMap = loadPhoneNumberBusinessMap();
  }
  return cachedEnvMap;
}

/** For tests — reset env cache between cases. */
export function resetBusinessResolveCacheForTests(): void {
  cachedEnvMap = undefined;
}

/**
 * Resolve `phoneNumberId` → `businessId`.
 *
 * Async because the primary path is a DB lookup. The webhook handler is
 * already async, so the cascade is safe.
 */
export async function resolveBusinessFromPhoneNumberId(
  phoneNumberId: string | null
): Promise<ResolveBusinessResult> {
  if (!phoneNumberId || phoneNumberId.trim().length === 0) {
    return {
      ok: false,
      reason: "missing_phone_number_id",
      phoneNumberId: null,
    };
  }

  const id = phoneNumberId.trim();

  // ── PRIMARY: DB-backed lookup via WhatsAppConnection ──────────────────
  const dbBusinessId = await resolveBusinessIdByPhoneNumberId(id);
  if (dbBusinessId !== null) {
    return { ok: true, businessId: dbBusinessId, phoneNumberId: id };
  }

  // ── FALLBACK: env JSON map, only when explicitly enabled ──────────────
  if (envFallbackEnabled()) {
    const map = getEnvMap();
    if (!map) {
      return { ok: false, reason: "mapping_not_configured", phoneNumberId: id };
    }
    const envBusinessId = map.get(id);
    if (envBusinessId !== undefined) {
      return { ok: true, businessId: envBusinessId, phoneNumberId: id };
    }
    return { ok: false, reason: "unknown_phone_number_id", phoneNumberId: id };
  }

  // Production path: DB miss + env disabled = unknown.
  return { ok: false, reason: "unknown_phone_number_id", phoneNumberId: id };
}
