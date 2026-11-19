import { generateVideo } from "@/lib/services/video.service";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";

export async function POST(req: Request) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.CONTENT);
  if (featureDenied) return featureDenied;
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();

    console.log("VIDEO INPUT:", body);

    const result = await generateVideo(body, req);

    console.log("VIDEO RESULT:", result);

    return Response.json(result);
  } catch (e: any) {
    console.error("VIDEO ERROR:", e);

    return new Response(
      JSON.stringify({
        error: e?.message || "Internal error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}