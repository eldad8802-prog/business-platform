/** GET …/[id]/attachments/[attachmentId] — one supporting document, as a download (audited). See ../../../handlers.ts. */
import { NextRequest, NextResponse } from "next/server";

import { requirePlatformAdminOrResponse } from "@/lib/auth/platform-admin";
import { handleError } from "@/lib/handle-error";

import { correctionAdminDeps } from "../../../deps";
import { handleAttachment } from "../../../handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  try {
    const auth = await requirePlatformAdminOrResponse(req);
    if (auth instanceof NextResponse) return auth;
    const { id, attachmentId } = await params;
    return await handleAttachment(req, auth, id, attachmentId, correctionAdminDeps);
  } catch (error) {
    return handleError(error);
  }
}
