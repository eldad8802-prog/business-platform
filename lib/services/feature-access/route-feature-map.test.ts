/**
 * Run: npx tsx lib/services/feature-access/route-feature-map.test.ts   (from the repo root)
 *
 * Every API route of the eleven core features is guarded on the server, or exempt for a written reason.
 * Static (reads the route files; no database, no network):
 *   R1 every route.ts under ROUTE_FEATURE_SCOPE is in ROUTE_FEATURE_MAP — a new route is a reviewed decision;
 *   R2 every map entry points at a route that exists, and no route is listed twice;
 *   R3 a guarded route: EVERY exported handler calls guardFeature(<its request>, PLATFORM_FEATURE_KEYS.<the key>) as
 *      its FIRST statement — before any work — except the methods listed in `ungated`, which must exist and must not
 *      call the guard (an ungated method that guards anyway is a mistake in one direction or the other);
 *   R4 an exempt route does not call the guard (the map and the code say the same thing);
 *   R5 data-rights-floor covers reads only (GET handlers or export routes), legal-correction only billing writes;
 *   R6 every one of the eleven features guards at least one route;
 *   R7 no file outside the scope calls guardFeature (the map is the whole story);
 *   R8 the background steps reached by webhooks ask the same guard;
 *   R9 PENDING_SEPARATE_BILLING_REVIEW: only billing-protected folders (billing/, collection/, payments/, the uniform
 *      export), each a guarded map entry, and each file does NOT call the guard yet — its guard ships in the separate
 *      billing Draft PR, which empties the list and so turns R3 back on for it.
 */
import fs from "node:fs";
import path from "node:path";

import { GUARDED_FEATURE_KEYS } from "@/lib/services/feature-access/feature-guard";
import { PLATFORM_FEATURE_KEYS } from "@/lib/services/feature-access/platform-feature-catalog";
import {
  PENDING_SEPARATE_BILLING_REVIEW,
  ROUTE_FEATURE_MAP,
  ROUTE_FEATURE_SCOPE,
  type HttpMethod,
} from "@/lib/services/feature-access/route-feature-map";

const ROOT = process.cwd();
const API = path.join(ROOT, "app", "api");

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push(p);
  }
  return out;
}

const toRoute = (file: string) => path.relative(API, path.dirname(file)).split(path.sep).join("/");

/** Is `route` under one of the scope folders? (a folder matches itself and everything below it, by segment.) */
const inScope = (route: string) => ROUTE_FEATURE_SCOPE.some((s) => route === s || route.startsWith(s + "/"));

const KEY_CONST: Record<string, string> = Object.fromEntries(Object.entries(PLATFORM_FEATURE_KEYS).map(([c, v]) => [v, c]));

type Handler = { method: HttpMethod; param: string | null; body: string };

/** The exported handlers of a route file, each with its request parameter name and its body text. */
function handlersOf(src: string): Handler[] {
  const out: Handler[] = [];
  const re = /^export async function (GET|POST|PUT|PATCH|DELETE)\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    const params = src.slice(m.index + m[0].length, i - 1);
    const param = params.match(/^\s*([A-Za-z_$][\w$]*)/)?.[1] ?? null;
    const open = src.indexOf("{", i);
    let d = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === "{") d++;
      else if (src[j] === "}") {
        d--;
        if (d === 0) break;
      }
    }
    out.push({ method: m[1] as HttpMethod, param, body: src.slice(open + 1, j) });
  }
  return out;
}

const scopeFiles = ROUTE_FEATURE_SCOPE.flatMap((s) => walk(path.join(API, ...s.split("/"))));
const scopeRoutes = [...new Set(scopeFiles.map(toRoute))].filter(inScope).sort();
const mapRoutes = ROUTE_FEATURE_MAP.map((e) => e.route);

// R1
const unmapped = scopeRoutes.filter((r) => !mapRoutes.includes(r));
ok("R1 every route in scope is mapped", unmapped.length === 0, unmapped.join(", "));

// R2
const missing = mapRoutes.filter((r) => !fs.existsSync(path.join(API, ...r.split("/"), "route.ts")));
ok("R2 every entry exists", missing.length === 0, missing.join(", "));
const dupes = mapRoutes.filter((r, i) => mapRoutes.indexOf(r) !== i);
ok("R2 no duplicates", dupes.length === 0, dupes.join(", "));
const outOfScope = mapRoutes.filter((r) => !inScope(r));
ok("R2 every entry is inside the scope", outOfScope.length === 0, outOfScope.join(", "));

// R9
const PENDING = new Set(PENDING_SEPARATE_BILLING_REVIEW);
const billingProtected = (r: string) =>
  r.startsWith("billing/") || r.startsWith("collection/") || r.startsWith("payments/") || r === "reports/uniform";
