import { getCreatomateRenderStatus } from "@/lib/services/creatomate.service";
import { authRequiredResponse, getCurrentUser } from "@/lib/auth";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser(req);
  if (!user) {
      return authRequiredResponse(req);
    }

  try {
    const { id } = await context.params;

    if (!id) {
      return Response.json({ error: "missing_render_id" }, { status: 400 });
    }

    const render = await getCreatomateRenderStatus(id);

    return Response.json({
      id: render.id,
      status: render.status,
      url: render.url ?? null,
      snapshotUrl: render.snapshot_url ?? null,
      errorMessage: render.error_message ?? null,
    });
  } catch (err) {
    console.error(err);

    return Response.json(
      { error: "failed_to_get_render_status" },
      { status: 500 }
    );
  }
}