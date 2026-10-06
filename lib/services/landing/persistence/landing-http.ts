import { NextResponse } from "next/server";
import { trustErrorResponse } from "@/lib/services/trust/trust-http";
import { LandingStrategyNotAvailableError } from "../composer/landing-blueprint.service";
import { LandingPersistenceError } from "./landing-page.service";

/** Owner-only landing responses: never cached, never indexed. */
export const LANDING_NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } as const;

/** A route version id. Anything but a positive integer is "not found" — never parsed further. */
export async function versionIdParam(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) return null;
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function versionNotFound(): NextResponse {
  return NextResponse.json({ error: "VERSION_NOT_FOUND", code: "VERSION_NOT_FOUND" }, { status: 404, headers: LANDING_NO_STORE });
}

/** Shared error mapping for /api/business/landing/**. Codes only; never a snapshot or a ref. */
export function landingErrorResponse(error: unknown, label: string): NextResponse {
  if (error instanceof LandingPersistenceError) {
    return NextResponse.json({ error: error.code, code: error.code, detail: error.detail }, { status: error.status, headers: LANDING_NO_STORE });
  }
  if (error instanceof LandingStrategyNotAvailableError) {
    return NextResponse.json({ error: error.message, code: "STRATEGY_NOT_AVAILABLE" }, { status: 409, headers: LANDING_NO_STORE });
  }
  // A concurrent owner act lost the race at the database (pointer check, lifecycle guard, unique index,
  // serialization): nothing was written; the client reloads and decides again.
  if (error instanceof Error && /P3E_(POINTER|LIFECYCLE|IMMUTABLE)|Unique constraint|23505|40001/.test(error.message)) {
    console.warn(`[landing-persistence] CONFLICT ${label}`);
    return NextResponse.json({ error: "CONFLICT", code: "CONFLICT" }, { status: 409, headers: LANDING_NO_STORE });
  }
  return trustErrorResponse(error, label);
}
