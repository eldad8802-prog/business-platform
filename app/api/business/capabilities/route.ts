import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { runWithTenantContext } from "@/lib/tenant/context";
import { getBusinessCapabilities } from "@/lib/services/feature-access/business-capabilities.service";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // D2/PW-2: BusinessFeatureAccess is FORCE-RLS'd, so the resolver runs in a
    // tenant transaction and requires an established context. The tenant is the
    // session's own business — never a caller-supplied id.
    const businessId = user.businessId;
    const capabilities = await runWithTenantContext({ businessId }, () =>
      getBusinessCapabilities(businessId)
    );

    return NextResponse.json(capabilities, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
