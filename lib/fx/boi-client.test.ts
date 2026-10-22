/**
 * Verify — Bank of Israel HTTP client (lib/fx/boi-client.ts) against a LOOPBACK server: no external network.
 * Run: npx tsx lib/fx/boi-client.test.ts
 *
 * Timeout, no retry, redirects never followed, size cap (declared and streamed), Content-Type, UTF-8, and the
 * origin allowlist (BoI or loopback only).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { BOI_ORIGIN, boiSeriesUrl, fetchBoiSeries, isAllowedOrigin } from "@/lib/fx/boi-client";

let checks = 0;
const ok = (label: string, cond: boolean, detail?: unknown) => {
  assert.ok(cond, `${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  checks += 1;
  console.log(`  ok ${label}`);
};

const csv = fs.readFileSync(path.join(process.cwd(), ".fxboi/fixtures/usd-day1.csv"));
let mode = "ok";
const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(`${mode} ${req.url}`);
  switch (mode) {
    case "ok":
      res.writeHead(200, { "content-type": "text/csv;charset=UTF-8" });
      return res.end(csv);
    case "redirect":
      res.writeHead(302, { location: "https://attacker.example/rates.csv" });
      return res.end();
    case "notfound":
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      return res.end("<!DOCTYPE html><html>שגיאה</html>");
    case "html200":
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html></html>");
    case "big-declared":
      res.writeHead(200, { "content-type": "text/csv", "content-length": String(300 * 1024) });
      return res.end(Buffer.alloc(300 * 1024, 0x41));
    case "big-chunked":
      res.writeHead(200, { "content-type": "text/csv" }); // no content-length: streamed
      for (let i = 0; i < 40; i++) res.write(Buffer.alloc(8 * 1024, 0x41));
      return res.end();
    case "latin1":
      res.writeHead(200, { "content-type": "text/csv" });
      return res.end(Buffer.from([0x41, 0xff, 0xfe, 0x42]));
    case "hang":
      res.writeHead(200, { "content-type": "text/csv" });
      res.write("SERIES_CODE");
      return; // never ends
    case "500":
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("boom");
  }
});

async function main() {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (m: string, extra: { timeoutMs?: number } = {}) => {
    mode = m;
    hits.length = 0;
    return fetchBoiSeries("USD", "2026-10-13", "2026-10-22", { origin, ...extra });
  };

  console.log("1. URL and origin");
  ok("the documented endpoint and query", boiSeriesUrl("EUR", "2026-10-13", "2026-10-22") === `${BOI_ORIGIN}/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/EXR/1.0/RER_EUR_ILS?startperiod=2026-10-13&endperiod=2026-10-22&format=csv`);
  ok("BoI origin allowed", isAllowedOrigin("https://edge.boi.org.il"));
  ok("loopback allowed (lab)", isAllowedOrigin("http://127.0.0.1:8080") && isAllowedOrigin("http://localhost:1"));
  ok("another host refused", !isAllowedOrigin("https://edge.boi.org.il.attacker.example") && !isAllowedOrigin("https://example.com"));
  ok("credentials / path in the origin refused", !isAllowedOrigin("http://u:p@127.0.0.1:1") && !isAllowedOrigin("http://127.0.0.1:1/x"));
  mode = "ok";
  hits.length = 0;
  const refused = await fetchBoiSeries("USD", "2026-10-13", "2026-10-22", { origin: "https://example.com" });
  ok("a refused origin makes NO request", !refused.ok && refused.failure === "ORIGIN_NOT_ALLOWED" && hits.length === 0, refused);

  console.log("2. success");
  const good = await get("ok");
  ok("200 text/csv → the body", good.ok && good.text === csv.toString("utf8") && good.bytes === csv.byteLength);
  ok("…one request, the right series and window", hits.length === 1 && /RER_USD_ILS\?startperiod=2026-10-13&endperiod=2026-10-22&format=csv$/.test(hits[0]), hits);

  console.log("3. failures — typed, one request each (no retry)");
  const cases: [string, string, { timeoutMs?: number }?][] = [
    ["redirect", "REDIRECT"],
    ["notfound", "HTTP_STATUS"],
    ["500", "HTTP_STATUS"],
    ["html200", "CONTENT_TYPE"],
    ["big-declared", "TOO_LARGE"],
    ["big-chunked", "TOO_LARGE"],
    ["latin1", "NOT_UTF8"],
    ["hang", "TIMEOUT", { timeoutMs: 800 }],
  ];
  for (const [m, want, extra] of cases) {
    const t0 = Date.now();
    const r = await get(m, extra);
    ok(`${m} → ${want}, exactly one request`, !r.ok && r.failure === want && hits.length === 1, { r, hits });
    if (m === "hang") ok("the timeout fires on time (< 5 s)", Date.now() - t0 < 5000, Date.now() - t0);
    if (m === "redirect") ok("the redirect target was never contacted", hits.every((h) => h.startsWith("redirect /FusionEdgeServer")), hits);
  }
  ok("404 keeps its status for the report", ((await get("notfound")) as { status?: number }).status === 404);

  server.closeAllConnections();
  server.close();
  console.log(`boi-client: ${checks} checks passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
