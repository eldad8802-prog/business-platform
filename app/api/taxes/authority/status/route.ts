/**
 * Israel Tax Authority (ITA) connection STATUS (read-only).
 *
 * Path:   GET /api/taxes/authority/status
 * Pairs with the OAuth start/callback at /api/taxes/oauth/{connect,callback}.
 *
 * Exposes the existing authority status read model as a small, safe DTO for the
 * Settings UI. Auth-gated (getCurrentUser) and tenant-isolated: a caller may
 * only read its own business, never another's. Never returns tokens, ciphertext,
 * client secret, or any OAuth material. A missing platform app degrades to a
 * quiet NOT_CONFIGURED status, not a raw 500.
 *
 * Does not touch the OAuth mechanism — read-only exposure only.
 */

import { NextRequest, NextResponse } from "next/server";
import { BillingAuthorityEnvironment } from "@prisma/client";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { getActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import { getAuthorityConnectionStatus } from "@/lib/services/billing/authority/billing-authority-status.service";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import { resolveAuthorityStatusRequest } from "@/lib/services/billing/authority/billing-authority-status-view.service";

export const runtime = "nodejs";

/**
 * Resolves the deployment's authority environment. A misconfigured/absent
 * runtime env selector is not fatal for a read-only status view: default to
 * SANDBOX for display; the DTO still reports NOT_CONFIGURED when the platform
 * app is absent.
 */
function resolveEnvironmentSafe(): BillingAuthorityEnvironment {
  try {
    return resolveRuntimeAuthorityEnvironment();
  } catch {
    return BillingAuthorityEnvironment.SANDBOX;
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return authRequiredResponse(req);
    }

    const outcome = await resolveAuthorityStatusRequest({
      actor: { id: user.id, businessId: user.businessId },
      requestedBusinessId: req.nextUrl.searchParams.get("businessId"),
      environment: resolveEnvironmentSafe(),
      deps: {
        getActiveAuthorityApp,
        getAuthorityConnectionStatus,
        now: () => new Date(),
      },
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    return NextResponse.json(
      { authority: outcome.dto },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    // Log only the error name — never the message/stack (may carry config).
    console.error(
      "AUTHORITY_STATUS_ERROR:",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
