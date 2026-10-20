"use client";

import { useEffect, useState } from "react";

import { fetchJsonCached } from "@/lib/ui/cached-json";

/**
 * Whether a platform feature is ON for the signed-in business — read from GET /api/business/capabilities (the
 * same resolver the server uses). Fail-closed: OFF until the answer arrives and on any failure, so a gated entry
 * never flashes in and is never shown on a guess. The server still enforces the flag on every route.
 */
type CapabilitiesWire = { features?: Record<string, { allowed?: boolean }> };

const CAPABILITIES_TTL_MS = 60_000;

/** `null` while unknown, then true / false. A failed read is false. */
export function useFeatureState(featureKey: string, enabled = true): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchJsonCached<CapabilitiesWire>("/api/business/capabilities", CAPABILITIES_TTL_MS)
      .then((j) => {
        if (!cancelled) setOn(j.features?.[featureKey]?.allowed === true);
      })
      .catch(() => {
        if (!cancelled) setOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [featureKey, enabled]);
  return on;
}

/** True only once the feature is known to be ON. */
export function useFeatureEnabled(featureKey: string, enabled = true): boolean {
  return useFeatureState(featureKey, enabled) === true;
}
