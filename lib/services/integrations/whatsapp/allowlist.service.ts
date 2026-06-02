import {
  loadAllowlistByBusiness,
  normalizePhoneDigits,
  type AllowlistByBusiness,
} from "./config";

export type AllowlistCheckResult =
  | { ok: true; senderDigits: string }
  | {
      ok: false;
      reason: "allowlist_not_configured" | "missing_sender" | "sender_not_allowlisted";
    };

let cachedAllowlist: AllowlistByBusiness | null | undefined;

function getAllowlist(): AllowlistByBusiness | null {
  if (cachedAllowlist === undefined) {
    cachedAllowlist = loadAllowlistByBusiness();
  }
  return cachedAllowlist;
}

/** For tests — reset ENV cache between cases. */
export function resetAllowlistCacheForTests(): void {
  cachedAllowlist = undefined;
}

/**
 * Owner-only gate: sender must appear in WHATSAPP_ALLOWLIST_BY_BUSINESS for the business.
 */
export function checkSenderAllowlisted(params: {
  businessId: number;
  sender: string | null;
}): AllowlistCheckResult {
  const list = getAllowlist();
  if (!list) {
    return { ok: false, reason: "allowlist_not_configured" };
  }

  if (!params.sender || params.sender.trim().length === 0) {
    return { ok: false, reason: "missing_sender" };
  }

  const senderDigits = normalizePhoneDigits(params.sender);
  if (senderDigits.length < 8) {
    return { ok: false, reason: "missing_sender" };
  }

  const allowed = list.get(params.businessId);
  if (!allowed || !allowed.has(senderDigits)) {
    return { ok: false, reason: "sender_not_allowlisted" };
  }

  return { ok: true, senderDigits };
}
