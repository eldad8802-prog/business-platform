"use client";

/**
 * Carries the server's flag answer (app/business/layout.tsx) to the business screens. Default false: without the
 * provider nothing asks the API. This only spares a request that would answer 404 — the routes enforce the flag on
 * the server for every caller, whatever a client believes.
 */
import { createContext, useContext, type ReactNode } from "react";

const KindTransitionFlagContext = createContext(false);

export function KindTransitionFlagProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <KindTransitionFlagContext.Provider value={enabled}>{children}</KindTransitionFlagContext.Provider>;
}

export function useKindTransitionEnabled(): boolean {
  return useContext(KindTransitionFlagContext);
}
