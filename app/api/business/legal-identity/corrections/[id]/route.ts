/** DELETE /api/business/legal-identity/corrections/[id] — the requester withdraws an open request. See ../handlers.ts. */
import { correctionDeps } from "../deps";
import { handleDelete } from "../handlers";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleDelete(req, id, correctionDeps);
}