for (const r of PENDING) {
  const entry = ROUTE_FEATURE_MAP.find((e) => e.route === r);
  ok(`R9 ${r}: pending route is billing-protected`, billingProtected(r));
  ok(`R9 ${r}: pending route is a guarded map entry`, !!entry && "feature" in entry);
}
ok("R9 pending list has no duplicates", PENDING.size === PENDING_SEPARATE_BILLING_REVIEW.length);
const pendingKeys = new Set<string>();

const guardedKeysSeen = new Set<string>();
for (const entry of ROUTE_FEATURE_MAP) {
  const file = path.join(API, ...entry.route.split("/"), "route.ts");
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  const handlers = handlersOf(src);
  ok(`R3/R4 ${entry.route}: has handlers`, handlers.length > 0);

  if ("exempt" in entry) {
    ok(`R4 ${entry.route}: exempt route does not call the guard`, !src.includes("guardFeature("));
    if (entry.exempt === "data-rights-floor") ok(`R5 ${entry.route}: floor-exempt route is an export`, /export/.test(entry.route), entry.route);
    continue;
  }

  ok(`R3 ${entry.route}: feature is one of the eleven`, (GUARDED_FEATURE_KEYS as readonly string[]).includes(entry.feature));
  const ungated = entry.ungated ?? {};
  for (const m of Object.keys(ungated) as HttpMethod[]) {
    ok(`R3 ${entry.route}: ungated ${m} exists`, handlers.some((h) => h.method === m));
    const reason = ungated[m];
    if (reason === "data-rights-floor") ok(`R5 ${entry.route}: floor only on GET`, m === "GET", m);
    if (reason === "legal-correction") ok(`R5 ${entry.route}: legal-correction only on billing writes`, entry.route.startsWith("billing/") && m !== "GET");
  }
  if (PENDING.has(entry.route)) {
    ok(`R9 ${entry.route}: pending route does not call the guard yet`, !src.includes("guardFeature("));
    pendingKeys.add(entry.feature);
    continue;
  }
  const constName = KEY_CONST[entry.feature];
  for (const h of handlers) {
    const firstStmt = h.body.trimStart().split("\n")[0] ?? "";
    if (ungated[h.method]) {
      ok(`R3 ${entry.route} ${h.method}: ungated handler does not call the guard`, !h.body.includes("guardFeature("));
      continue;
    }
    const expected = `const featureDenied = await guardFeature(${h.param}, PLATFORM_FEATURE_KEYS.${constName});`;
    ok(`R3 ${entry.route} ${h.method}: first statement is the guard with ${entry.feature}`, firstStmt.trim() === expected, firstStmt.trim());
    ok(`R3 ${entry.route} ${h.method}: refusal is returned`, h.body.includes("if (featureDenied) return featureDenied;"));
    guardedKeysSeen.add(entry.feature);
  }
}

// R6
for (const k of GUARDED_FEATURE_KEYS) {
  ok(`R6 ${k} guards at least one route (or all of them wait for the billing PR)`, guardedKeysSeen.has(k) || pendingKeys.has(k));
}

// R7
const allRoutes = walk(API);
const strays = allRoutes.filter((f) => !inScope(toRoute(f)) && fs.readFileSync(f, "utf8").includes("guardFeature(")).map(toRoute);
ok("R7 no guard outside the scope", strays.length === 0, strays.join(", "));

// R8 — background steps reached by webhooks ask the same guard, with the right feature
const BACKGROUND_SITES: Array<{ file: string; key: string; site: string }> = [
  { file: "lib/services/conversation/inbound-message-pipeline.service.ts", key: "STARTER_BOT", site: "inbound-pipeline:starter-bot" },
  { file: "lib/intake/whatsapp/whatsapp-intake.ts", key: "DOCUMENTS", site: "whatsapp-intake:documents" },
];
for (const b of BACKGROUND_SITES) {
  const src = fs.readFileSync(path.join(ROOT, b.file), "utf8");
  ok(
    `R8 ${b.file}: asks featureAllowedForBusiness for ${b.key}`,
    src.includes(`featureAllowedForBusiness(businessId, PLATFORM_FEATURE_KEYS.${b.key}, "${b.site}")`),
  );
}

if (failures.length) {
  console.error(`route-feature-map: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`route-feature-map: all ${pass} checks passed (${scopeRoutes.length} routes in scope, ${ROUTE_FEATURE_MAP.filter((e) => "feature" in e).length} guarded, ${ROUTE_FEATURE_MAP.filter((e) => "exempt" in e).length} exempt, ${PENDING.size} pending the billing PR)`);
