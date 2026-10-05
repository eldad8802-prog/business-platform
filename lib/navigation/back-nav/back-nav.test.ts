/**
 * Back navigation — pure logic. Run:
 *   npx tsx lib/navigation/back-nav/back-nav.test.ts
 *
 * Covers: safe-path validation (open redirects, schemes, auth/technical
 * targets), the trail resolver (real origin, multi-source screens, same-screen
 * and transient skipping, scope boundaries, corrupted chains, walk limit), the
 * route registry (every real page route classified, fallbacks valid and
 * loop-free, query-routed screen identity).
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isTechnicalPath, toSafeInternalPath } from "./safe-path";
import { MAX_WALK, parseStore, pruneStore, resolveBackTarget, MAX_ENTRIES, type TrailStore } from "./trail-core";
import {
  ROUTE_RULES,
  fallbackFor,
  findRouteRule,
  isRootPath,
  isTransientPath,
  screenKeyOf,
} from "./route-registry";

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`OK: ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

/* ------------------------------------------------------------ safe-path -- */
ok("plain path accepted", toSafeInternalPath("/documents") === "/documents");
ok("query kept, hash dropped", toSafeInternalPath("/documents/search?q=abc#x") === "/documents/search?q=abc");
for (const bad of [
  "//evil.com",
  "//evil.com/documents",
  "/\\evil.com",
  "\\\\evil.com",
  "https://evil.com",
  "http:/evil.com",
  "javascript:alert(1)",
  "documents",
  "",
  "   ",
  "/%2F%2Fevil.com",
  "/documents\nSet-Cookie:x",
  "/login",
  "/login?next=/app",
  "/register",
  "/api/documents",
  "/_next/static/x.js",
  "/onboarding",
  "/favicon.ico",
  `/${"a".repeat(3000)}`,
]) {
  ok(`rejected: ${JSON.stringify(bad).slice(0, 40)}`, toSafeInternalPath(bad) === null);
}
ok("non-string rejected", toSafeInternalPath(42) === null && toSafeInternalPath(null) === null);
ok("isTechnicalPath(/api/x)", isTechnicalPath("/api/x"));
ok("isTechnicalPath(/apix) false", !isTechnicalPath("/apix"));

/* ----------------------------------------------------------- trail core -- */
const S = "u:9";
function chain(urls: string[], scope: string | null = S): TrailStore {
  const store: TrailStore = {};
  urls.forEach((url, i) => {
    store[`e${i}`] = { id: `e${i}`, url, prev: i === 0 ? null : `e${i - 1}`, scope, t: i };
  });
  return store;
}
const last = (urls: string[]) => `e${urls.length - 1}`;
const resolve = (urls: string[], extra: Partial<Parameters<typeof resolveBackTarget>[0]> = {}) =>
  resolveBackTarget({
    store: chain(urls),
    currentId: last(urls),
    scope: S,
    isTransient: isTransientPath,
    screenKey: screenKeyOf,
    ...extra,
  });

