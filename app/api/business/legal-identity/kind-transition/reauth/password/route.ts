/** "מעבר לעוסק מורשה" — password re-authentication → proof cookie. See kind-transition-handlers.ts. OFF → 404. */
import { handleKindTransitionReauthPassword } from "@/lib/services/legal-identity/kind-transition-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleKindTransitionReauthPassword(req);
}
