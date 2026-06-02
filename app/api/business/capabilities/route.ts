import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import { getBusinessCapabilities } from "@/lib/services/feature-access/business-capabilities.service";

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const capabilities = await getBusinessCapabilities(user.businessId);

    return NextResponse.json(capabilities, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