// The same document opened from three different places returns to each.
for (const origin of ["/app", "/documents?tab=x", "/search", "/documents/search?q=חשבונית"]) {
  const t = resolve([origin, "/documents/review/5"]);
  ok(`review opened from ${origin} → back to it`, t.kind === "history" && t.delta === -1 && decodeURIComponent(t.url) === origin, t);
}
{
  const t = resolve(["/customers", "/customers/4", "/inbox?conversationId=7", "/leads/3"]);
  ok("lead opened from a conversation → back to the conversation", t.kind === "history" && t.url === "/inbox?conversationId=7");
}
{
  // list filter pushes, then detail: back lands on the LAST list state.
  const t = resolve(["/documents/search?q=a", "/documents/search?q=ab", "/documents/review/1"]);
  ok("back keeps the latest list state", t.kind === "history" && t.url === "/documents/search?q=ab" && t.delta === -1);
}
{
  // edit → save pushed the detail again: back skips the stale form and the
  // duplicate of the current screen, lands on the list (one go(-3)).
  const t = resolve(["/billing", "/billing/7", "/inventory/items/create", "/billing/7"]);
  ok("a different screen in between is a real origin", t.kind === "history" && t.url === "/inventory/items/create" && t.delta === -1);
  const t2 = resolve(["/billing", "/billing/7", "/billing/7?tab=x"]);
  ok("same pathname (filter push) skipped → leaves the screen", t2.kind === "history" && t2.url === "/billing" && t2.delta === -2);
}
{
  const t = resolve(["/app", "/login", "/documents/review/5"]);
  ok("login entry is never a target", t.kind === "history" && t.url === "/app" && t.delta === -2);
  const t2 = resolve(["/collection", "/payments/4", "/collection/c/9"]);
  ok("redirect stub skipped", t2.kind === "history" && t2.url === "/collection" && t2.delta === -2);
  const t3 = resolve(["/content/creator-plan", "/content/render", "/content/result"]);
  ok("content render (re-POSTs) skipped from result", t3.kind === "history" && t3.url === "/content/creator-plan");
}
ok("first entry (direct link / new tab) → none", resolve(["/documents/review/5"]).kind === "none");
ok("unknown current id → none", resolveBackTarget({ store: chain(["/a", "/b"]), currentId: "zzz", scope: S }).kind === "none");
ok("null current id → none", resolveBackTarget({ store: chain(["/a", "/b"]), currentId: null, scope: S }).kind === "none");
ok("signed-out scope → none", resolveBackTarget({ store: chain(["/app", "/documents/review/5"]), currentId: "e1", scope: null }).kind === "none");
{
  const store = chain(["/customers/4", "/documents/review/5"]);
  store.e0.scope = "u:other";
  ok("never crosses into another account's entries", resolveBackTarget({ store, currentId: "e1", scope: S }).kind === "none");
  const store2 = chain(["/app", "/documents/review/5"]);
  ok("current entry recorded under another account → none", resolveBackTarget({ store: store2, currentId: "e1", scope: "u:other" }).kind === "none");
}
{
  const store = chain(["/app", "/x", "/documents/review/5"]);
  delete store.e1;
  ok("missing link ends the walk (no blind steps)", resolveBackTarget({ store, currentId: "e2", scope: S }).kind === "none");
}
{
  const store = chain(["/a", "/b", "/c"]);
  store.e0.prev = "e2"; // cycle
  store.e1.url = "/c";
  store.e0.url = "/c";
  const t = resolveBackTarget({ store, currentId: "e2", scope: S });
  ok("cyclic chain terminates", t.kind === "none");
}
{
  const urls = ["/app", ...Array.from({ length: MAX_WALK + 5 }, () => "/billing/1"), "/billing/1"];
  ok("walk is bounded", resolve(urls).kind === "none");
}
{
  const store = chain(["https://evil.com/x", "/documents/review/5"]);
  const t = resolveBackTarget({ store, currentId: "e1", scope: S });
  ok("unsafe recorded url never targeted", t.kind === "none");
}
// Query-routed screens (Secretary, Inbox).
{
  const t = resolve(["/secretary", "/secretary?screen=all", "/secretary?screen=detail&id=4"]);
  ok("secretary detail → back to the list screen", t.kind === "history" && t.url === "/secretary?screen=all" && t.delta === -1);
  const t2 = resolve(["/app", "/secretary?screen=detail&id=4"]);
  ok("secretary detail from home → home", t2.kind === "history" && t2.url === "/app");
  const t3 = resolve(["/inbox", "/inbox?conversationId=3"]);
  ok("conversation → back to the list (pop, not push)", t3.kind === "history" && t3.url === "/inbox" && t3.delta === -1);
}
// In-screen flow steps (useFlowStep: ?step= / ?cstep= / ?list= are identity params).
{
  const t = resolve(["/tools/money", "/pricing", "/pricing?step=calc", "/pricing?step=result"]);
  ok("pricing result → calc step (one step back)", t.kind === "history" && t.url === "/pricing?step=calc" && t.delta === -1);
  const t2 = resolve(["/tools/money", "/pricing", "/pricing?step=calc"]);
  ok("pricing calc → catalog", t2.kind === "history" && t2.url === "/pricing" && t2.delta === -1);
  const t3 = resolve(["/collection", "/collection/new", "/collection/new?step=details", "/collection/new"]);
  ok("collection: 'other customer' step → back to details actually taken", t3.kind === "history" && t3.url === "/collection/new?step=details");
  const t4 = resolve(["/revenue", "/revenue?view=create", "/revenue?view=create&cstep=direction"]);
  ok("coupon direction → goal step", t4.kind === "history" && t4.url === "/revenue?view=create");
  const t5 = resolve(["/tools/money", "/revenue/redeem", "/revenue/redeem?step=manual", "/revenue/redeem?step=error"]);
  ok("redeem error → manual entry", t5.kind === "history" && t5.url === "/revenue/redeem?step=manual");
  const t6 = resolve(["/inbox", "/inbox?list=conversation_list", "/inbox?list=conversation_list&conversationId=7"]);
  ok("inbox conversation → that category's list → (then) triage", t6.kind === "history" && t6.url === "/inbox?list=conversation_list");
  ok("non-identity params still collapse", screenKeyOf("/pricing?step=calc&x=1") === "/pricing?step=calc");
}

