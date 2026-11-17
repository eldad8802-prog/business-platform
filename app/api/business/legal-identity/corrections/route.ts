/**
 * GET / POST /api/business/legal-identity/corrections — see ./handlers.ts.
 * OFF unless LEGAL_IDENTITY_CORRECTION_ENABLED=true (404). Draft: the owner has not approved the approver or the
 * verification policy; the database grants the decision function to nobody.
 */
import { correctionDeps } from "./deps";
import { handleGet, handlePost } from "./handlers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleGet(req, correctionDeps);
}

export async function POST(req: Request) {
  return handlePost(req, correctionDeps);
}
