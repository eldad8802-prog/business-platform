import { NextResponse } from "next/server";

import { getBusinessStatusSnapshot } from "@/lib/business-status/business-status.service";
import { getCurrentUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businessId = user.businessId;
    const snapshot = await getBusinessStatusSnapshot(businessId);

    return NextResponse.json(snapshot);
  } catch (error: unknown) {
    console.error("GET /api/business-status error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to load business status";

    return NextResponse.json(
      { error: "Failed to load business status", details: message },
      { status: 500 }
    );
  }
}
