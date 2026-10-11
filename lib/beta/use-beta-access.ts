"use client";

/**
 * useBetaAccess — which integrations this business should see as "בקרוב" (closed beta).
 *
 * Display only: the server refuses every gated action by itself (lib/beta/beta-gate.ts). Until the answer
 * arrives — and if it cannot be read — nothing is marked "בקרוב", so a business that is not in the beta
 * never sees a different screen, and a beta business that somehow reached a connect button is still
 * refused by the server with the same "בקרוב" message.
 *
 * One request per page load, shared by every component that asks.
 */

import { useEffect, useState } from "react";
import { getClientAuthToken } from "@/lib/client-session";

export type BetaComingSoon = {
  META_WHATSAPP: boolean;
  META_LEAD_ADS: boolean;
  TAX_AUTHORITY: boolean;
};

export const NOTHING_COMING_SOON: BetaComingSoon = Object.freeze({
  META_WHATSAPP: false,
  META_LEAD_ADS: false,
  TAX_AUTHORITY: false,
});

export function parseBetaAccessResponse(data: unknown): BetaComingSoon {
  const c = (data as { comingSoon?: Record<string, unknown> } | null)?.comingSoon;
  if (!c || typeof c !== "object") return NOTHING_COMING_SOON;
  return {
    META_WHATSAPP: c.META_WHATSAPP === true,
    META_LEAD_ADS: c.META_LEAD_ADS === true,
    TAX_AUTHORITY: c.TAX_AUTHORITY === true,
  };
}

let shared: Promise<BetaComingSoon> | null = null;

function loadOnce(): Promise<BetaComingSoon> {
  if (shared) return shared;
  const token = getClientAuthToken();
  if (!token) return Promise.resolve(NOTHING_COMING_SOON);
  shared = fetch("/api/business/beta-access", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(async (res) => (res.ok ? parseBetaAccessResponse(await res.json().catch(() => null)) : NOTHING_COMING_SOON))
    .catch(() => NOTHING_COMING_SOON);
  // A failed or empty answer is not cached for the rest of the session — the next page load asks again.
  void shared.then((v) => {
    if (v === NOTHING_COMING_SOON) shared = null;
  });
  return shared;
}

/** `ready` is false until the answer arrives; `comingSoon` is all-false until then. */
export function useBetaAccess(): { ready: boolean; comingSoon: BetaComingSoon } {
  const [state, setState] = useState<{ ready: boolean; comingSoon: BetaComingSoon }>({
    ready: false,
    comingSoon: NOTHING_COMING_SOON,
  });
  useEffect(() => {
    let cancelled = false;
    void loadOnce().then((comingSoon) => {
      if (!cancelled) setState({ ready: true, comingSoon });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

/** For tests only. */
export function __resetBetaAccessCache(): void {
  shared = null;
}
