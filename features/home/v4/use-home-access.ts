"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchJsonCached, invalidateCachedJson } from "@/lib/ui/cached-json";

import { FAILED, LOADING, ready, type Load } from "../v3/home-v3-model";
import {
  businessKindOf,
  modulesFromCapabilities,
  planHrefFromCapabilities,
  resolveUserPermissions,
  subscriptionFromCapabilities,
  type BusinessProfileWire,
  type CapabilitiesWire,
  type HomeAccess,
} from "./home-access";
import { loadActivity } from "./pack-engine-loader";

const CAPS = "/api/business/capabilities";
const PROFILE = "/api/business/profile";

/**
 * The three access layers for surfaces outside the Home (the "+" sheet, "הכלים שלי"). The same reads the Home
 * makes, through the same short-lived cache, so opening the sheet right after the Home costs no request.
 * Fail-closed: until capabilities answer nothing module-bound is offered; if they fail, the caller says so.
 */
export function useHomeAccess(enabled = true): { access: Load<HomeAccess>; retry: () => void } {
  const [access, setAccess] = useState<Load<HomeAccess>>(LOADING);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const kindP = fetchJsonCached<BusinessProfileWire>(PROFILE, 60_000).then(businessKindOf).catch(() => "general" as const);
    fetchJsonCached<CapabilitiesWire>(CAPS, 60_000)
      .then(async (caps) => {
        const kind = await kindP;
        // Phase 2: the pack engine is downloaded only for a business that chose packs (null otherwise / on failure).
        const { activity, packs } = await loadActivity(caps);
        if (!cancelled) {
          setAccess(
            ready({
              businessId: typeof caps.businessId === "number" ? caps.businessId : null,
              modules: modulesFromCapabilities(caps),
              kind,
              permissions: resolveUserPermissions(),
              // Phase 2: the packs and the subscription view ride on the same answer (absent = unchanged).
              activity,
              packs,
              subscription: subscriptionFromCapabilities(caps),
              planHref: planHrefFromCapabilities(caps),
            }),
          );
        }
      })
      .catch(() => !cancelled && setAccess(FAILED));
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  const retry = useCallback(() => {
    invalidateCachedJson(CAPS);
    setAccess(LOADING);
    setNonce((n) => n + 1);
  }, []);

  return { access, retry };
}
