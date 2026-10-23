/**
 * Verify — who may run the Bank of Israel rate fetch (app/api/cron/fx-rates/route.ts), and that it does
 * nothing unless BOTH the scheduler credential and the owner's enable flag and the writer credential exist.
 * Pure: no database, the network is blocked (every fetch would be counted and fail).
 * Run: npx tsx lib/fx/fx-rates-route-auth.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

let checks = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  assert.ok(cond, `${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  checks += 1;
  console.log(`  ok ${label}`);
};

const SECRET = "fx_route_test_cron_secret_synthetic_0123456789";
const URL_ = "https://example.test/api/cron/fx-rates";

async function main() {
  for (const k of ["DATABASE_URL", "DIRECT_URL", "CRON_SECRET", "CRON_SECRET_NEXT", "FX_RATES_FETCH_ENABLED", "FX_RATE_WRITER_DATABASE_URL"]) delete process.env[k];
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("network blocked in test");
  }) as typeof fetch;
  const origError = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => void logged.push(a);

  const route = await import("../../app/api/cron/fx-rates/route");
  const call = async (verb: "GET" | "POST", auth?: string) => {
    const req = new NextRequest(URL_, { method: verb, headers: auth ? { authorization: auth } : {} });
    const res = await (verb === "GET" ? route.GET(req) : route.POST(req));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  try {
    console.log("1. scheduler credential");
    let r = await call("GET", `Bearer ${SECRET}`);
    ok("CRON_SECRET not configured → 503 (fails closed)", r.status === 503 && r.body.error === "cron_not_configured", r);
    process.env.CRON_SECRET = SECRET;
    process.env.FX_RATES_FETCH_ENABLED = "true"; // even when enabled, no credential = nothing
    r = await call("GET");
    ok("no bearer → 401", r.status === 401 && JSON.stringify(r.body) === JSON.stringify({ error: "unauthorized" }), r);
    r = await call("POST", "Bearer wrong-wrong-wrong-wrong-wrong-wrong-wrong");
    ok("wrong bearer → 401, nothing else revealed", r.status === 401 && JSON.stringify(r.body) === JSON.stringify({ error: "unauthorized" }), r);
    r = await call("GET", SECRET);
    ok("secret without the Bearer scheme → 401", r.status === 401, r);

    console.log("2. the owner's enable flag");
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      if (v === undefined) delete process.env.FX_RATES_FETCH_ENABLED;
      else process.env.FX_RATES_FETCH_ENABLED = v;
      r = await call("GET", `Bearer ${SECRET}`);
      ok(`FX_RATES_FETCH_ENABLED=${JSON.stringify(v)} → 404, no fetch`, r.status === 404 && r.body.error === "not_found" && fetches === 0, { r, fetches });
    }

    console.log("3. the writer credential");
    process.env.FX_RATES_FETCH_ENABLED = "true";
    r = await call("GET", `Bearer ${SECRET}`);
    ok("enabled but FX_RATE_WRITER_DATABASE_URL absent → 503, no fetch", r.status === 503 && r.body.error === "fx_rate_writer_not_configured" && fetches === 0, { r, fetches });
    process.env.DATABASE_URL = "postgresql://app_runtime_prod:x@db.example/app";
    process.env.FX_RATE_WRITER_DATABASE_URL = process.env.DATABASE_URL;
    r = await call("POST", `Bearer ${SECRET}`);
    ok("writer URL = the runtime's URL → refused 503 (never the app's connection), no fetch", r.status === 503 && r.body.error === "fx_rate_writer_misconfigured" && fetches === 0, { r, fetches });
    delete process.env.DATABASE_URL;
    delete process.env.FX_RATE_WRITER_DATABASE_URL;

    console.log("4. static scope");
    const root = process.cwd();
    const code = (f: string) => fs.readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons?: { path: string }[] };
    ok("NOT scheduled: vercel.json has no cron for /api/cron/fx-rates", !(vercel.crons ?? []).some((c) => c.path.includes("fx-rates")), vercel.crons);
    const wfDir = path.join(root, ".github/workflows");
    const scheduled = fs.readdirSync(wfDir).filter((f) => /api\/cron\/fx-rates/.test(fs.readFileSync(path.join(wfDir, f), "utf8")));
    ok("NOT scheduled: no workflow calls the endpoint", scheduled.length === 0, scheduled);
    const routeCode = code("app/api/cron/fx-rates/route.ts");
    ok("the route reads no request input beyond the authorization header", !/req\.(json|text|formData|nextUrl|url)\b|searchParams/.test(routeCode));
    ok("the route never passes an origin to the run (BoI only in Production)", /runFxRateFetch\(\)/.test(routeCode));
    const writerImporters: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = path.posix.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /prisma-fx-writer/.test(code(rel))) writerImporters.push(rel);
      }
    };
    walk("app");
    walk("lib");
    ok("only lib/fx/fx-rate-writer.ts reaches the writer client", JSON.stringify(writerImporters.sort()) === JSON.stringify(["lib/fx/fx-rate-writer.ts"]), writerImporters);
    const converters = ["lib/fx/boi-parser.ts", "lib/fx/boi-client.ts", "lib/fx/fx-rate-writer.ts", "lib/fx/fx-rates-run.ts", "lib/fx/fx-rate-status.ts", "app/api/cron/fx-rates/route.ts"].filter((f) => /\bconvert\(|totalIn\(|selectRate\(/.test(code(f)));
    ok("nothing in this slice converts money", converters.length === 0, converters);
    ok("no network call was made by any refused request", fetches === 0, fetches);
  } finally {
    console.error = origError;
  }
  console.log(`fx-rates-route-auth: ${checks} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
