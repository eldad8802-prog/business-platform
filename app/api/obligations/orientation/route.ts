import { NextRequest, NextResponse } from "next/server";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";
import { handleError } from "@/lib/handle-error";
import {
  getOrientation,
  markOriented,
} from "@/lib/services/obligations/obligation.service";
import { obligationServiceDeps } from "@/lib/services/obligations/obligations.deps";
import { toOrientationApi } from "@/lib/services/obligations/obligation-api.serializer";

export const runtime = "nodejs";

/** Current orientation posture for the business. */
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const orientation = await getOrientation(
      user.businessId,
      obligationServiceDeps()
    );
    return NextResponse.json(toOrientationApi(orientation), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}

/** Mark the business oriented — the owner affirmed the recurring backbone. */
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser(req);
    if (!user) return authRequiredResponse(req);

    const orientation = await markOriented(
      user.businessId,
      obligationServiceDeps()
    );
    return NextResponse.json(toOrientationApi(orientation), { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
