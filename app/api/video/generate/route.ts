import { generateVideo } from "@/lib/services/video.service";
import { getCurrentUser } from "@/lib/auth";

export async function POST(req: Request) {
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