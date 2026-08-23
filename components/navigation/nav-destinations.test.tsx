/**
 * Nav destinations — home target + active-state (Wave 1A). Run:
 *   npx tsx components/navigation/nav-destinations.test.tsx
 *
 * Guards the P0 fix: the authenticated "בית" tab must point INTO the app shell
 * (`/app`), never to `/` (which the primary domain rewrites to the public
 * marketing home in next.config.ts), so a logged-in user is never ejected from
 * the app by tapping Home.
 */
import {
  NAV_DESTINATIONS,
  PRIMARY_DESTINATIONS,
  isNavActive,
} from "./nav-destinations";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const home = NAV_DESTINATIONS.find((d) => d.key === "home");

// ---- home destination target ----
ok("home tab points to /app (in-shell)", home?.href === "/app");
ok("NO destination points to '/' (would exit app to marketing)", NAV_DESTINATIONS.every((d) => d.href !== "/"));
ok("every href is an absolute in-app path", NAV_DESTINATIONS.every((d) => d.href.startsWith("/") && d.href !== "/"));

// ---- active-state ----
ok("home active on /app", isNavActive("/app", "/app") === true);
ok("home active on / (transient pre-redirect)", isNavActive("/", "/app") === true);
ok("home NOT active on /documents", isNavActive("/documents", "/app") === false);
ok("home NOT active on /inbox", isNavActive("/inbox", "/app") === false);

// ---- other destinations unaffected ----
ok("documents active on /documents", isNavActive("/documents", "/documents") === true);
ok("documents active on nested /documents/123", isNavActive("/documents/123", "/documents") === true);
ok("documents NOT active on /inbox", isNavActive("/inbox", "/documents") === false);
ok("payments not active on /", isNavActive("/", "/payments") === false);

// ---- primary tabs shape (mobile bottom bar) ----
ok("exactly 4 primary tabs", PRIMARY_DESTINATIONS.length === 4);
ok("primary tabs are home/chats/docs/inventory", PRIMARY_DESTINATIONS.map((d) => d.key).join(",") === "home,chats,docs,inventory");

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll nav-destinations tests passed.");
