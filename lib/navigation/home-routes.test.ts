/**
 * Home / All-Tools navigation proof (`npm run verify:home-routes`).
 *
 * Every destination the home screen and the tools screen can send the owner to
 * is declared as data in `home-routes.ts`. This walks the real `app/` tree and
 * proves each one resolves to a page that exists — so a route that is renamed
 * or deleted breaks CI here rather than breaking a button in production.
 *
 * It also asserts the two rules the screens depend on:
 *   - no tool carries a hex colour (tints are class names, five of them);
 *   - every tool belongs to a declared group, and no group is empty.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  HOME_ROUTES,
  TOOLS,
  TOOL_GROUPS,
  allMappedHrefs,
  groupHref,
  toolsInGroup,
} from "./home-routes";

const ROOT = process.cwd();
const APP_DIR = join(ROOT, "app");

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = "") {
  checks += 1;
  if (!ok) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** `/payments/new?x=1#y` → `["payments", "new"]`. */
function pathSegments(href: string): string[] {
  const path = href.split("#")[0].split("?")[0];
  return path.split("/").filter(Boolean);
}

/**
 * Collects every renderable route path under `app/`, flattening route groups
 * (`(shell)`) and parallel-route markers, and keeping dynamic segments as a
 * `[param]` wildcard so `/customers/[id]` still matches `/customers/7`.
 */
function collectRoutes(dir: string, segments: string[], out: string[][]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  if (entries.includes("page.tsx") || entries.includes("page.ts")) {
    out.push(segments);
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    // Never a URL segment: route groups, private folders, the API tree.
    if (entry === "api") continue;
    if (entry.startsWith("_")) continue;
    if (entry.startsWith("(") && entry.endsWith(")")) {
      collectRoutes(full, segments, out);
      continue;
    }
    collectRoutes(full, [...segments, entry], out);
  }
}

const routes: string[][] = [];
collectRoutes(APP_DIR, [], routes);

function routeExists(href: string): boolean {
  const want = pathSegments(href);
  return routes.some((route) => {
    if (route.length !== want.length) return false;
    return route.every((segment, i) => {
      if (segment.startsWith("[") && segment.endsWith("]")) return true;
      return segment === want[i];
    });
  });
}

console.log("Home navigation map — route reachability");
console.log(`  app/ pages discovered        ${routes.length}`);
check(existsSync(APP_DIR), "app/ directory is readable");
check(routes.length > 50, "route scan found the app tree", `${routes.length} pages`);

// 1. Every mapped destination resolves.
const hrefs = Array.from(new Set(allMappedHrefs()));
console.log(`  mapped destinations          ${hrefs.length}`);
for (const href of hrefs) {
  check(routeExists(href), `route exists: ${href}`);
}

// 2. No dead placeholders anywhere in the map.
for (const href of hrefs) {
  check(href !== "#" && href.length > 1 && href.startsWith("/"), `real href: ${href}`);
}

// 3. Tools: five tints, declared groups, no hex.
const ALLOWED_TINTS = new Set(["teal", "sage", "amber", "clay", "slate"]);
const groupKeys = new Set(TOOL_GROUPS.map((g) => g.key));
for (const tool of TOOLS) {
  check(ALLOWED_TINTS.has(tool.color), `tool tint is one of the five: ${tool.key}`, tool.color);
  check(!/#[0-9a-f]{3,8}/i.test(tool.color), `tool carries no hex: ${tool.key}`);
  check(groupKeys.has(tool.group), `tool belongs to a declared group: ${tool.key}`, tool.group);
  check(tool.label.trim().length > 0, `tool has a label: ${tool.key}`);
}

// 4. Every group has tools and a resolvable anchor target.
for (const group of TOOL_GROUPS) {
  const members = toolsInGroup(group.key);
  check(members.length > 0, `group is not empty: ${group.key}`);
  check(groupHref(group).startsWith(`${HOME_ROUTES.tools}#`), `group anchors into /tools: ${group.key}`);
  check(group.domains.length > 0, `group speaks for at least one status domain: ${group.key}`);
}

// 5. Tool keys are unique — two tiles sharing a key would silently collapse.
const keys = TOOLS.map((t) => t.key);
check(new Set(keys).size === keys.length, "tool keys are unique");

console.log(`  checks ${checks}, failures ${failures}`);
if (failures > 0) {
  console.error("Home navigation map — FAILED");
  process.exit(1);
}
console.log("Home navigation map — OK");
