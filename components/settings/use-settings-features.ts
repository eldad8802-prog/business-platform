"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchJsonCached } from "@/lib/ui/cached-json";
import type { PlatformFeatureKey } from "@/lib/services/feature-access/platform-feature-catalog";

/**
 * Which per-business platform features are ON — for the Settings hub and rail to list a gated area
 * (settings-categories.ts `featureKey`). Read from GET /api/business/capabilities, the same source and cache as
 * lib/ui/use-feature-enabled.ts. Fail-closed: everything OFF until the answer arrives and on any failure, so a
 * gated row never flashes in. The area's own routes still enforce the feature.
 */
type CapabilitiesWire = { features?: Record<string, { allowed?: boolean }> };

export function useSettingsFeatures(): (key: PlatformFeatureKey) => boolean {
  const [features, setFeatures] = useState<CapabilitiesWire["features"] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchJsonCached<CapabilitiesWire>("/api/business/capabilities", 60_000)
      .then((j) => !cancelled && setFeatures(j.features ?? {}))
      .catch(() => !cancelled && setFeatures({}));
    return () => {
      cancelled = true;
    };
  }, []);
  return useCallback((key: PlatformFeatureKey) => features?.[key]?.allowed === true, [features]);
}
