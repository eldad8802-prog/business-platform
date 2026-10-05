import type { Prisma } from "@prisma/client";
import { getLandingBusinessContext } from "./landing-business-context";
import { buildLandingStrategySet, type LandingStrategySet } from "./landing-strategy-engine";

/**
 * P3-B · The one entry point: the business's landing strategy set, computed on read inside the
 * caller's tenant transaction. Nothing is written — a strategy set is a MACHINE_PROPOSAL, never stored
 * as knowledge or as an owner decision. The result is frozen so no downstream consumer (a future AI
 * composer included) can alter authority, conversion, trust or evidence in place.
 */
export async function getLandingStrategySet(businessId: number, tx: Prisma.TransactionClient, now = new Date()): Promise<LandingStrategySet> {
  return deepFreeze(buildLandingStrategySet(await getLandingBusinessContext(businessId, tx, now)));
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
