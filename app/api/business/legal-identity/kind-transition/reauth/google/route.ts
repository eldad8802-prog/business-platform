/** "מעבר לעוסק מורשה" — Google re-authentication start → { url }. See kind-transition-handlers.ts. OFF → 404. */
import { handleKindTransitionReauthGoogle } from "@/lib/services/legal-identity/kind-transition-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleKindTransitionReauthGoogle(req);
}
