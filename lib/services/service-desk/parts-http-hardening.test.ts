/**
 * Service Desk #1116 hardening — the HTTP edge of the parts + external-work routes. Pure (no database, no network):
 *   npx tsx lib/services/service-desk/parts-http-hardening.test.ts
 *
 * What this proves (owner request 2026-11-16, before #1116 may merge):
 *   H1 every handler of the five routes runs inside serviceDeskRoute (session user of a business, flag gate, tenant
 *      context), calls its assert…Open() first, then the abuse limit, and only then reads the request;
 *   H2 the business and the actor come from the session only: no handler reads businessId / userId / actor from the
 *      body, and every service call receives `principal` (writes) or `principal.businessId` (reads);
 *   H3 every body is read with the byte cap; a larger body is refused (413 PAYLOAD_TOO_LARGE) before parsing, a chunked
 *      body without Content-Length too; a body within the cap parses as before;
 *   H4 the two limiter buckets: writes fail CLOSED, reads fail OPEN, both keyed by user AND business; the write limit
 *      trips at its per-user threshold with a 429 and is isolated per user and per business;
 *   H5 the services never take the business from their input.
 */
import fs from "node:fs";
import path from "node:path";

import { BUCKETS } from "@/lib/security/rate-limiter/buckets";

import { jsonBody, SERVICE_DESK_JSON_BODY_MAX_BYTES, serviceDeskRateLimit } from "./service-desk-http";
import { ServiceDeskError } from "./service-desk-errors";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { failures.push(name); console.log(`  [FAIL] ${name}${extra ? " — " + extra : ""}`); }
}

const ROOT = process.cwd();
const ROUTES = [
  "app/api/service-desk/cases/[id]/parts/route.ts",
  "app/api/service-desk/parts/[partId]/actions/route.ts",
  "app/api/service-desk/cases/[id]/external-work/route.ts",
  "app/api/service-desk/external-work/[workId]/actions/route.ts",
  "app/api/service-desk/external-work/[workId]/return/route.ts",
];

/** The body of each exported handler: from `export async function X(` to the next export (or EOF). */
function handlers(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export async function (GET|POST|PUT|PATCH|DELETE)\(/g;
  const marks = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
  marks.forEach((m, i) => out.push({ name: m.name, body: src.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : src.length) }));
  return out;
}

