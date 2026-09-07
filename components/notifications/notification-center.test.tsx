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

import { isSafeInternalHref, relativeTime, severityStyle } from "./notification-center";

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

console.log(
  failures === 0
    ? `\nNOTIFICATION-CENTER: all checks passed\n`
    : `\nNOTIFICATION-CENTER: ${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
