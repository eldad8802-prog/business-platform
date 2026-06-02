import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";
import { logPlatformAdminAreaEnteredIfDue } from "@/lib/services/platform-admin/platform-audit.service";
import type { PlatformAdminSessionResponse } from "@/lib/services/platform-admin/types";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) {
      return auth;
    }

    await logPlatformAdminAreaEnteredIfDue(auth.id, req);

    const body: PlatformAdminSessionResponse = {
      admin: {
        id: auth.id,
        email: auth.email,
        name: auth.name,
      },
      serverTime: new Date().toISOString(),
      environment: process.env.NODE_ENV ?? "development",
    };

    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    return handleError(error);
  }
}