console.log("— H1/H2/H3 the five routes");
let handlerCount = 0;
for (const rel of ROUTES) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const h of handlers(src)) {
    handlerCount++;
    const tag = `${rel} ${h.name}`;
    const kind = h.name === "GET" ? "read" : "write";
    check(`${tag}: inside serviceDeskRoute(req, "${kind}")`, h.body.includes(`serviceDeskRoute(req, "${kind}"`));
    const lines = h.body.split("\n").map((l) => l.trim()).filter(Boolean);
    const first = lines.findIndex((l) => l.startsWith("return serviceDeskRoute("));
    check(`${tag}: assert…Open() is the first statement`, /^assert\w+Open\(\);$/.test(lines[first + 1] ?? ""));
    const bucket = kind === "read" ? "SERVICE_DESK_PARTS_READ" : "SERVICE_DESK_PARTS_WRITE";
    const limitAt = h.body.indexOf(`serviceDeskRateLimit("${bucket}", principal)`);
    check(`${tag}: rate-limited (${bucket}, keyed by the session principal)`, limitAt > 0 && h.body.includes("if (limited) return limited;"));
    const firstRead = Math.min(...["idempotencyKeyOf(", "jsonBody(", "context.params"].map((s) => (h.body.indexOf(s) < 0 ? Infinity : h.body.indexOf(s))));
    check(`${tag}: the limit runs before the request is read`, limitAt > 0 && limitAt < firstRead);
    if (kind === "write") {
      check(`${tag}: the body is read with the byte cap`, h.body.includes("jsonBody(req, SERVICE_DESK_JSON_BODY_MAX_BYTES)") && !/jsonBody\(req\)/.test(h.body));
    }
    check(`${tag}: no business / user / actor from the request`, !/\bb\.(businessId|userId|actor|principal|owner)\b/.test(h.body) && !/headers\.get\("x-business/i.test(h.body));
    const call = h.body.match(/await (\w+)\((principal(?:\.businessId)?)\s*,/);
    check(`${tag}: the service receives ${kind === "read" ? "principal.businessId" : "principal"} from the session`,
      call !== null && call[2] === (kind === "read" ? "principal.businessId" : "principal"), call ? call[0] : "no service call found");
  }
}
check("seven handlers in the five routes (2 GET + 5 POST)", handlerCount === 7, String(handlerCount));

console.log("— H5 the services never take the business from their input");
for (const rel of ["lib/services/service-desk/parts.service.ts", "lib/services/service-desk/external-work.service.ts"]) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  check(`${rel}: no input.businessId / input.userId`, !/\binput\??\.(businessId|userId)\b/.test(src));
  check(`${rel}: writes run in the tenant transaction`, /tenantTx|runWithTenantContext/.test(src));
}

async function main(): Promise<void> {
  console.log("— H3 the byte cap");
  const big = JSON.stringify({ name: "x".repeat(SERVICE_DESK_JSON_BODY_MAX_BYTES) });
  const refusedWith = async (req: Request): Promise<string | null> => {
    try { await jsonBody(req, SERVICE_DESK_JSON_BODY_MAX_BYTES); return null; } catch (e) { return e instanceof ServiceDeskError ? `${e.code}:${e.status}` : "other"; }
  };
  check("cap is 16 KiB", SERVICE_DESK_JSON_BODY_MAX_BYTES === 16 * 1024);
  check("an oversized body (Content-Length) → PAYLOAD_TOO_LARGE 413",
    (await refusedWith(new Request("http://x/", { method: "POST", body: big, headers: { "content-type": "application/json" } }))) === "PAYLOAD_TOO_LARGE:413");
  const chunked = new ReadableStream<Uint8Array>({
    start(c) { const enc = new TextEncoder(); for (let i = 0; i < 40; i++) c.enqueue(enc.encode("x".repeat(1024))); c.close(); },
  });
  check("an oversized chunked body (no Content-Length) → PAYLOAD_TOO_LARGE 413",
    (await refusedWith(new Request("http://x/", { method: "POST", body: chunked, duplex: "half" } as RequestInit))) === "PAYLOAD_TOO_LARGE:413");
  check("a lying Content-Length header → PAYLOAD_TOO_LARGE 413",
    (await refusedWith(new Request("http://x/", { method: "POST", body: "{}", headers: { "content-length": "999999" } }))) === "PAYLOAD_TOO_LARGE:413");
  const okBody = await jsonBody(new Request("http://x/", { method: "POST", body: JSON.stringify({ quantity: 2, name: "בורג" }) }), SERVICE_DESK_JSON_BODY_MAX_BYTES);
  check("a body within the cap parses as before (Hebrew text intact)", okBody.quantity === 2 && okBody.name === "בורג");
  check("an array body is still INVALID_INPUT", (await refusedWith(new Request("http://x/", { method: "POST", body: "[1]" }))) === "INVALID_INPUT:400");
  check("an empty body is still INVALID_INPUT", (await refusedWith(new Request("http://x/", { method: "POST", body: "" }))) === "INVALID_INPUT:400");
  check("no cap given → unchanged behaviour for the other routes", (await jsonBody(new Request("http://x/", { method: "POST", body: big }))).name !== undefined);

  console.log("— H4 the limiter buckets");
  const w = BUCKETS.SERVICE_DESK_PARTS_WRITE;
  const r = BUCKETS.SERVICE_DESK_PARTS_READ;
  check("writes fail CLOSED", w.failMode === "closed");
  check("reads fail OPEN", r.failMode === "open");
  check("both keyed by user AND business", [w, r].every((b) => b.rules.some((x) => x.scope === "user") && b.rules.some((x) => x.scope === "business")));
  const perUserMinute = w.rules.find((x) => x.scope === "user" && x.windowSeconds === 60)?.limit ?? 0;
  const base = 9_000_000 + Math.floor(Math.random() * 1_000_000);
  const a = { businessId: base, userId: base };
  let trippedAt = 0;
  for (let i = 1; i <= perUserMinute + 1; i++) {
    const res = await serviceDeskRateLimit("SERVICE_DESK_PARTS_WRITE", a);
    if (res) { trippedAt = i; check("the limit answers 429 with Retry-After", res.status === 429 && res.headers.get("retry-after") !== null); break; }
  }
  check(`the write limit trips exactly after ${perUserMinute} calls`, trippedAt === perUserMinute + 1, String(trippedAt));
  check("another business's user is not affected", (await serviceDeskRateLimit("SERVICE_DESK_PARTS_WRITE", { businessId: base + 1, userId: base + 1 })) === null);
  check("reads have their own bucket (not consumed by writes)", (await serviceDeskRateLimit("SERVICE_DESK_PARTS_READ", a)) === null);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
