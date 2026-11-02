/**
 * Platform-Admin, read-only: ITA production pilot gate SELF-CHECK.
 *
 * Path: GET /api/platform-admin/authority/pilot-gate?businessId=<id>&userId=<id>
 *
 * Reports what THIS deployment's env would allow in PRODUCTION for the given
 * business + user, per operation (OAuth start, code exchange, refresh,
 * validation, Approval, Decision, probe), with the internal refusal reason.
 * Computed by the same gate functions the call sites use — see
 * billing-authority-pilot-gate-report.ts.
 *
 * No call to ITA, no DB access, no token, no secret: env values are never
 * echoed (lists → status + count; stage → stage + value classification;
 * runtime selector → name + parsed value). Protected by the canonical
 * Platform-Admin guard (fails closed).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdminOrResponse,
  type PlatformAdminUser,
} from "@/lib/auth/platform-admin";
import { buildAuthorityPilotGateReport } from "@/lib/services/billing/authority/billing-authority-pilot-gate-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export type PilotGateHandlerDeps = {
  authorize?: (req: Request) => Promise<PlatformAdminUser | NextResponse>;
  env?: Readonly<Record<string, string | undefined>>;
};

function parseId(raw: string | null): number | null {
  if (raw == null || !/^[1-9]\d{0,9}$/.test(raw.trim())) return null;
  const id = Number(raw.trim());
  return Number.isSafeInteger(id) ? id : null;
}

/** Testable handler: canonical Platform-Admin authorization → pure report. */
export async function handleAuthorityPilotGate(
  req: NextRequest,
  deps: PilotGateHandlerDeps = {}
): Promise<NextResponse> {
  const authorize = deps.authorize ?? requirePlatformAdminOrResponse;

  try {
    const auth = await authorize(req);
    if (auth instanceof NextResponse) {
      // 401/403 straight from the canonical guard — nothing is computed.
      return auth;
    }

    const sp = req.nextUrl.searchParams;
    const businessId = parseId(sp.get("businessId"));
    const userId = parseId(sp.get("userId"));
    if (businessId == null || userId == null) {
      return NextResponse.json(
        { error: "invalid_input", detail: "businessId and userId must be positive integers" },
        { status: 400, headers: NO_STORE }
      );
    }

    const report = buildAuthorityPilotGateReport({ businessId, userId }, deps.env ?? process.env);
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (error) {
    // Log only the error name — never the message/stack.
    console.error(
      "AUTHORITY_PILOT_GATE_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(req: NextRequest) {
  return handleAuthorityPilotGate(req);
}
