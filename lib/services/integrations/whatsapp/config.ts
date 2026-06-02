/**
 * ENV-based configuration for WhatsApp webhook routing (PR2).
 * No database — deterministic maps only.
 *
 * WHATSAPP_PHONE_NUMBER_BUSINESS_MAP — JSON: { "<phone_number_id>": <businessId>, ... }
 * WHATSAPP_ALLOWLIST_BY_BUSINESS — JSON: { "<businessId>": ["<E.164 digits>", ...], ... }
 */

function parseJsonEnv(name: string): unknown | null {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Normalize WhatsApp `from` to digits-only for allowlist comparison. */
export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export type PhoneNumberBusinessMap = Map<string, number>;

export function loadPhoneNumberBusinessMap(): PhoneNumberBusinessMap | null {
  const parsed = parseJsonEnv("WHATSAPP_PHONE_NUMBER_BUSINESS_MAP");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const map = new Map<string, number>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const phoneNumberId = String(key).trim();
    const businessId =
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : typeof value === "string" && /^\d+$/.test(value.trim())
          ? Number(value.trim())
          : NaN;

    if (!phoneNumberId || !Number.isFinite(businessId) || businessId <= 0) {
      continue;
    }
    map.set(phoneNumberId, businessId);
  }

  return map.size > 0 ? map : null;
}

export type AllowlistByBusiness = Map<number, Set<string>>;

export function loadAllowlistByBusiness(): AllowlistByBusiness | null {
  const parsed = parseJsonEnv("WHATSAPP_ALLOWLIST_BY_BUSINESS");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const map = new Map<number, Set<string>>();

  for (const [businessKey, phones] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    const businessId = Number(businessKey);
    if (!Number.isInteger(businessId) || businessId <= 0) continue;
    if (!Array.isArray(phones)) continue;

    const set = new Set<string>();
    for (const p of phones) {
      if (typeof p !== "string" && typeof p !== "number") continue;
      const digits = normalizePhoneDigits(String(p));
      if (digits.length >= 8) set.add(digits);
    }

    if (set.size > 0) {
      map.set(businessId, set);
    }
  }

  return map.size > 0 ? map : null;
}