// Completed flows: consumed (done) steps are never a target.
{
  const store = chain(["/tools/money", "/pricing", "/pricing?step=new1", "/pricing?step=created"]);
  store.e2.done = true;
  const t = resolveBackTarget({ store, currentId: "e3", scope: S, isTransient: isTransientPath, screenKey: screenKeyOf });
  ok("created → catalog, skipping the consumed wizard step", t.kind === "history" && t.url === "/pricing" && t.delta === -2);
  const s2 = chain(["/inventory", "/inventory/supplier-purchases/new", "/inventory/supplier-purchases/new/cart", "/inventory/supplier-purchases/7/send"]);
  s2.e1.done = true;
  s2.e2.done = true;
  const t2 = resolveBackTarget({ store: s2, currentId: "e3", scope: S, isTransient: isTransientPath, screenKey: screenKeyOf });
  ok("order sent → where the wizard was opened (cart/products consumed)", t2.kind === "history" && t2.url === "/inventory" && t2.delta === -3);
  ok("done survives parse", parseStore(JSON.stringify(s2)).e1?.done === true && parseStore(JSON.stringify(s2)).e0?.done === undefined);
}
// #hash continuation: same URL (hash dropped) → same screen → skipped.
{
  const t = resolve(["/tools/money", "/payables/match/41", "/payables/match/41"]);
  ok("#fragment entry on the detail → back reaches the real origin", t.kind === "history" && t.url === "/tools/money" && t.delta === -2);
}

// Store hygiene.
{
  ok("parseStore rejects junk", Object.keys(parseStore("{\"a\":{\"id\":\"b\"}}")).length === 0 && Object.keys(parseStore("nope")).length === 0 && Object.keys(parseStore("[1]")).length === 0);
  const good = chain(["/a"]);
  ok("parseStore keeps valid entries", parseStore(JSON.stringify(good)).e0?.url === "/a");
  const big: TrailStore = {};
  for (let i = 0; i < MAX_ENTRIES + 20; i += 1) big[`k${i}`] = { id: `k${i}`, url: "/a", prev: null, scope: S, t: i };
  const pruned = pruneStore(big, ["k0"]);
  ok("prune caps size and keeps protected", Object.keys(pruned).length === MAX_ENTRIES && !!pruned.k0 && !pruned.k1);
}

/* -------------------------------------------------------- route registry -- */
// Every real page route must be classified: root, registered sub-screen, or
// an explicit exemption (public / auth / dev / redirect-only).
const EXEMPT_PREFIXES = [
  "/login", "/register", "/onboarding", "/dev", "/test-upload", "/brand-animation-demo", "/posts", "/upload",
  "/coupon-design", "/home", "/home-prototype", "/about", "/contact", "/privacy", "/terms", "/data-deletion",
  "/revenue/issue", "/offers", "/promotions", "/dashboard", "/opportunities", "/",
];
function pageRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "api" || name.startsWith("_")) continue;
      out.push(...pageRoutes(p));
    } else if (name === "page.tsx") {
      const rel = relative("app", dir).split(sep).filter((s) => !(s.startsWith("(") && s.endsWith(")")));
      out.push(`/${rel.join("/")}`.replace(/\/$/, "") || "/");
    }
  }
  return out;
}
const routes = [...new Set(pageRoutes("app"))].sort();
ok("found page routes", routes.length > 100, routes.length);
for (const r of routes) {
  const exempt = EXEMPT_PREFIXES.some((p) => r === p || r.startsWith(`${p}/`));
  const rule = findRouteRule(r.replace(/\[[^\]]+\]/g, "x"));
  ok(`classified: ${r}`, exempt || !!rule, "add a ROUTE_RULES entry");
}
for (const rule of ROUTE_RULES) {
  if (!rule.parent) continue;
  ok(`fallback is a safe in-app path: ${rule.pattern}`, toSafeInternalPath(rule.parent) === rule.parent);
  ok(`fallback has a destination label: ${rule.pattern}`, !!rule.parentLabel && rule.parentLabel.length > 1);
  // Following fallbacks upward must reach a root without revisiting a screen.
  const seen = new Set<string>();
  let cur: string = rule.pattern.replace(/\[[^\]]+\]/g, "x");
  let reachedRoot = false;
  for (let i = 0; i < 12; i += 1) {
    if (seen.has(cur)) break;
    seen.add(cur);
    if (isRootPath(cur)) {
      reachedRoot = true;
      break;
    }
    cur = fallbackFor(cur).url;
  }
  ok(`fallback chain reaches a root without loops: ${rule.pattern}`, reachedRoot, [...seen]);
}
ok("roots have no fallback parent", ROUTE_RULES.filter((r) => r.root).every((r) => !r.parent));
ok("unregistered path → Home fallback", fallbackFor("/no/such/screen").url === "/app");
ok("dynamic match", fallbackFor("/documents/review/123").url === "/documents");
ok("literal beats dynamic", fallbackFor("/inventory/items/create").label === "לרשימת המוצרים" && findRouteRule("/inventory/items/create")?.pattern === "/inventory/items/create");
ok("screenKey ignores non-identity params", screenKeyOf("/documents/search?q=a") === "/documents/search");
ok("screenKey keeps identity params", screenKeyOf("/secretary?screen=detail&id=4&x=1") === "/secretary?screen=detail&id=4");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
