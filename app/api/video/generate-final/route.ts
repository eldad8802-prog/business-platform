import { generateFinalContent } from "@/lib/services/final-generation.service";
import { guardFeature } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import { getCurrentUser } from "@/lib/auth";

type Body = {
  selectedFormat?: "reel" | "video" | "image" | "post";
  plan?: any;
};

export async function POST(req: Request) {
  const featureDenied = await guardFeature(req, PLATFORM_FEATURE_KEYS.CONTENT);
  if (featureDenied) return featureDenied;
  const user = await getCurrentUser(req);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as Body;

    if (!body.selectedFormat || !body.plan) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const result = await generateFinalContent({
      selectedFormat: body.selectedFormat,
      plan: body.plan,
    });

    return Response.json(result);
  } catch (error) {
    console.error("GENERATE FINAL ERROR:", error);

    return Response.json(
      { error: "Failed to generate final content" },
      { status: 500 }
    );
  }
}