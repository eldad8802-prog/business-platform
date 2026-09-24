/**
 * Temporary ITA egress probe route (run manually):
 *   npx tsx app/api/diagnostics/ita-egress-probe/route.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleItaEgressProbe } from "@/app/api/diagnostics/ita-egress-probe/route";
import type { AuthorityTokenProbeResult } from "@/lib/services/billing/authority/billing-authority-token-probe.service";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}`, extra ?? "");
  }
}

const RESULT: AuthorityTokenProbeResult = {
  networkReachable: true,
  httpStatusIfAny: 400,
  networkErrorClass: null,
  requestDurationBucket: "<1s",
  runtime: "nodejs",
  region: "iad1",
};

async function main(): Promise<void> {
  for (const env of ["production", "development", null, "PREVIEW ", ""]) {
    let calls = 0;
    const res = await handleItaEgressProbe({
      vercelEnv: () => env,
      probe: async () => {
        calls += 1;
        return RESULT;
      },
    });
    ok(`VERCEL_ENV=${JSON.stringify(env)} -> 410`, res.status === 410);
    ok(`VERCEL_ENV=${JSON.stringify(env)} -> probe never runs`, calls === 0);
  }

  let calls = 0;
  const res = await handleItaEgressProbe({
    vercelEnv: () => "preview",
    probe: async () => {
      calls += 1;
      return RESULT;
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  ok("preview -> 200", res.status === 200);
  ok("preview -> probe runs exactly once", calls === 1);
  ok("preview -> sanitized fields only",
    Object.keys(body).sort().join(",") ===
      "finishedAt,httpStatusIfAny,networkErrorClass,networkReachable,region,requestDurationBucket,runtime,startedAt");

  const failing = await handleItaEgressProbe({
    vercelEnv: () => "preview",
    probe: async () => {
      throw new Error("secret-ish config detail");
    },
  });
  const failBody = JSON.stringify(await failing.json());
  ok("probe throw -> 500", failing.status === 500);
  ok("probe throw -> no error message leaked", !failBody.includes("secret-ish"));

  const src = readFileSync(join(process.cwd(), "app/api/diagnostics/ita-egress-probe/route.ts"), "utf8");
  ok("route never reads the request", !/export async function POST\(\s*\w/.test(src) && !/req\.|request\./.test(src));
  ok("route passes no overrides to the probe", /runAuthorityTokenNetworkProbe\(\)/.test(src));
  ok("route touches no DB / auth", !/prisma|tenantTx|getCurrentUser|requirePlatformAdmin/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok("only POST is exported", !/export async function (GET|PUT|PATCH|DELETE)/.test(src));

  if (failed > 0) {
    console.error(`\n${failed} FAILED`);
    process.exit(1);
  }
  console.log("\nALL PASS");
}

void main();
