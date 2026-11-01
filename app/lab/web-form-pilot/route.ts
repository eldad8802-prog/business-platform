/**
 * GET /lab/web-form-pilot — TEMPORARY (website-form live proof, business 9).
 *
 * The stock website form, served from Dubiz's own origin, only with a valid pilot pass for a live
 * business-9 website connection; 404 otherwise. Never linked from any menu. Writes nothing — the
 * form posts to the public intake endpoint like any business's website.
 * See lib/intake/acquisition/web-form-pilot.ts. Remove with the pilot.
 */
import { resolvePublicConnection } from "@/lib/intake/acquisition/resolve";
import { handlePilotPage } from "@/lib/intake/acquisition/web-form-pilot";
import { WEB_FORM_SOURCE } from "@/lib/intake/acquisition/providers/web-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handlePilotPage(req, { resolve: (publicId) => resolvePublicConnection(WEB_FORM_SOURCE, publicId) });
}
