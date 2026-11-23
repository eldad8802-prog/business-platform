"use client";

import { useEffect, useState } from "react";

import type { Locale } from "@/lib/i18n/config";

import type * as LimitedModule from "./home-v4-limited-ui";

let pending: Promise<typeof LimitedModule | null> | null = null;

function load(): Promise<typeof LimitedModule | null> {
  if (!pending) {
    pending = import("./home-v4-limited-ui").catch(() => {
      pending = null;
      return null;
    });
  }
  return pending;
}

export type LimitedKit = {
  copy: LimitedModule.LimitedCopy;
  Header: typeof LimitedModule.LimitedHeader;
  PlanCard: typeof LimitedModule.LimitedPlanCard;
};

/**
 * The FREE_LIMITED texts and its two pieces of UI, downloaded only when `active` (the subscription says FREE_LIMITED —
 * never today). Until they arrive, or if they cannot load, this is null and the caller draws nothing extra: no upgrade
 * text, never a wrong one.
 */
export function useLimitedCopy(active: boolean, locale: Locale): LimitedKit | null {
  const [mod, setMod] = useState<typeof LimitedModule | null>(null);
  useEffect(() => {
    if (!active || mod) return;
    let cancelled = false;
    void load().then((m) => {
      if (!cancelled && m) setMod(m);
    });
    return () => {
      cancelled = true;
    };
  }, [active, mod]);
  return active && mod ? { copy: mod.limitedCopy(locale), Header: mod.LimitedHeader, PlanCard: mod.LimitedPlanCard } : null;
}
