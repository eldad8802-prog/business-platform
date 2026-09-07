/**
 * Notification centre — contract guards. Run:
 *   npx tsx components/notifications/notification-center.test.tsx
 *
 * This repository has no DOM unit stack (Playwright only, no jsdom or testing
 * library), and adding one would be an infrastructure change this task is not
 * allowed to make. So the pure helpers are tested directly, and the properties
 * that live in the markup are asserted against the source.
 *
 * That is a weaker instrument than rendering, and the report says so. What it
 * does buy is real: the rules most likely to be broken later by someone editing
 * quickly — dismiss appearing, a tenant id being sent from the client, polling
 * creeping in, read starting to mean resolved — all fail here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activateNotification,
  isSafeInternalHref,
  relativeTime,
  severityStyle,
} from "./notification-center";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const CENTER = readFileSync(join(HERE, "notification-center.tsx"), "utf8");
const PAGE = readFileSync(join(REPO_ROOT, "app", "(shell)", "notifications", "page.tsx"), "utf8");
const HOME = readFileSync(join(REPO_ROOT, "app", "(shell)", "app", "page.tsx"), "utf8");

let failures = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
}

/* ── severity: distinct, labelled, never colour-only ──────────────────────── */
console.log("\nSeverity presentation");
{
  const crit = severityStyle("CRITICAL");
  const high = severityStyle("HIGH");
  const med = severityStyle("MEDIUM");
  check("CRITICAL is visually stronger than MEDIUM", crit.color !== med.color && crit.border !== med.border);
  check("CRITICAL and HIGH are distinguishable", crit.color !== high.color);
  check("every severity carries a text label", [crit, high, med].every((s) => s.label.length > 0));
  check("an unknown severity degrades to its own name rather than throwing",
    severityStyle("WHATEVER").label === "WHATEVER");
  check("colours come from Mist tokens, not literals",
    [crit, high, med].every((s) => s.color.startsWith("var(--dz-")));
  check("the labels match the attention page's Hebrew",
    crit.label === "קריטי" && high.label === "גבוה" && med.label === "בינוני");
}

/* ── relative time ────────────────────────────────────────────────────────── */
console.log("\nRelative time");
{
  const t = (minutesAgo: number) => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    return relativeTime(new Date(now - minutesAgo * 60_000).toISOString(), now);
  };
  check("under a minute reads as now", t(0) === "כרגע");
  check("minutes", t(5) === "לפני 5 דק׳");
  check("hours", t(180) === "לפני 3 שע׳");
  check("yesterday", t(60 * 30) === "אתמול");
  check("days", t(60 * 24 * 5) === "לפני 5 ימים");
  check("a future timestamp does not produce a negative age", t(-10) === "כרגע");
}

/* ── href safety ──────────────────────────────────────────────────────────── */
console.log("\nNavigation safety");
{
  check("an internal path is linkable", isSafeInternalHref("/inventory"));
  check("an absolute external URL is refused", !isSafeInternalHref("https://evil.example/x"));
  check("a protocol-relative URL is refused", !isSafeInternalHref("//evil.example/x"));
  check("javascript: is refused", !isSafeInternalHref("javascript:alert(1)"));
  check("a non-string is refused", !isSafeInternalHref(undefined as unknown as string));
  check("the centre renders a link only through this guard",
    /isSafeInternalHref\(n\.href\)/.test(CENTER) && /linkable \?/.test(CENTER));
}

/* ── the lifecycle contract, in the markup ────────────────────────────────── */
console.log("\nRead is not resolved");
{
  check("unread is derived from readAt", /const unread = n\.readAt === null/.test(CENTER));
  check("resolved is derived from resolvedAt", /const resolved = n\.resolvedAt !== null/.test(CENTER));
  check("a resolved item is labelled נפתר and an open one פעיל",
    /resolved \? "נפתר" : "פעיל"/.test(CENTER));
  check("state is also announced in words, not colour alone",
    /sr-only/.test(CENTER) && /הבעיה עדיין פעילה/.test(CENTER) && /לא נקראה/.test(CENTER));
  check("marking read never writes resolvedAt",
    !/resolvedAt:\s*(new Date|[^n])/.test(CENTER.slice(CENTER.indexOf("const markRead"), CENTER.indexOf("const markAllRead"))));
  check("a read item still shows as active when unresolved",
    /opacity: resolved \? /.test(CENTER) && !/opacity: unread/.test(CENTER));
}

