/**
 * FX-BOI lab — the Bank of Israel fetcher against a REAL migrated PG17 (migration 20261025090000 applied by
 * `prisma migrate deploy` in Production's role topology, .fx/lab.sh) and a LOCAL mock of the BoI endpoint
 * serving the recorded-style fixtures (.fxboi/fixtures). Zero external network, zero secrets.
 *
 * Connections are the real roles:
 *   DATABASE_URL                 app_runtime_prod (LOGIN member of the NOLOGIN NOBYPASSRLS app_runtime) — reads
 *   FX_RATE_WRITER_DATABASE_URL  fx_rate_writer_lab (LOGIN member of fx_rate_writer, lab only) — appends
 *   LAB_DB + SUPER/PGPASSWORD    superuser psql, for counting and for the role probes
 *
 * Run: npx tsx .fxboi/lab.mts   (env above; see .github/workflows/fx-boi-rates-lab.yml)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const DB = process.env.LAB_DB ?? "";
const SUPER = process.env.SUPER ?? "";
const LAB_PASSWORD = process.env.LAB_PASSWORD ?? "";
assert.ok(DB && SUPER && LAB_PASSWORD && process.env.DATABASE_URL && process.env.FX_RATE_WRITER_DATABASE_URL, "LAB_DB, SUPER, LAB_PASSWORD, DATABASE_URL, FX_RATE_WRITER_DATABASE_URL required");
for (const u of [process.env.DATABASE_URL!, process.env.FX_RATE_WRITER_DATABASE_URL!]) {
  assert.ok(/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(u), "lab connections must be local");
}

let pass = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  if (!cond) {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}`);
    process.exit(1);
  }
  pass += 1;
  console.log(`  [PASS] ${label}`);
};

function psql(user: string, sql: string, password = LAB_PASSWORD): { ok: boolean; out: string; err: string } {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", DB, "-c", sql], {
    encoding: "utf8",
    env: { ...process.env, PGPASSWORD: password },
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const su = (sql: string) => {
  const r = psql(SUPER, sql, process.env.PGPASSWORD ?? "");
  if (!r.ok) throw new Error(`superuser psql failed: ${r.err}`);
  return r.out;
};
const count = () => Number(su(`SELECT count(*) FROM "FxRate"`));

// ── mock Bank of Israel ──────────────────────────────────────────────────────
type Serve = string | { file: string; replace?: [string, string] } | "hang" | "redirect" | "html200" | "500";
let scenario: { USD: Serve; EUR: Serve } = { USD: "usd-day1.csv", EUR: "eur-day1.csv" };
const hits: string[] = [];
const fixture = (f: string) => fs.readFileSync(path.join(process.cwd(), ".fxboi/fixtures", f));
const server = http.createServer((req, res) => {
  hits.push(req.url ?? "");
  const base = /RER_USD_ILS/.test(req.url ?? "") ? "USD" : /RER_EUR_ILS/.test(req.url ?? "") ? "EUR" : null;
  if (!base || !/^\/FusionEdgeServer\/sdmx\/v2\/data\/dataflow\/BOI\.STATISTICS\/EXR\/1\.0\/RER_(USD|EUR)_ILS\?startperiod=\d{4}-\d{2}-\d{2}&endperiod=\d{4}-\d{2}-\d{2}&format=csv$/.test(req.url ?? "")) {
    res.writeHead(404, { "content-type": "text/html" });
    return res.end("<html>not found</html>");
  }
  const s = scenario[base];
  if (s === "hang") {
    res.writeHead(200, { "content-type": "text/csv;charset=UTF-8" });
    res.write("SERIES_CODE,");
    return;
  }
  if (s === "redirect") {
    res.writeHead(302, { location: "https://attacker.example/fake.csv" });
    return res.end();
  }
  if (s === "html200") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end("<!DOCTYPE html><html>שגיאה</html>");
  }
  if (s === "500") {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end("error");
  }
  const spec = typeof s === "string" ? { file: s } : s;
  let body = fixture(spec.file).toString("utf8");
  if (spec.replace) body = body.replace(spec.replace[0], spec.replace[1]);
  res.writeHead(200, { "content-type": "text/csv;charset=UTF-8" });
  res.end(body);
});

type Summary = Awaited<ReturnType<typeof import("../lib/fx/fx-rates-run").runFxRateFetch>>;
const pairOf = (s: Summary, base: "USD" | "EUR") => ("pairs" in s ? s.pairs.find((p) => p.pair === `${base}/ILS`)! : null);
const shape = (s: Summary, base: "USD" | "EUR") => {
  const p = pairOf(s, base);
  return p ? { fetched: p.fetched, inserted: p.inserted, skipped: p.skipped, unverified: p.unverified, revised: p.revised, rejected: p.rejected, error: p.error } : s;
};

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { runFxRateFetch } = await import("../lib/fx/fx-rates-run");
  const { getFxRateStatus } = await import("../lib/fx/fx-rate-status");
  const { prisma } = await import("../lib/prisma");
  const { getPrismaFxWriter } = await import("../lib/prisma-fx-writer");
  const logs: { level: string; tag: string; data: Record<string, unknown> }[] = [];
  const run = (now: string, extra: Partial<Parameters<typeof runFxRateFetch>[0]> = {}) =>
    runFxRateFetch({ now: new Date(now), origin, timeoutMs: 1500, log: (level, tag, data) => void logs.push({ level, tag, data }), ...extra });

  ok("baseline: the migrated table is empty", count() === 0, count());

  console.log("L1 — first run (day 1, window 2026-10-13..2026-10-22)");
  scenario = { USD: "usd-day1.csv", EUR: "eur-day1.csv" };
  hits.length = 0;
  const s1 = await run("2026-10-22T13:30:00.000Z");
  ok("run ok", "pairs" in s1 && s1.ok, s1);
  ok("window = last 10 days in Asia/Jerusalem", "window" in s1 && s1.window.start === "2026-10-13" && s1.window.end === "2026-10-22", s1);
  ok("exactly one request per series, the documented window", hits.length === 2 && hits.every((h) => /startperiod=2026-10-13&endperiod=2026-10-22&format=csv$/.test(h)), hits);
  ok("USD: 8 fetched, 8 inserted, the oldest UNVERIFIED (no baseline)", JSON.stringify(shape(s1, "USD")) === JSON.stringify({ fetched: 8, inserted: 8, skipped: 0, unverified: 1, revised: 0, rejected: 0, error: null }), shape(s1, "USD"));
  ok("EUR (CRLF fixture): 8 fetched, 8 inserted, 1 UNVERIFIED", JSON.stringify(shape(s1, "EUR")) === JSON.stringify({ fetched: 8, inserted: 8, skipped: 0, unverified: 1, revised: 0, rejected: 0, error: null }), shape(s1, "EUR"));
  ok("16 rows in the table", count() === 16, count());
  ok("stored exactly, scale 10 (USD 2026-10-21 = 3.0910000000)", su(`SELECT "rate"::text FROM "FxRate" WHERE "base" = 'USD' AND "rateDate" = '2026-10-21'`) === "3.0910000000");
  ok("JPY-free: only USD/ILS and EUR/ILS, BANK_OF_ISRAEL, REPRESENTATIVE", su(`SELECT string_agg(DISTINCT "base" || '/' || "quote" || '/' || "kind" || '/' || "source", ',' ORDER BY "base" || '/' || "quote" || '/' || "kind" || '/' || "source") FROM "FxRate"`) === "EUR/ILS/REPRESENTATIVE/BANK_OF_ISRAEL,USD/ILS/REPRESENTATIVE/BANK_OF_ISRAEL");
  ok("fetchedAt = the run's instant (UTC)", su(`SELECT DISTINCT "fetchedAt"::text FROM "FxRate"`) === "2026-10-22 13:30:00");
  ok("sourceRef = series code + request URL", su(`SELECT count(*) FROM "FxRate" WHERE "sourceRef" LIKE 'RER_' || "base" || '_ILS http://127.0.0.1:%/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_' || "base" || '_ILS?startperiod=2026-10-13&endperiod=2026-10-22&format=csv'`) === "16");
  ok("UNVERIFIED rows are exactly the two first days (NO_BASELINE)", su(`SELECT string_agg("base" || ' ' || "rateDate"::text, ',' ORDER BY "base") FROM "FxRate" WHERE "verification" = 'UNVERIFIED'`) === "EUR 2026-10-13,USD 2026-10-13");
  ok("NO_BASELINE alerts logged", logs.filter((l) => l.tag === "alert" && l.data.event === "FX_RATE_NO_BASELINE").length === 2, logs);

  console.log("L2 — idempotent re-run");
  logs.length = 0;
  const s2 = await run("2026-10-22T15:00:00.000Z");
  ok("USD: 8 skipped, nothing inserted", JSON.stringify(shape(s2, "USD")) === JSON.stringify({ fetched: 8, inserted: 0, skipped: 8, unverified: 0, revised: 0, rejected: 0, error: null }), shape(s2, "USD"));
  ok("EUR: 8 skipped, nothing inserted", pairOf(s2, "EUR")?.skipped === 8 && pairOf(s2, "EUR")?.inserted === 0, shape(s2, "EUR"));
  ok("still 16 rows, no alert", count() === 16 && logs.filter((l) => l.tag === "alert").length === 0, { n: count(), logs });

  console.log("L3 — a changed value for a stored date = a new row with a later fetchedAt");
  scenario = { USD: "usd-day1-revised.csv", EUR: "eur-day1.csv" };
  const s3 = await run("2026-10-22T16:00:00.000Z");
  ok("USD: 1 inserted (revised), 7 skipped", JSON.stringify(shape(s3, "USD")) === JSON.stringify({ fetched: 8, inserted: 1, skipped: 7, unverified: 0, revised: 1, rejected: 0, error: null }), shape(s3, "USD"));
  ok("EUR unchanged: 8 skipped", pairOf(s3, "EUR")?.skipped === 8, shape(s3, "EUR"));
  ok("17 rows; both versions of USD 2026-10-21 kept, newest = 3.093", count() === 17 &&
    su(`SELECT string_agg("rate"::text || '@' || "fetchedAt"::text, ',' ORDER BY "fetchedAt") FROM "FxRate" WHERE "base" = 'USD' AND "rateDate" = '2026-10-21'`) === "3.0910000000@2026-10-22 13:30:00,3.0930000000@2026-10-22 16:00:00");
  ok("REVISED event logged", logs.some((l) => l.tag === "alert" && l.data.event === "FX_RATE_REVISED" && l.data.rateDate === "2026-10-21"), logs);

  console.log("L4 — day 2: a >5% jump is stored UNVERIFIED and alerted");
  scenario = { USD: "usd-day2-jump.csv", EUR: "eur-day2.csv" };
  logs.length = 0;
  hits.length = 0;
  const s4 = await run("2026-10-23T13:30:00.000Z");
  ok("window moved to 2026-10-14..2026-10-23", hits.every((h) => /startperiod=2026-10-14&endperiod=2026-10-23/.test(h)), hits);
  ok("USD: 1 inserted UNVERIFIED, 7 skipped", JSON.stringify(shape(s4, "USD")) === JSON.stringify({ fetched: 8, inserted: 1, skipped: 7, unverified: 1, revised: 0, rejected: 0, error: null }), shape(s4, "USD"));
  ok("EUR: 1 inserted VERIFIED, 7 skipped", JSON.stringify(shape(s4, "EUR")) === JSON.stringify({ fetched: 8, inserted: 1, skipped: 7, unverified: 0, revised: 0, rejected: 0, error: null }), shape(s4, "EUR"));
  ok("stored: USD 2026-10-23 3.4000000000 UNVERIFIED", su(`SELECT "rate"::text || ' ' || "verification" FROM "FxRate" WHERE "base" = 'USD' AND "rateDate" = '2026-10-23'`) === "3.4000000000 UNVERIFIED");
  const jump = logs.find((l) => l.tag === "alert" && l.data.event === "FX_RATE_JUMP");
  ok("FX_RATE_JUMP alert at error level: vs 2026-10-22 3.107, 943 bp", !!jump && jump.level === "error" && jump.data.previousDate === "2026-10-22" && jump.data.changeBp === 943, jump);
  ok("19 rows", count() === 19, count());

  console.log("L5..L7 — malformed / non-200 / redirect / wrong type / timeout → nothing written");
  const before = count();
  const failing: [string, { USD: Serve; EUR: Serve }, string, string][] = [
    ["malformed CSV (one OF01 row) + HTTP 500", { USD: "usd-bad-datatype.csv", EUR: "500" }, "PARSE_REJECTED", "HTTP_STATUS"],
    ["unknown column + HTML error page with 200", { USD: "usd-bad-extra-column.csv", EUR: "html200" }, "PARSE_REJECTED", "CONTENT_TYPE"],
    ["redirect to another host + a future-dated row", { USD: "redirect", EUR: { file: "eur-day2.csv", replace: ["2026-10-23,3.4850", "2026-10-24,3.4850"] } }, "REDIRECT", "PARSE_REJECTED"],
    ["timeout (server never finishes)", { USD: "hang", EUR: "hang" }, "TIMEOUT", "TIMEOUT"],
  ];
  for (const [label, sc, usdErr, eurErr] of failing) {
    scenario = sc;
    hits.length = 0;
    const t0 = Date.now();
    const s = await run("2026-10-23T15:00:00.000Z");
    ok(`${label}: run NOT ok, USD ${usdErr}, EUR ${eurErr}`, "pairs" in s && !s.ok && pairOf(s, "USD")?.error === usdErr && pairOf(s, "EUR")?.error === eurErr, s);
    ok(`${label}: nothing written (${before} rows), one request per series (no retry)`, count() === before && hits.length === 2, { n: count(), hits });
    if (usdErr === "TIMEOUT") ok("timeout bounded (< 6 s for both)", Date.now() - t0 < 6000, Date.now() - t0);
  }
  server.closeAllConnections();

  console.log("L8 — writer not configured: refused before any request");
  scenario = { USD: "usd-day2-jump.csv", EUR: "eur-day2.csv" };
  hits.length = 0;
  const noWriter = await run("2026-10-23T15:30:00.000Z", { env: { ...process.env, FX_RATE_WRITER_DATABASE_URL: "" } });
  ok("WRITER_NOT_CONFIGURED, zero requests, nothing written", !("pairs" in noWriter) && noWriter.error === "WRITER_NOT_CONFIGURED" && hits.length === 0 && count() === before, { noWriter, hits });
  const shared = await run("2026-10-23T15:30:00.000Z", { env: { ...process.env, FX_RATE_WRITER_DATABASE_URL: process.env.DATABASE_URL } });
  ok("writer URL = runtime URL → refused, zero requests", !("pairs" in shared) && shared.error === "WRITER_SHARES_ANOTHER_CONNECTION" && hits.length === 0, shared);

  console.log("L9 — two overlapping runs serialise (advisory lock): the revision is appended once");
  scenario = { USD: "usd-day2-jump.csv", EUR: { file: "eur-day2.csv", replace: ["2026-10-23,3.4850", "2026-10-23,3.4860"] } };
  const [ra, rb] = await Promise.all([run("2026-10-23T16:00:00.000Z"), run("2026-10-23T16:00:00.001Z")]);
  const eurInserted = (pairOf(ra, "EUR")?.inserted ?? -1) + (pairOf(rb, "EUR")?.inserted ?? -1);
  ok("exactly one of the two runs appended the EUR revision", eurInserted === 1 && count() === before + 1, { a: shape(ra, "EUR"), b: shape(rb, "EUR"), n: count() });

  console.log("L10 — roles: runtime reads only; writer appends only; nobody changes a row");
  const n10 = count();
  const ins = `INSERT INTO "FxRate" ("base", "quote", "rate", "kind", "source", "rateDate", "fetchedAt", "verification") VALUES ('USD', 'ILS', 3.2, 'REPRESENTATIVE', 'BANK_OF_ISRAEL', DATE '2026-10-22', TIMESTAMP '2026-10-22 20:00:00', 'VERIFIED')`;
  const refused = (label: string, r: { ok: boolean; err: string }, pattern: RegExp) => ok(`refused: ${label}`, !r.ok && pattern.test(r.err), r.err);
  ok("runtime reads the rates", Number(psql("app_runtime_prod", `SELECT count(*) FROM "FxRate"`).out) === n10);
  refused("runtime appends", psql("app_runtime_prod", ins), /permission denied/);
  refused("runtime changes", psql("app_runtime_prod", `UPDATE "FxRate" SET "rate" = 1`), /permission denied/);
  refused("runtime removes", psql("app_runtime_prod", `DELETE FROM "FxRate"`), /permission denied/);
  refused("writer reads", psql("fx_rate_writer_lab", `SELECT count(*) FROM "FxRate"`), /permission denied/);
  refused("writer changes", psql("fx_rate_writer_lab", `UPDATE "FxRate" SET "rate" = 1`), /permission denied/);
  refused("writer removes", psql("fx_rate_writer_lab", `DELETE FROM "FxRate"`), /permission denied/);
  refused("writer empties", psql("fx_rate_writer_lab", `TRUNCATE "FxRate"`), /permission denied/);
  refused("writer appends WITH RETURNING (needs SELECT)", psql("fx_rate_writer_lab", `${ins} RETURNING "id"`), /permission denied/);
  refused("writer reads a tenant table", psql("fx_rate_writer_lab", `SELECT count(*) FROM "Business"`), /permission denied/);
  refused("superuser changes a rate (append-only trigger)", psql(SUPER, `UPDATE "FxRate" SET "rate" = 1`, process.env.PGPASSWORD ?? ""), /FX_RATE_APPEND_ONLY/);
  refused("superuser removes a rate (append-only trigger)", psql(SUPER, `DELETE FROM "FxRate"`, process.env.PGPASSWORD ?? ""), /FX_RATE_APPEND_ONLY/);
  ok("row count unchanged by every refused attempt", count() === n10, count());

  console.log("L11 — status (runtime role, SELECT only)");
  const st = await getFxRateStatus(new Date("2026-10-23T17:00:00.000Z"));
  const usd = st.pairs.find((p) => p.pair === "USD/ILS")!;
  const eur = st.pairs.find((p) => p.pair === "EUR/ILS")!;
  ok("USD: latest 2026-10-23 is UNVERIFIED, latest verified 2026-10-22, fresh", usd.latestRateDate === "2026-10-23" && usd.latestIsUnverified && usd.latestVerifiedRateDate === "2026-10-22" && !usd.stale, usd);
  ok("EUR: latest verified 2026-10-23, fresh", eur.latestVerifiedRateDate === "2026-10-23" && !eur.latestIsUnverified && !eur.stale, eur);
  const later = await getFxRateStatus(new Date("2026-10-28T09:00:00.000Z"));
  ok("five days later (3 business days after Fri 2026-10-23) both pairs are STALE", later.anyStale && later.pairs.every((p) => p.stale), later);

  console.log("L12 — the route refuses without the secret / without the enable flag (no request, no row)");
  const route = await import("../app/api/cron/fx-rates/route");
  const { NextRequest } = await import("next/server");
  const call = async (auth?: string) => (await route.GET(new NextRequest("https://lab.test/x", { headers: auth ? { authorization: auth } : {} }))).status;
  const n12 = count();
  hits.length = 0;
  const saved = { secret: process.env.CRON_SECRET, flag: process.env.FX_RATES_FETCH_ENABLED };
  const secret = "fx_boi_lab_synthetic_cron_secret_0123456789";
  delete process.env.CRON_SECRET;
  ok("no CRON_SECRET configured → 503", (await call(`Bearer ${secret}`)) === 503);
  process.env.CRON_SECRET = secret;
  process.env.FX_RATES_FETCH_ENABLED = "true";
  ok("missing bearer → 401 (flag on)", (await call()) === 401);
  ok("wrong bearer → 401 (flag on)", (await call("Bearer not-the-secret-not-the-secret-0000")) === 401);
  delete process.env.FX_RATES_FETCH_ENABLED;
  ok("right bearer, flag unset → 404", (await call(`Bearer ${secret}`)) === 404);
  process.env.FX_RATES_FETCH_ENABLED = "false";
  ok("right bearer, flag 'false' → 404", (await call(`Bearer ${secret}`)) === 404);
  ok("…no request reached any server, no row written", hits.length === 0 && count() === n12, { hits, n: count() });
  if (saved.secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.secret;
  if (saved.flag === undefined) delete process.env.FX_RATES_FETCH_ENABLED; else process.env.FX_RATES_FETCH_ENABLED = saved.flag;

  console.log(`\nfinal: ${count()} rows — ${su(`SELECT string_agg("base" || ' ' || "rateDate"::text || ' ' || "rate"::text || ' ' || "verification", '; ' ORDER BY "base", "rateDate", "fetchedAt") FROM "FxRate"`)}`);
  await prisma.$disconnect();
  await getPrismaFxWriter()?.$disconnect();
  server.close();
  console.log(`\nFX-BOI LAB: ${pass} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
