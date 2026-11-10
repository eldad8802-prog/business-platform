/**
 * Run: npx tsx lib/services/service-desk/service-desk-gate.test.ts   (from the repo root)
 *
 * Service Desk 1.3a — access, pure (no database, no network):
 *   G. decideServiceDeskMode over every flag state and every combination (owner decision 1, 2026-11-09):
 *      BUSINESS_DISABLED + cases → READ_ONLY; without cases → NONE; GLOBAL_DEFAULT → NONE even with cases;
 *      EMERGENCY → NONE always; a global block or the emergency switch always wins over read-only.
 *   E. the HTTP edge: 401 before anything; NONE → 404 for reads and writes; READ_ONLY → reads pass, every write 403
 *      READ_ONLY before the handler runs; FULL → both; the handler gets the session's business, never the request's.
 *   R. every /api/service-desk route goes through the edge; GET routes are reads, every other method is a write;
 *      the real routes answer 401 with no session and touch no database.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { FeatureAccessReasonCode } from "@/lib/services/feature-access/feature-access.types";
import { decideServiceDeskMode, readOnlyCandidate, type ServiceDeskAccessFacts } from "@/lib/services/service-desk/service-desk-gate";
import { serviceDeskRoute } from "@/lib/services/service-desk/service-desk-http";

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`OK: ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

const facts = (reasonCode: FeatureAccessReasonCode, o: Partial<ServiceDeskAccessFacts> = {}): ServiceDeskAccessFacts => ({
  allowed: reasonCode === "BUSINESS_ENABLED" || (reasonCode === "CATALOG_DEFAULT" && o.allowed !== false),
  reasonCode,
  globalEnabled: o.globalEnabled ?? (reasonCode !== "GLOBAL_DEFAULT"),
  emergencyDisabled: o.emergencyDisabled ?? (reasonCode === "EMERGENCY_DISABLED"),
  ...o,
});

async function main() {
  // G — the decision
  ok("G1 BUSINESS_DISABLED (global ON, no emergency) + cases → READ_ONLY", decideServiceDeskMode(facts("BUSINESS_DISABLED"), true) === "READ_ONLY");
  ok("G2 BUSINESS_DISABLED without cases → NONE", decideServiceDeskMode(facts("BUSINESS_DISABLED"), false) === "NONE");
  ok("G3 GLOBAL_DEFAULT (not launched / switched off globally) → NONE even with cases", decideServiceDeskMode(facts("GLOBAL_DEFAULT"), true) === "NONE" && decideServiceDeskMode(facts("GLOBAL_DEFAULT"), false) === "NONE");
  ok("G4 EMERGENCY_DISABLED → NONE, with or without cases", decideServiceDeskMode(facts("EMERGENCY_DISABLED"), true) === "NONE" && decideServiceDeskMode(facts("EMERGENCY_DISABLED"), false) === "NONE");
  ok("G5 BUSINESS_DISABLED while the module is globally OFF (pre-launch) + cases → NONE (a global block wins)",
    decideServiceDeskMode(facts("BUSINESS_DISABLED", { globalEnabled: false }), true) === "NONE");
  ok("G6 BUSINESS_DISABLED with the emergency switch also set + cases → NONE (the emergency wins)",
    decideServiceDeskMode(facts("BUSINESS_DISABLED", { emergencyDisabled: true }), true) === "NONE");
  ok("G7 allowed (BUSINESS_ENABLED) → FULL", decideServiceDeskMode(facts("BUSINESS_ENABLED"), false) === "FULL");
  ok("G8 allowed (CATALOG_DEFAULT, launched) → FULL", decideServiceDeskMode(facts("CATALOG_DEFAULT"), false) === "FULL");
  ok("G9 allowed but the emergency switch set (inconsistent input) → NONE, fail closed",
    decideServiceDeskMode({ allowed: true, reasonCode: "BUSINESS_ENABLED", globalEnabled: true, emergencyDisabled: true }, true) === "NONE");
  ok("G10 CATALOG_DEFAULT not allowed (catalog default OFF) → NONE even with cases",
    decideServiceDeskMode({ allowed: false, reasonCode: "CATALOG_DEFAULT", globalEnabled: true, emergencyDisabled: false }, true) === "NONE");
  ok("G11 non-boolean facts never open anything (allowed: 'true', hasCases: 1)",
    decideServiceDeskMode({ allowed: "true" as unknown as boolean, reasonCode: "GLOBAL_DEFAULT", globalEnabled: false, emergencyDisabled: false }, true) === "NONE"
    && decideServiceDeskMode(facts("BUSINESS_DISABLED"), 1 as unknown as boolean) === "NONE");
  ok("G12 the cases are counted only where read-only is reachable",
    readOnlyCandidate(facts("BUSINESS_DISABLED")) && !readOnlyCandidate(facts("GLOBAL_DEFAULT")) && !readOnlyCandidate(facts("EMERGENCY_DISABLED"))
    && !readOnlyCandidate(facts("BUSINESS_DISABLED", { globalEnabled: false })) && !readOnlyCandidate(facts("BUSINESS_DISABLED", { emergencyDisabled: true })) && !readOnlyCandidate(facts("BUSINESS_ENABLED")));

  // E — the edge
  const req = (method = "GET") => new Request("https://lab.test/api/service-desk/x", { method });
  const user = (businessId: number | null) => async () => (businessId === null ? null : { id: 77, businessId });
  let ran = 0;
  let seen: unknown = null;
  const handler = async (ctx: { principal: unknown; mode: string }) => { ran++; seen = ctx; return new Response("ok"); };
  const call = async (kind: "read" | "write", mode: "FULL" | "READ_ONLY" | "NONE", b: number | null = 9) => {
    ran = 0;
    const r = await serviceDeskRoute(req(kind === "read" ? "GET" : "POST"), kind, handler, { user: user(b), mode: async () => mode });
    return { status: r.status, body: r.status === 200 ? await r.text() : await r.json(), ran };
  };
  const u = await call("read", "FULL", null);
  ok("E1 no session → 401, the handler never runs", u.status === 401 && u.ran === 0);
  for (const kind of ["read", "write"] as const) {
    const n = await call(kind, "NONE");
    ok(`E2 NONE → 404 for a ${kind}, nothing else said, handler never runs`, n.status === 404 && n.ran === 0 && JSON.stringify(n.body) === '{"error":"Not found"}');
  }
  const ror = await call("read", "READ_ONLY");
  ok("E3 READ_ONLY → a read runs", ror.status === 200 && ror.ran === 1);
  const row = await call("write", "READ_ONLY");
  ok("E4 READ_ONLY → a write is 403 READ_ONLY before the handler runs", row.status === 403 && row.ran === 0 && (row.body as { error: string }).error === "READ_ONLY");
  const fr = await call("read", "FULL"), fw = await call("write", "FULL");
  ok("E5 FULL → reads and writes run", fr.status === 200 && fw.status === 200 && fr.ran === 1 && fw.ran === 1);
  await call("write", "FULL", 9);
  ok("E6 the handler gets the session's business and user", JSON.stringify((seen as { principal: unknown }).principal) === JSON.stringify({ businessId: 9, userId: 77 }));
  const boom = await serviceDeskRoute(req(), "read", async () => { throw new Error("secret db detail biz 42"); }, { user: user(9), mode: async () => "FULL" });
  const boomBody = await boom.json();
  ok("E7 an unexpected error → 500 INTERNAL with no detail", boom.status === 500 && JSON.stringify(boomBody) === '{"error":"INTERNAL"}');
  const modeThrows = await serviceDeskRoute(req(), "read", handler, { user: user(9), mode: async () => { throw new Error("db down"); } });
  ok("E8 a mode that cannot be resolved never opens anything (500, handler not run)", modeThrows.status === 500);

  // R — the routes
  const root = path.join(process.cwd(), "app/api/service-desk");
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "route.ts") files.push(p); } };
  walk(root);
  // UI 1.3a added one read: GET /api/service-desk/staff (the technician pickers); 1d-A added three external-work routes,
  // closed until 1.3b. All under the same edge as the rest.
  ok("R1 fourteen route files (incl. the staff read and the three external-work routes)", files.length === 14 && files.some((f) => f.split(path.sep).join("/").endsWith("staff/route.ts")), String(files.length));
  let allGuarded = true, kindsRight = true;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(([\s\S]*?)\n}\n/g)) {
      const body = m[2];
      if (!/serviceDeskRoute\(req, "(read|write)"/.test(body)) allGuarded = false;
      const kind = /serviceDeskRoute\(req, "(read|write)"/.exec(body)?.[1];
      if ((m[1] === "GET") !== (kind === "read")) kindsRight = false;
    }
    if (/getCurrentUser|resolveFeatureAccess|businessId\s*[:=]\s*(b|body|q)\./.test(src)) allGuarded = false;
  }
  ok("R2 every handler goes through serviceDeskRoute; no route reads the user, the flag or a business id itself", allGuarded);
  ok("R3 GET handlers are reads, every other method is a write", kindsRight);
  // P4 PR-2: the three writes are reopened as JOURNALED records (and QA joins them): each takes an Idempotency-Key and
  // calls its journaled service function; without the P4 journal the service itself answers NOT_AVAILABLE_UNTIL_AUDIT.
  const records: [string, RegExp][] = [
    ["cases/[id]/technician/route.ts", /assignTechnician\(principal, id, \{ staffMemberId: b\.staffMemberId, expectedVersion: b\.expectedVersion \}, \{ idempotencyKey: key \}\)/],
    ["cases/[id]/intake/route.ts", /recordIntake\(principal, id, \{[\s\S]*expectedVersion: b\.expectedVersion,?\s*\}, \{ idempotencyKey: key \}\)/],
    ["cases/[id]/qa/route.ts", /recordQa\(principal, id, \{ results: b\.results, expectedVersion: b\.expectedVersion \}, \{ idempotencyKey: key \}\)/],
    ["settings/route.ts", /updateSettings\(principal, \{[\s\S]*\}, \{ idempotencyKey: key \}\)/],
  ];
  ok("R5 PUT technician / intake / qa / settings: writes through the edge, an Idempotency-Key required, the journaled service called",
    records.every(([r, call]) => {
      const put = /export async function PUT\([\s\S]*?\n}\n/.exec(fs.readFileSync(path.join(root, r), "utf8"))?.[0] ?? "";
      return /serviceDeskRoute\(req, "write"/.test(put) && /const key = idempotencyKeyOf\(req\);/.test(put) && call.test(put);
    }));
  const saved = { db: process.env.DATABASE_URL, direct: process.env.DIRECT_URL };
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_URL;
  let all401 = true;
  for (const f of files) {
    const mod = await import(pathToFileURL(f).href);
    for (const method of ["GET", "POST", "PUT"] as const) {
      if (typeof mod[method] !== "function") continue;
      const r: Response = await mod[method](new Request("https://lab.test/api/service-desk/cases/1", { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }), { params: Promise.resolve({ id: "1" }) });
      if (r.status !== 401) all401 = false;
    }
  }
  if (saved.db !== undefined) process.env.DATABASE_URL = saved.db;
  if (saved.direct !== undefined) process.env.DIRECT_URL = saved.direct;
  ok("R4 the real routes answer 401 with no session (no database reached)", all401);

  console.log(`\nservice-desk-gate: ${pass} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
