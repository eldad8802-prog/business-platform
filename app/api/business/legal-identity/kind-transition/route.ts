/** "מעבר לעוסק מורשה" — see lib/services/legal-identity/kind-transition-handlers.ts. OFF → 404. */
import { handleKindTransitionConfirm, handleKindTransitionGet } from "@/lib/services/legal-identity/kind-transition-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleKindTransitionGet(req);
}

export async function POST(req: Request) {
  return handleKindTransitionConfirm(req);
}
