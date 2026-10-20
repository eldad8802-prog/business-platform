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
  ok("the secretary keeps today's screen unless daily_tasks is ON", /route\.showToday && sharedToday\)/.test(sec) && /<TodayScreen/.test(sec));
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
{
  const secretary = NAV_DESTINATIONS.find((d) => d.key === "secretary");
  ok("navigation names the secretary 'המזכירה שלי'", secretary?.label === "המזכירה שלי" && TOOLS.find((t) => t.key === "secretary")?.label === "המזכירה שלי");
}

if (failed > 0) {
  console.error(`\ntasks boundaries: ${failed} of ${checks} FAILED`);
  process.exit(1);
}
console.log(`\ntasks boundaries: ${checks} checks passed`);
