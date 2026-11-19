/**
 * GET /api/business/legal-identity/corrections/[id]/attachments/[attachmentId] — a document of the session's own
 * business, as a download (Content-Disposition: attachment, nosniff). See ../../../handlers.ts. 404 unless
 * LEGAL_IDENTITY_CORRECTION_ENABLED=true.
 */
import { correctionDeps } from "../../../deps";
import { handleDownload } from "../../../handlers";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  const { id, attachmentId } = await params;
  return handleDownload(req, id, attachmentId, correctionDeps);
}
