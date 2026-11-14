/** GET /api/platform-admin/legal-identity-corrections/[id] — one request, full values (audited). See ../handlers.ts. */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";

import { correctionAdminDeps } from "../deps";
import { handleDetail } from "../handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;
    return await handleDetail(req, auth, id, correctionAdminDeps);
  } catch (error) {
    return handleError(error);
  }
}
