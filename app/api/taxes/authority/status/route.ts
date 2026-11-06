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
 *
 * Response: { authority, productionPilot }. `productionPilot` is null unless the
 * caller's business AND the caller are admitted to the ITA production pilot;
 * then it carries the PRODUCTION connection status (same shape, no environment).
 */

import { NextRequest, NextResponse } from "next/server";
import { BillingAuthorityEnvironment } from "@prisma/client";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { getActiveAuthorityApp } from "@/lib/services/billing/authority/billing-authority-app.service";
import { getAuthorityConnectionStatus } from "@/lib/services/billing/authority/billing-authority-status.service";
import { resolveRuntimeAuthorityEnvironment } from "@/lib/services/billing/authority/billing-authority-env.service";
import { resolveAuthorityStatusRequest } from "@/lib/services/billing/authority/billing-authority-status-view.service";
import { runWithTenantContext } from "@/lib/tenant/context";

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

    const resolve = () =>
      resolveAuthorityStatusRequest({
        actor: { id: user.id, businessId: user.businessId },
        requestedBusinessId: req.nextUrl.searchParams.get("businessId"),
        environment: resolveEnvironmentSafe(),
        deps: {
          getActiveAuthorityApp,
          getAuthorityConnectionStatus,
          now: () => new Date(),
        },
        // Null unless the caller's business AND the caller are production-pilot
        // admitted; then the card offers the PRODUCTION connect.
        includeProductionPilot: true,
      });

    // BillingAuthorityConnection is FORCE RLS and the runtime role does not
    // bypass it; the connection read only scopes itself under an established
    // tenant context. Without one it matched zero rows and every business read
    // DISCONNECTED — even right after a successful OAuth callback. The context
    // is the caller's own business; the resolver still refuses any other
    // requested business before reading. No business → the resolver forbids.
    const businessId = user.businessId;
    const outcome =
      typeof businessId === "number" && Number.isInteger(businessId) && businessId > 0
        ? await runWithTenantContext({ businessId }, resolve)
        : await resolve();

    if (!outcome.ok) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    return NextResponse.json(
      { authority: outcome.dto, productionPilot: outcome.productionPilot },
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
