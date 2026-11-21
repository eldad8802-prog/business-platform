"use client";

import { useEffect, useMemo, useState } from "react";

import { activityFromCapabilities, modulesFromCapabilities, resolveUserPermissions, type CapabilitiesWire } from "@/features/home/v4/home-access";
import { barSlotFor, type BarSlotKey } from "@/features/home/v4/activity-packs-home";
import { fetchJsonCached } from "@/lib/ui/cached-json";

import { primaryDestinationsFor, type NavDestination } from "./nav-destinations";

const CAPS = "/api/business/capabilities";
const CAPABILITIES_TTL_MS = 60_000;

/**
 * The bar / rail / sidebar fixed actions with the second slot resolved for this business (phase 2, direction B).
 *
 * Fail-safe to TODAY's bar: until the capabilities answer — and whenever the activity packs feature is OFF, the
 * owner never chose, or the read fails — the slot is יומן, exactly the pre-packs HOME v4 bar. The same cached read
 * the Home makes, so it costs no extra request.
 */
export function usePrimaryDestinations(): NavDestination[] {
  const [slot, setSlot] = useState<BarSlotKey>("calendar");
  useEffect(() => {
    let cancelled = false;
    fetchJsonCached<CapabilitiesWire>(CAPS, CAPABILITIES_TTL_MS)
      .then((caps) => {
        if (!cancelled) setSlot(barSlotFor(activityFromCapabilities(caps), modulesFromCapabilities(caps), resolveUserPermissions().scopes));
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
