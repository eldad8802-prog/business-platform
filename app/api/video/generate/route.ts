import { generateVideo } from "@/lib/services/video.service";

export async function POST(req: Request) {
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