/* ── dismiss must not exist ───────────────────────────────────────────────── */
console.log("\nDismiss is not exposed");
{
  // Behaviour, not prose: the doc comment legitimately says the centre never
  // dismisses anything.
  const fetchUrls = [...CENTER.matchAll(/fetch\(\s*["'\x60]([^"'\x60$]*)/g)].map((m) => m[1]);
  check("no dismiss endpoint is called", !fetchUrls.some((u) => /dismiss/i.test(u)), fetchUrls.join(" "));
  check("no handler dismisses anything", !/dismiss[A-Z]\w*\(/.test(CENTER));
  check("no dismiss control is rendered", !/סגור לצמיתות|התעלם|swipe/i.test(CENTER));
  check("nothing is hidden client-side to fake dismissal",
    !/filter\(\(n\) => !n\./.test(CENTER));
}

/* ── tenancy stays server-side ────────────────────────────────────────────── */
console.log("\nTenant safety");
{
  for (const [label, src] of [["centre", CENTER], ["page", PAGE]] as const) {
    check(`the ${label} never sends a businessId`, !/businessId/.test(src));
  }
  check("requests carry no tenant query parameter",
    !/params\.set\(\s*["']business/.test(CENTER));
  check("the centre calls only the four notification endpoints",
    [...CENTER.matchAll(/fetch\(\s*[`"']([^`"'$]*)/g)].every((m) => m[1].startsWith("/api/notifications")));
}

/* ── restraint ────────────────────────────────────────────────────────────── */
console.log("\nRefresh behaviour");
{
  check("no polling timer", !/setInterval|setTimeout\([^)]*\d{3,}/.test(CENTER));
  check("no websocket or event source", !/WebSocket|EventSource/.test(CENTER));
  check("no service worker or push registration", !/serviceWorker|PushManager|pushManager/.test(CENTER));
  check("the badge comes from the server, never counted locally",
    /setUnreadCount\(page\.unreadCount\)/.test(CENTER) &&
    !/items\.filter\([^)]*readAt === null\)\.length/.test(CENTER));
  check("mark-all-read reloads rather than guessing the new count",
    /markAllRead[\s\S]{0,400}await load\(/.test(CENTER));
}

/* ── states the owner can actually hit ────────────────────────────────────── */
console.log("\nLoading, empty and error states");
{
  check("a loading state exists", /status === "loading"/.test(CENTER) && /טוען התראות/.test(CENTER));
  check("an empty state exists and speaks plainly", /אין התראות/.test(CENTER));
  check("the unread filter has its own empty state", /אין התראות שלא נקראו/.test(CENTER));
  check("an error state exists and is recoverable",
    /role="alert"/.test(CENTER) && /נסה שוב/.test(CENTER));
  check("load-more appears only when the API offers a cursor",
    /cursor !== null \? \(/.test(CENTER) && /טען עוד/.test(CENTER));
}

/* ── shell integration ────────────────────────────────────────────────────── */
console.log("\nShell integration");
{
  check("the page declares a width intent", /intent="focused"/.test(PAGE));
  check("the centre is right-to-left", /dir="rtl"/.test(CENTER));
  check("the home bell points at the notification centre", /href: "\/notifications"/.test(HOME));
  check("the bell's unread flag comes from the real count",
    /hasUnread: unreadCount > 0/.test(HOME) && /api\/notifications\/unread-count/.test(HOME));
  check("the bell no longer fakes unread from the leads count",
    !/hasUnread: \(data\.leadsAttention/.test(HOME));
  check("the home screen does not poll the count", !/setInterval/.test(HOME));
  check("mark-all-read is offered only when something is unread",
    /unreadCount > 0 \? \([\s\S]{0,600}סמן הכל כנקרא/.test(CENTER));
}

/* ── touch targets ────────────────────────────────────────────────────────── */
console.log("\nMobile ergonomics");
{
  const minHeights = [...CENTER.matchAll(/minHeight:\s*(\d+)/g)].map((m) => Number(m[1]));
  check("every declared control height is at least 36px",
    minHeights.length > 0 && minHeights.every((h) => h >= 36), minHeights.join(","));
  check("long Hebrew titles wrap rather than overflow",
    (CENTER.match(/overflowWrap: "anywhere"/g) || []).length >= 2);
  check("the filter group is labelled for assistive tech",
    /role="group"/.test(CENTER) && /aria-label="סינון התראות"/.test(CENTER));
  check("filter buttons expose their pressed state", /aria-pressed=\{filter === f\}/.test(CENTER));
  check("a non-link card is still keyboard reachable",
    /onKeyDown/.test(CENTER) && /e\.key === "Enter"/.test(CENTER));
}

/* ── the regression this suite failed to catch the first time ─────────────
 *
 * Every authenticated client fetch in this app sends the session token as a
 * Bearer header. The centre shipped without one, so all four of its calls
 * returned 401 and the page rendered nothing — and these tests passed anyway,
 * because they checked the URLs and never the headers.
 *
 * Runtime QA caught it. These checks make sure it stays caught.
 */
console.log("\nEvery notification request is authenticated");
{
  // Each fetch, from its opening paren to the closing brace of its options.
  const calls = [...CENTER.matchAll(/fetch\([\s\S]*?\}\s*\)/g)].map((m) => m[0]);
  check("the centre makes exactly three requests", calls.length === 3, `n=${calls.length}`);
  check("every one of them sends a Bearer header",
    calls.length === 3 && calls.every((c) => /Authorization: `Bearer \$\{token\}`/.test(c)),
    calls.map((c) => (/Authorization/.test(c) ? "auth" : "NO-AUTH")).join(","));

  for (const [label, re] of [
    ["GET /api/notifications", /\/api\/notifications\?/],
    ["POST /api/notifications/[id]/read", /\/api\/notifications\/\$\{id\}\/read/],
    ["POST /api/notifications/read-all", /\/api\/notifications\/read-all/],
  ] as const) {

    const call = calls.find((c) => re.test(c));
    check(`${label} carries Authorization`,
      call !== undefined && /Authorization: `Bearer/.test(call));
  }

  check("the home unread-count request carries Authorization",
    /unread-count[\s\S]{0,200}Authorization: `Bearer \$\{sessionToken\}`/.test(HOME));

  // A credential-less request must be abandoned, never sent malformed: the
  // server would read "Bearer null" as a bad token rather than no token.
  check("the centre refuses to call without a token",
    (CENTER.match(/if \(!token\) throw new MissingSessionError\(\)/g) || []).length === 3);
  check("the home badge stays quiet without a token", /if \(!sessionToken\) return;/.test(HOME));
  // Comments legitimately discuss "Bearer null"; only executable code counts.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const centerCode = stripComments(CENTER);
  const homeCode = stripComments(HOME);
  check("no request can be built as Bearer null or undefined",
    !/Bearer (null|undefined)/.test(centerCode) && !/Bearer (null|undefined)/.test(homeCode));
  check("every Bearer in code interpolates a guarded variable",
    [...centerCode.matchAll(/Bearer \$\{(\w+)\}/g)].every((m) => m[1] === "token") &&
    [...homeCode.matchAll(/Bearer \$\{(\w+)\}/g)].every((m) => ["sessionToken", "currentToken"].includes(m[1])));

  check("the token is read the way the rest of the app reads it",
    /window\.localStorage\.getItem\("token"\)/.test(CENTER));
  check("no token value is ever logged", !/console\.(log|warn|error)[^;]*token/i.test(CENTER));
  check("no token is hardcoded",
    !/Bearer [A-Za-z0-9._-]{8,}/.test(CENTER) && !/Bearer [A-Za-z0-9._-]{8,}/.test(HOME));
  check("still no businessId is sent from the client",
    !/businessId/.test(CENTER));
}
/**
 * The ordering checks below actually execute, so they need an async entry
 * point. Everything after them lives here too, so the summary cannot print
 * before they have run.
 */
async function main(): Promise<void> {
  /* ── ordering: the bug the browser found, executed for real ───────────────
   *
   * The centre used to hang the read request off a Next <Link>, which navigated
   * first and tore the page down before the POST left. Runtime QA saw navigation
   * happen with no request in the network log and the item still unread.
   *
   * Unlike the rest of this file these are not source scans: the sequencing
   * function actually runs, so the ordering is proven rather than described.
   */
  console.log("\nRead happens before navigation");
  {
    const seq: string[] = [];
    const spy = (name: string, fn: () => Promise<boolean>) => async (): Promise<boolean> => {
      seq.push(name);
      return fn();
    };

    // 1 + 2: unread and linked — read is initiated, awaited, and only then navigation.
    seq.length = 0;
    const okRun = await activateNotification({
      isUnread: true,
      markRead: spy("markRead", async () => true),
      navigate: () => { seq.push("navigate"); },
    });
    check("an unread linked notification marks read before navigating",
      seq.join(">") === "markRead>navigate", seq.join(">"));
    check("the reported order matches what actually ran",
      okRun.order.join(">") === "read:start>read:ok>navigate", okRun.order.join(">"));
    check("it navigates", okRun.navigated === true);
    check("it reports the write landed", okRun.marked === true);

    // 3: already read — no redundant write.
    seq.length = 0;
    const readRun = await activateNotification({
      isUnread: false,
      markRead: spy("markRead", async () => true),
      navigate: () => { seq.push("navigate"); },
    });
    check("an already-read notification writes nothing", !seq.includes("markRead"), seq.join(">"));
    check("it still navigates", readRun.navigated === true && seq.join(">") === "navigate");
    check("no write is reported", readRun.marked === null);

    // 5: a failed write still navigates, and says so rather than claiming success.
    seq.length = 0;
    const failRun = await activateNotification({
      isUnread: true,
      markRead: spy("markRead", async () => false),
      navigate: () => { seq.push("navigate"); },
    });
    check("a failed write does not strand the owner", failRun.navigated === true);
    check("the failure is reported, not swallowed", failRun.marked === false);
    check("the order records the failure", failRun.order.join(">") === "read:start>read:failed>navigate",
      failRun.order.join(">"));

    // The await is real: a slow write must not let navigation overtake it.
    seq.length = 0;
    await activateNotification({
      isUnread: true,
      markRead: async () => { await new Promise((r) => setTimeout(r, 30)); seq.push("markRead"); return true; },
      navigate: () => { seq.push("navigate"); },
    });
    check("navigation waits for a slow write", seq.join(">") === "markRead>navigate", seq.join(">"));
  }

  console.log("\nActivation wiring");
  {
    check("the link no longer fires the write and forgets it",
      !/onClick=\{\(\) => void markRead/.test(CENTER));
    check("the link prevents default and routes itself",
      /e\.preventDefault\(\)/.test(CENTER) && /router\.push\(n\.href\)/.test(CENTER));
    check("activation goes through the sequencing function",
      /void activateNotification\(\{/.test(CENTER));
    check("a modified click is left to the browser",
      /metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/.test(CENTER));
    check("linked cards are still real anchors",
      /<Link/.test(CENTER) && /href=\{n\.href\}/.test(CENTER));
    check("the non-linked card keeps its Enter and Space handling",
      /e\.key === "Enter" \|\| e\.key === " "/.test(CENTER));
    /* Plain string checks, not regexes: the signature is being asserted
     * character for character, and escaping it twice buys nothing. */
    check("markRead reports success or failure to its caller",
      CENTER.includes(
        "const markRead = useCallback(async (id: number, wasUnread: boolean): Promise<boolean>",
      ));

    /* The second runtime run found this one. The read request was never sent
     * at all — not raced, never dispatched — because markRead decided whether
     * to send by reading a flag assigned inside a setItems updater. React does
     * not run that updater synchronously, so the flag was still false one line
     * later and the function returned before the fetch. The caller already
     * knows the answer; it now simply says so. */
    check("markRead does not ask a state updater whether the item was unread",
      !CENTER.includes("let wasUnread = false"));
    check("the unread state is supplied by the caller instead",
      CENTER.includes("markRead(n.id, unread)") &&
        CENTER.includes("markRead(n.id, true)"));

    check("javascript: is still refused", !isSafeInternalHref("javascript:alert(1)"));
    check("an external URL is still refused", !isSafeInternalHref("https://evil.example"));
    check("a protocol-relative URL is still refused", !isSafeInternalHref("//evil.example"));
    check("an internal path still navigates", isSafeInternalHref("/inventory"));
  }
  console.log(
    failures === 0
      ? `\nNOTIFICATION-CENTER: all checks passed\n`
      : `\nNOTIFICATION-CENTER: ${failures} FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);

}

void main();