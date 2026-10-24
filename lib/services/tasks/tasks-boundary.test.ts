/**
 * Daily Tasks — static boundaries of milestone B (Daily Tasks spec 8.6, 12.3, 12.12, 13). Reads source files only.
 *
 *   T-C6 (static half): the agenda read path (agenda.service + the adapters) imports no write path and makes no
 *     write call; GET /api/tasks/agenda calls only getAgenda.
 *   Every /api/tasks route goes through tasksRoute (session-derived business, flag OFF ⇒ 404); no route reads a
 *     businessId from the request.
 *   T-M1: the task layer calls a service that writes money at exactly ONE point (recordManualPayment, in
 *     source-actions.service.ts), after its own request check (findPrior + assertKeyMayWrite precede it).
 *   T-M5: no amount enters the journal — the task layer never writes TaskEvent payload keys outside the closed
 *     schema (validated in commitRequest) and source-actions passes no amount into an event.
 *   Navigation: משימות / מזכירה / התחייבויות sit under "ניהול העסק"; משימות only with daily_tasks.
 *
 * Run: npx tsx lib/services/tasks/tasks-boundary.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { NAV_DESTINATIONS } from "@/components/navigation/nav-destinations";
import { TOOLS } from "@/lib/navigation/home-routes";

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  checks += 1;
  if (cond) console.log(`  [PASS] ${name}`);
  else {
    failed += 1;
    console.log(`  [FAIL] ${name}`, extra ?? "");
  }
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const WRITE_CALL = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM/;

console.log("read path (8.6)");
for (const f of ["lib/services/tasks/agenda.service.ts", "lib/services/tasks/sources.ts", "lib/services/tasks/agenda-core.ts", "lib/services/tasks/item-history.service.ts"]) {
  const src = code(f);
  ok(`${path.basename(f)} makes no write call`, !WRITE_CALL.test(src), src.match(WRITE_CALL)?.[0]);
  ok(`${path.basename(f)} imports no task write path`, !/from "\.\/(task\.service|task\.store|sync\.service|source-actions\.service|preferences\.service)"/.test(src));
}
{
  const route = code("app/api/tasks/agenda/route.ts");
  ok("GET /api/tasks/agenda calls getAgenda and nothing that writes", /getAgenda\(/.test(route) && !/runSync|sourceOp|createTask|recordManualPayment/.test(route));
  ok("the agenda route exports GET only", /export async function GET/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
}

console.log("routes (13)");
const routes = walk("app/api/tasks").filter((f) => f.endsWith("/route.ts"));
ok("the milestone-B route set exists", routes.length >= 10, routes.length);
for (const r of routes) {
  const src = code(r);
  const handlers = src.match(/export async function (GET|POST|PUT|PATCH|DELETE)/g) ?? [];
  const guarded = src.match(/return tasksRoute\(req,/g) ?? [];
  ok(`${r.replace("app/api/", "")}: every handler goes through tasksRoute`, handlers.length > 0 && guarded.length === handlers.length, { handlers: handlers.length, guarded: guarded.length });
  ok(`${r.replace("app/api/", "")}: no businessId from the request`, !/(body|b|params|searchParams)\.(get\("businessId"\)|businessId)/.test(src));
}
{
  const http = code("lib/services/tasks/tasks-http.ts");
  ok("tasksRoute: 401 without a session", /status: 401/.test(http));
  ok("tasksRoute: 404 while daily_tasks is OFF", /dailyTasksEnabled\(user\.businessId\)\)\) return NextResponse\.json\(\{ error: "Not found" \}, \{ status: 404 \}\)/.test(http));
  ok("the flag read fails closed", /catch \{\s*return false;\s*\}/.test(http));
}

console.log("money boundary (12.12)");
{
  const files = [...walk("lib/services/tasks"), ...walk("app/api/tasks"), ...walk("features/tasks"), ...walk("lib/tasks")].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
  const callers = files.filter((f) => /recordManualPayment\(|recordPaymentInTx\(|\/api\/payables\/payments/.test(code(f)));
  ok("T-M1: exactly one file calls the payment service", callers.length === 1 && callers[0] === "lib/services/tasks/source-actions.service.ts", callers);
  const src = code("lib/services/tasks/source-actions.service.ts");
  ok("T-M1: exactly one call site", (src.match(/recordManualPayment\(/g) ?? []).length === 1);
  const fn = src.slice(src.indexOf("export async function recordPaidViaTasks"));
  const iPrior = fn.indexOf("findPrior("), iAssert = fn.indexOf("assertKeyMayWrite("), iPay = fn.indexOf("recordManualPayment(");
  ok("T-I7: the request check runs before the payment service", iPrior > 0 && iAssert > iPrior && iPay > iAssert);
  ok("T-M3: the secretary's content-bound key is used", /idempotencyKey: `secretary:\$\{installmentId\}:\$\{input\.paidAt\}:\$\{input\.amount\}`/.test(fn));
  ok("T-M5: the fingerprint records the payment id only", /commitRequest\(tx, p, \[\], \{ paymentId \}\)/.test(fn));
  ok("no task file writes Payment / Installment / Commitment directly", !files.some((f) => /\.(payment|installment|commitment|paymentAllocation)\.(create|update|upsert|delete)/.test(code(f))));
}

console.log("navigation (owner-approved placement)");
{
  const business = NAV_DESTINATIONS.filter((d) => d.group === "business").map((d) => d.key);
  ok("ניהול העסק holds משימות, מזכירה, התחייבויות (and מלאי)", ["tasks", "secretary", "payables", "inventory"].every((k) => business.includes(k)), business);
  ok("התחייבויות left כסף", !NAV_DESTINATIONS.some((d) => d.key === "payables" && d.group === "money"));
  const tasks = NAV_DESTINATIONS.find((d) => d.key === "tasks");
  ok("משימות is gated by daily_tasks and is not a primary tab", tasks?.feature === "daily_tasks" && !tasks?.primary && tasks?.href === "/tasks");
  ok("the secretary and payables keep their routes", NAV_DESTINATIONS.find((d) => d.key === "secretary")?.href === "/secretary" && NAV_DESTINATIONS.find((d) => d.key === "payables")?.href === "/payables");
  const ops = TOOLS.filter((t) => t.group === "operations").map((t) => t.key);
  ok("the ניהול העסק family lists them too", ["tasks", "secretary", "payables"].every((k) => ops.includes(k)), ops);
  ok("the family's משימות tool is gated", TOOLS.find((t) => t.key === "tasks")?.feature === "daily_tasks");
  const side = code("components/navigation/side-nav.tsx");
  ok("the sidebar hides a gated destination until the flag is ON", /filter\(\(d\) => !d\.feature \|\| \(d\.feature === "daily_tasks" && tasksOn\)\)/.test(side));
  const sheet = code("components/navigation/action-sheet.tsx");
  ok("\"+\" lists משימה חדשה only with the flag", /feature: "daily_tasks"/.test(sheet) && /filter\(\(a\) => !a\.feature/.test(sheet));
  const cat = code("features/tools/category-screen.tsx");
  ok("the family screen hides a gated tool until the flag is ON", /filter\(\(t\) => !t\.feature/.test(cat));
  const sec = code("app/(shell)/secretary/page.tsx");
  // Owner 2026-10-24: opening daily_tasks gives personal tasks only — the secretary's "היום שלי" never becomes the
  // shared agenda with its automatic items (payments, leads, stock…).
  ok("the secretary's today screen is her own, whatever daily_tasks says", /if \(route\.showToday\) \{\s*return \(\s*<SecretaryErrorBoundary>\s*<TodayScreen/.test(sec)
    && !/SecretaryToday|useAgenda|fetchAgenda|daily_tasks/.test(sec));
  const hub = code("app/(shell)/secretary/secretary-hub-model.ts");
  ok("the secretary hub reads the owner's own tasks only (TASK rows)", /if \(row\.type !== "TASK"\) continue;/.test(hub));
}

console.log("operational retention (12.7, 12.8)");
{
  const wf = read(".github/workflows/task-retention.yml");
  const body = wf.replace(/^\s*#.*$/gm, "");
  ok("the retention workflow is scheduled daily", /schedule:\s*\n\s*- cron: "\d+ \d+ \* \* \*"/.test(body));
  ok("…inert until activated: main only AND vars.TASK_RETENTION_ENABLED == 'true'", /if: github\.ref == 'refs\/heads\/main' && vars\.TASK_RETENTION_ENABLED == 'true'/.test(body));
  ok("…bound to the protected production-db environment", /environment: production-db/.test(body));
  const calls = [...body.matchAll(/public\.(task_retention_[a-z_]+)\(\)/g)].map((m) => m[1]).sort();
  ok("…calls exactly the two operational functions — never an H3 function", calls.join() === "task_retention_clear_event_digests,task_retention_purge_request_ledger", calls);
  ok("…and prints counts only", !/SELECT \*|to_jsonb|RETURNING/.test(body));
  const guard = read("scripts/ci/workflow-policy-guard.mjs");
  ok("its secret is classified production-capable and its schedule is SANCTIONED", /TASK_RETENTION_DATABASE_URL/.test(guard) && /file: "task-retention\.yml"/.test(guard));
}
console.log("task centre — personal list, always room for one more (owner 2026-10-24)");
{
  const screen = code("features/tasks/tasks-screen.tsx");
  const css = read("features/tasks/tasks.module.css");
  ok("the task centre asks for the personal agenda only", /useAgenda\(true, \{ personal: true \}\)/.test(screen));
  ok("\"+\" while already on /tasks opens the form (not only on the first mount)", /get\("new"\) !== "1"\) return;[\s\S]{0,200}setCreating\(true\)/.test(screen));
  ok("\"משימה חדשה\" is never hidden, on any width", !/\.btn\.newBtn \{ display: none; \}/.test(css) && /\.btn\.newBtn \{ display: inline-flex;/.test(css));
  ok("the screen keeps clear of the iPhone status bar", /padding-block: calc\(14px \+ var\(--dz-safe-top, 0px\)\)/.test(css));
  const reminder = code("components/notifications/reminder-center.tsx");
  ok("the reminder toast sits above the mobile bottom bar", /\.dz-reminder-toast \{ bottom: calc\(104px/.test(reminder));
  const catalog = code("lib/services/feature-access/platform-feature-catalog.ts");
  ok("daily_tasks is ON by default for every business", /key: PLATFORM_FEATURE_KEYS\.DAILY_TASKS,[\s\S]{0,300}defaultEnabled: true,/.test(catalog));
}
console.log("a deployed fix reaches an open home-screen app (2026-10-24)");
{
  const layout = code("app/(shell)/layout.tsx");
  const reload = code("components/navigation/stale-client-reload.tsx");
  ok("the shell mounts the stale-client reload", /<StaleClientReload \/>/.test(layout));
  ok("…it compares the page's deployment with the current one", /dataset\.dplId/.test(reload) && /fetch\("\/api\/health\/version"/.test(reload));
  ok("…on return to the foreground and on navigation", /visibilitychange/.test(reload) && /\[pathname, check\]/.test(reload));
  ok("…once per deployment, never while typing", /sessionStorage\.getItem\(RELOADED_FOR\) === current/.test(reload) && /HTMLInputElement/.test(reload));
  const version = code("app/api/health/version/route.ts");
  ok("the version route answers the deployment id, uncached", /VERCEL_DEPLOYMENT_ID/.test(version) && /no-store/.test(version));
}
console.log("a reminder opens its task directly (owner 2026-10-25)");
{
  const screen = code("features/tasks/tasks-screen.tsx");
  const center = code("components/notifications/reminder-center.tsx");
  const bell = code("components/notifications/notification-center.tsx");
  const sw = read("public/sw.js");
  ok("push and bell carry /tasks?task=<id>", /data\.url : "\/tasks"/.test(sw) && /`\/tasks\?task=\$\{task\.id\}`/.test(code("lib/services/tasks/task-reminders.service.ts")));
  ok("every new ?task= opens (not only the first one of the screen)", /handledLink\.current === linkKey/.test(screen) && /handledLink\.current = null;/.test(screen));
  ok("opening a task tells the reminder card to step aside", /dispatchEvent\(new CustomEvent\(TASK_OPENED_EVENT/.test(screen) && /addEventListener\(TASK_OPENED_EVENT/.test(center));
  ok("…the card skips the task in the URL and marks its reminder seen", /taskInUrl\(\)/.test(center) && /markReminderSeen\(r\.id\)/.test(center));
  ok("…a later reminder of the same task still shows", /new Date\(r\.at\)\.getTime\(\) > until/.test(center));
  const closedPart = read("features/tasks/task-details.tsx").split("export function ClosedTaskDetails")[1]?.split("// ── business item")[0] ?? "";
  ok("a task no longer open is shown read-only", /<ClosedTaskDetails /.test(screen) && closedPart.length > 0 && !/taskAction|seriesAction|editTask/.test(closedPart));
  ok("the bell opens a task reminder in one click", /n\.severity === "REMINDER" && isSafeInternalHref\(n\.href\)/.test(bell));
}
{
  const secretary = NAV_DESTINATIONS.find((d) => d.key === "secretary");
  ok("navigation names the secretary 'המזכירה שלי'", secretary?.label === "המזכירה שלי" && TOOLS.find((t) => t.key === "secretary")?.label === "המזכירה שלי");
}

if (failed > 0) {
  console.error(`\ntasks boundaries: ${failed} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`\ntasks boundaries: ${checks} checks passed`);
