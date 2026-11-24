/** 4a T4 — documents issued between the official status date and the Dubiz update. Read only. Flag OFF → 404. */
import { handleInterimDocumentsGet } from "@/lib/services/billing/kind-transition/interim-documents-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handleInterimDocumentsGet(req);
}
