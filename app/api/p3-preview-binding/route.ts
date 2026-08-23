// D2 / P3-1 — GATE A: zero-connection Preview binding probe.
//
// WHAT THIS DOES
//   Parses process.env.DATABASE_URL / DIRECT_URL as strings and returns ONLY
//   derived, non-secret identity: endpoint id, pooled/direct classification,
//   database name, host suffix. Nothing else from the value is read, kept, or
//   returned — no user, no password, no query string, no full host.
//
// WHAT THIS DOES NOT DO
//   It never constructs a database client, never imports Prisma, and never
//   makes a network call of any kind. It therefore cannot touch Production
//   even if the Preview binding turned out to be wrong — which is exactly why
//   it is safe to use as the Gate A provenance channel.
//
// SCOPE
//   Refuses to answer unless VERCEL_ENV === "preview". Lives only on branch
//   d2/p3-runtime-qualification and is never merged to main.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Identity = {
  present: boolean;
  endpoint: string | null;
  mode: "pooled" | "direct" | null;
  database: string | null;
  hostSuffix: string | null;
  parseError?: string;
};

function identify(raw: string | undefined): Identity {
  if (!raw) {
    return { present: false, endpoint: null, mode: null, database: null, hostSuffix: null };
  }

  let host = "";
  let database: string | null = null;

  try {
    const u = new URL(raw);
    host = u.hostname;
    database = (u.pathname || "").replace(/^\//, "") || null;
  } catch {
    return {
      present: true,
      endpoint: null,
      mode: null,
      database: null,
      hostSuffix: null,
      parseError: "unparseable",
    };
  }

  const first = host.split(".")[0] ?? "";
  const pooled = first.endsWith("-pooler");
  const endpoint = pooled ? first.slice(0, -"-pooler".length) : first;
  const hostSuffix = host.split(".").slice(1).join(".") || null;

  return {
    present: true,
    endpoint: endpoint || null,
    mode: pooled ? "pooled" : "direct",
    database,
    hostSuffix,
  };
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return new Response(JSON.stringify({ error: "preview-only probe" }), {
      status: 404,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const body = {
    probe: "d2-p3-1-gate-a",
    note: "zero-connection probe: no database client is constructed and no network call is made",
    vercelEnv: process.env.VERCEL_ENV ?? null,
    gitBranch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    DATABASE_URL: identify(process.env.DATABASE_URL),
    DIRECT_URL: identify(process.env.DIRECT_URL),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
