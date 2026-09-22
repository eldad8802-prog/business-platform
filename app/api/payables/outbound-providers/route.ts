import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { runWithTenantContext } from "@/lib/tenant/context";
import {
  handlePayablesError,
} from "@/lib/services/payables/payables-http";
import * as outbound from "@/lib/services/payables/payables-outbound.service";

export const runtime = "nodejs";

/**
 * Which outbound providers can execute a payment. Empty today — and the
 * screen says so rather than offering a button that cannot work.
 */
export async function GET(
  req: NextRequest,
) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const result = await runWithTenantContext({ businessId: user.businessId }, () =>
      Promise.resolve(outbound.listOutboundProviders()),
    );
    return NextResponse.json({ providers: result, live: result.length > 0 });
  } catch (error) {
    return handlePayablesError(error);
  }
}
