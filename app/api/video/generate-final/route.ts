import { generateFinalContent } from "@/lib/services/final-generation.service";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

type Body = {
  selectedFormat?: "reel" | "video" | "image" | "post";
  plan?: any;
};

export async function POST(req: Request) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
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