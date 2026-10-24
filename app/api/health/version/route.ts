/**
 * GET — the deployment answering right now. Public and harmless: the same id is already on every page as
 * <html data-dpl-id>. The shell compares the two (components/navigation/stale-client-reload.tsx) so an app opened
 * before a deploy — a home-screen app kept alive by iOS, whose page requests Vercel's skew protection keeps on the
 * old deployment for up to 12 h — reloads once into the current one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Next inlines NEXT_DEPLOYMENT_ID as `false` when no id is configured: only a real string counts.
  const id: unknown = process.env.VERCEL_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID;
  const deploymentId = typeof id === "string" && id ? id : null;
  return Response.json({ deploymentId }, { headers: { "cache-control": "no-store" } });
}
