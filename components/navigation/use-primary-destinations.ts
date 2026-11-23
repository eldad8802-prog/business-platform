"use client";

import { useEffect, useMemo, useState } from "react";

import type { BarSlotKey } from "@/features/home/v4/activity-packs-home";
import { modulesFromCapabilities, resolveUserPermissions, type CapabilitiesWire } from "@/features/home/v4/home-access";
import { loadActivity } from "@/features/home/v4/pack-engine-loader";
import { fetchJsonCached } from "@/lib/ui/cached-json";

import { primaryDestinationsFor, type NavDestination } from "./nav-destinations";

const CAPS = "/api/business/capabilities";
const CAPABILITIES_TTL_MS = 60_000;

/**
 * The bar / rail / sidebar fixed actions with the second slot resolved for this business (phase 2, direction B).
 *
 * Fail-safe to TODAY's bar: until the capabilities answer — and whenever the activity packs feature is OFF, the
 * owner never chose, the pack engine cannot load, or any read fails — the slot is יומן, exactly the pre-packs HOME v4
 * bar. The same cached capabilities read the Home makes; the pack engine is downloaded only for a business that chose
 * packs (so every other business ships none of it).
 */
export function usePrimaryDestinations(): NavDestination[] {
  const [slot, setSlot] = useState<BarSlotKey>("calendar");
  useEffect(() => {
    let cancelled = false;
    fetchJsonCached<CapabilitiesWire>(CAPS, CAPABILITIES_TTL_MS)
      .then(async (caps) => {
        const { activity, packs } = await loadActivity(caps);
        if (!cancelled && activity) setSlot(packs.barSlot(activity, modulesFromCapabilities(caps), resolveUserPermissions().scopes));
      })
      .catch(() => {
        /* keep the fixed יומן */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => primaryDestinationsFor(slot), [slot]);
}
