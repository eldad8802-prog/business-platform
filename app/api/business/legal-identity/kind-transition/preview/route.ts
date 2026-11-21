/** "מעבר לעוסק מורשה" — validate and answer the statement digest. See kind-transition-handlers.ts. OFF → 404. */
import { handleKindTransitionPreview } from "@/lib/services/legal-identity/kind-transition-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleKindTransitionPreview(req);
}
