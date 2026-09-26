import { generateVideo } from "@/lib/services/video.service";
import { getCurrentUser } from "@/lib/auth";
import { logRouteError } from "@/lib/security/route-error";

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    // L-12: the request body and the provider result are no longer logged —
    // they carry customer-authored content.
    const result = await generateVideo(body, req);

    return Response.json(result);
  } catch (e: unknown) {
    logRouteError("POST /api/video/generate", e);

    // L-12: never the raw exception text.
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
