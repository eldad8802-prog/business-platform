/**
 * POST /api/business/legal-identity/corrections/[id]/attachments — a supporting document for the user's own PENDING
 * request (multipart, field "file": PDF / JPEG / PNG, ≤ 10 MB). See ../../handlers.ts. 404 unless
 * LEGAL_IDENTITY_CORRECTION_ENABLED=true.
 */
import { correctionDeps } from "../../deps";
import { handleUpload } from "../../handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleUpload(req, id, correctionDeps);
}
