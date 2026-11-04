/**
 * "חזרה" on the inventory screens whose detail lives in the same route as the list
 * (/inventory/drafts?id=…, /inventory/unmatched?match=…).
 *
 * The shared back fallback refuses a destination on the same screen (screenKeyOf ignores the query)
 * and sends the owner home (/app). Lab audit 2026-11-04: direct entry and list → detail → back both
 * landed on /app. These screens now use the kit's useInvSubViewBack: one history entry back when the
 * owner came from somewhere in the app, else router.replace(list).
 * Run: npx tsx lib/inventory/back-subviews.verify.test.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { screenKeyOf, HOME_FALLBACK } from "../navigation/back-nav/route-registry";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? " — " + detail : ""}`); }
}
const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// Why the helper is needed: a same-screen fallback is not a destination for the shared mechanism.
check("the list and its detail are the same screen for the back mechanism (drafts)", screenKeyOf("/inventory/drafts") === screenKeyOf("/inventory/drafts?id=1"));
check("the list and its detail are the same screen for the back mechanism (unmatched)", screenKeyOf("/inventory/unmatched") === screenKeyOf("/inventory/unmatched?match=1"));
check("the shared fallback for a same-screen destination is home", HOME_FALLBACK.url === "/app");

// The kit helper.
const kit = read("components/inventory/v2/kit.tsx");
const helper = kit.slice(kit.indexOf("export function useInvSubViewBack"), kit.indexOf("/* ================================================================== page === */"));
check("kit exports useInvSubViewBack", helper.startsWith("export function useInvSubViewBack(listUrl: string)"));
check("helper: one entry back when there is in-app history", /getBackTarget\(\)\.kind === "history"/.test(helper) && /window\.history\.back\(\)/.test(helper));
check("helper: otherwise replace to the list (never home)", /router\.replace\(listUrl\)/.test(helper) && !/\/app/.test(helper));
check("helper: honours the shared double-tap lock", /acquireBackLock\(\)/.test(helper));

// Both detail views use it.
for (const [file, title, list] of [
  ["app/(shell)/inventory/drafts/page.tsx", "בדיקת טיוטת מוצר", "/inventory/drafts"],
  ["app/(shell)/inventory/unmatched/page.tsx", "שיוך מכירה למוצר", "/inventory/unmatched"],
] as const) {
  const src = read(file);
  check(`${file}: LIST is ${list}`, src.includes(`const LIST = "${list}";`));
  check(`${file}: the hook is bound to the list`, src.includes("const backFromDetail = useInvSubViewBack(LIST);"));
  const at = src.indexOf(`title="${title}"`);
  const page = src.slice(at, at + 200);
  check(`${file}: the detail view's InvPage uses it as onBack`, at > 0 && page.includes("onBack={backFromDetail}"), page);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
