/** GET /api/platform-admin/legal-identity-corrections — the approver's list (?filter=all for history). See ./handlers.ts. */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";

import { correctionAdminDeps } from "./deps";
import { handleList } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    return await handleList(req, auth, correctionAdminDeps);
  } catch (error) {
    return handleError(error);
  }
}
