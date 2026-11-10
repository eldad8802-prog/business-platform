/**
 * Email verification in Settings → Security — the pure suite (run manually or in CI):
 *   npx tsx lib/auth/email-verification-client.test.ts
 *
 * No database, no network, no browser. The client module (lib/auth/email-verification-client.ts) is driven
 * against the REAL status / resend / verify route handlers through an in-process fetch, with the database
 * replaced by one mutable account row — so a scenario reads like the person's day:
 *
 *   1. verified / unverified / not asked / verification off → what Settings shows
 *   2. an expired link: the verify route refuses it, nothing is stamped, Settings still offers a new link
 *   3. resend: sent, already verified, limits, server failure, delivery scheduling failure, offline, signed out
 *   4. back from Chrome: the link is opened outside the app, the app returns to the foreground → verified
 *   5. static: no shell-wide notice, nothing blocks, the token / verify / stamp path is untouched
 */

import fs from "node:fs";
import path from "node:path";

process.env.AUTH_TOKEN_SECRET = "a".repeat(64);
process.env.RATE_LIMIT_BACKEND = "memory";

import {
  fetchEmailVerificationView,
  requestVerificationLink,
  watchReturnToScreen,
} from "@/lib/auth/email-verification-client";
import { handleStatus } from "@/app/api/auth/email/status/route";
import { handleResend, type ResendDeps } from "@/app/api/auth/email/resend/route";
import { handleVerify } from "@/app/api/auth/email/verify/route";
import type { VerificationState } from "@/lib/auth/email-tokens";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  - ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

const allow = async () => ({ allowed: true, remaining: 1, resetAt: 0 });
const deny = async () => ({ allowed: false, remaining: 0, resetAt: 0 });
const HEADERS = { authorization: "Bearer synthetic" };

/** One account, as the database would answer for it. */
type Account = {
  enabled: boolean;
  signedIn: boolean;
  state: VerificationState;
  /** What the next link spend yields; "VERIFIED" stamps the row. */
  linkOutcome: "VERIFIED" | "EXPIRED" | "USED" | "SUPERSEDED" | "INVALID";
  resendRate: typeof allow;
  resendThrows: boolean;
  scheduleThrows: boolean;
  scheduled: number[];
};

function account(over: Partial<Account> = {}): Account {
  return {
    enabled: true,
    signedIn: true,
    state: "PENDING",
    linkOutcome: "VERIFIED",
    resendRate: allow,
    resendThrows: false,
    scheduleThrows: false,
    scheduled: [],
    ...over,
  };
}

/** The app's fetch, answered in-process by the real route handlers over `a`. */
function appFetch(a: Account) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const req = new Request(`http://x${url}`, { method: init?.method ?? "GET", headers: { "x-forwarded-for": "203.0.113.9", ...(init?.headers as Record<string, string> | undefined) }, body: init?.body ?? undefined });
    const currentUser = async () => (a.signedIn ? { id: 7 } : null);
    if (url === "/api/auth/email/status") {
      return handleStatus(req, { enabled: () => a.enabled, currentUser, readState: async () => a.state });
    }
    if (url === "/api/auth/email/resend") {
      const deps: ResendDeps = {
        enabled: () => a.enabled,
        currentUser,
        rateLimit: a.resendRate,
        request: async () => {
          if (a.resendThrows) throw new Error("db down");
          if (a.state === "VERIFIED") return { status: "ALREADY_VERIFIED" as const };
          if (a.state === "NOT_REQUIRED") return { status: "NOT_REQUIRED" as const };
          return { status: "SENT" as const, link: { emailId: 41, businessId: 3 } } as never;
        },
        schedule: (id) => {
          if (a.scheduleThrows) throw new Error("queue down");
          a.scheduled.push(id);
        },
      };
      return handleResend(req, deps);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

/** The verification link opened in Chrome: no app session involved — the link is the proof. */
async function openLinkInChrome(a: Account): Promise<Response> {
  const req = new Request("http://x/api/auth/email/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.4" },
    body: JSON.stringify({ token: "synthetic.link" }),
  });
  return handleVerify(req, {
    rateLimit: allow,
    schedule: () => undefined,
    consume: async () => {
      if (a.linkOutcome === "VERIFIED") {
        a.state = "VERIFIED";
        return { status: "VERIFIED" as const, welcomeEmailId: null, businessId: 3 } as never;
      }
      return { status: a.linkOutcome } as never;
    },
  });
}

/** A minimal event target — document / window as the WebView would fire them. */
function target(visibility = "visible") {
  const listeners = new Map<string, Set<() => void>>();
  return {
    visibilityState: visibility,
    addEventListener: (t: string, l: () => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l),
    removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    fire: (t: string) => listeners.get(t)?.forEach((l) => l()),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

const view = async (a: Account) => (await fetchEmailVerificationView(appFetch(a), HEADERS)).kind;
const resend = (a: Account) => requestVerificationLink(appFetch(a), HEADERS);

async function main() {
  // ── 1. what Settings shows ─────────────────────────────────────────────────
  console.log("1. status → Settings");
  ok("verified account → 'האימייל מאומת'", (await view(account({ state: "VERIFIED" }))) === "verified");
  ok("unverified account (opened with verification) → 'האימייל טרם אומת' + resend", (await view(account({ state: "PENDING" }))) === "unverified");
  ok("account never asked to verify → nothing shown", (await view(account({ state: "NOT_REQUIRED" }))) === "hidden");
  ok("verification off here → nothing shown", (await view(account({ enabled: false }))) === "hidden");
  ok("session gone → signedOut (the screen goes to sign-in)", (await view(account({ signedIn: false }))) === "signedOut");
  ok("server error → error (the screen says so, never 'verified')",
    (await fetchEmailVerificationView(async () => new Response("{}", { status: 500 }), HEADERS)).kind === "error");
  ok("network failure → error",
    (await fetchEmailVerificationView(async () => { throw new TypeError("offline"); }, HEADERS)).kind === "error");
  ok("malformed answer → hidden (never a false 'verified')",
    (await fetchEmailVerificationView(async () => new Response("not json", { status: 200 }), HEADERS)).kind === "hidden");

  // ── 2. an expired link ─────────────────────────────────────────────────────
  console.log("2. expired link");
  {
    const a = account({ linkOutcome: "EXPIRED" });
    const res = await openLinkInChrome(a);
    const body = (await res.json()) as { code?: string; error?: string };
    ok("verify route: an expired link → 400 TOKEN_EXPIRED with a message", res.status === 400 && body.code === "TOKEN_EXPIRED" && typeof body.error === "string");
    ok("expired link: nothing is stamped — Settings still says not verified", a.state === "PENDING" && (await view(a)) === "unverified");
    const r = await resend(a);
    ok("expired link: 'send again' issues a new link and schedules it", r.kind === "sent" && JSON.stringify(a.scheduled) === "[41]");
    a.linkOutcome = "VERIFIED";
    ok("the new link verifies", (await openLinkInChrome(a)).status === 200 && (await view(a)) === "verified");
    for (const outcome of ["USED", "SUPERSEDED", "INVALID"] as const) {
      const b = account({ linkOutcome: outcome });
      ok(`verify route: ${outcome} link → 400, nothing stamped`, (await openLinkInChrome(b)).status === 400 && b.state === "PENDING");
    }
  }

  // ── 3. resend outcomes ─────────────────────────────────────────────────────
  console.log("3. resend");
  {
    const a = account();
    const r = await resend(a);
    ok("sent → the server's sentence, delivery scheduled", r.kind === "sent" && !!r.message && JSON.stringify(a.scheduled) === "[41]");
    const already = await resend(account({ state: "VERIFIED" }));
    ok("already verified meanwhile → alreadyVerified (the screen flips to verified)", already.kind === "alreadyVerified");
    ok("not asked to verify → notRequired, nothing sent", (await resend(account({ state: "NOT_REQUIRED" }))).kind === "notRequired");
    const limited = await resend(account({ resendRate: deny }));
    ok("per-user limit (3 / hour) → rateLimited with the server's message", limited.kind === "rateLimited" && !!(limited as { message: string | null }).message);
    const off = await resend(account({ enabled: false }));
    ok("verification turned off → unavailable", off.kind === "unavailable");
    const broken = await resend(account({ resendThrows: true }));
    ok("server failure while issuing → failed with a message (no crash, no false 'sent')", broken.kind === "failed" && !!(broken as { message: string | null }).message);
    const q = account({ scheduleThrows: true });
    const queued = await resend(q);
    ok("delivery scheduling fails → still 'sent' (the link exists; the sweep delivers it), nothing thrown", queued.kind === "sent" && q.scheduled.length === 0);
    ok("offline → offline", (await requestVerificationLink(async () => { throw new TypeError("offline"); }, HEADERS)).kind === "offline");
    ok("signed out → signedOut", (await resend(account({ signedIn: false }))).kind === "signedOut");
    ok("database ceiling (429 RATE_LIMITED) → rateLimited",
      (await requestVerificationLink(async () => new Response(JSON.stringify({ error: "x", code: "RATE_LIMITED" }), { status: 429 }), HEADERS)).kind === "rateLimited");
    ok("an unexpected 5xx without a body → failed with no message (the screen uses its own text)",
      (await requestVerificationLink(async () => new Response("", { status: 502 }), HEADERS)).kind === "failed");
  }

  // ── 4. back from Chrome ────────────────────────────────────────────────────
  console.log("4. back from Chrome");
  {
    const a = account();
    const doc = target("visible");
    const win = target();
    let clock = 0;
    let shown = await view(a);
    let refreshes = 0;
    const stop = watchReturnToScreen({ document: doc, window: win }, () => {
      refreshes += 1;
      void view(a).then((k) => { shown = k; });
    }, { now: () => clock });
    ok("before: Settings shows not verified", shown === "unverified");

    // The owner taps the link in Gmail → Chrome opens /verify-email; the app goes to the background.
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    ok("going to the background reads nothing", refreshes === 0);
    ok("the link verifies in Chrome without the app's session", (await openLinkInChrome(a)).status === 200);

    // Back to the app: Android WebView fires visibilitychange (and often focus) on resume.
    clock = 5_000;
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    win.fire("focus");
    win.fire("pageshow");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    ok("return to the app: one read for the burst of resume events", refreshes === 1);
    ok("return to the app: Settings now shows verified — no reload, no restart", shown === "verified");

    clock = 10_000;
    win.fire("focus");
    ok("a later return reads again (desktop tab focus)", refreshes === 2);
    stop();
    ok("unsubscribe removes every listener", doc.count() === 0 && win.count() === 0);
    clock = 20_000;
    doc.fire("visibilitychange");
    ok("after unsubscribe nothing is read", refreshes === 2);
  }

  // ── 5. static ──────────────────────────────────────────────────────────────
  console.log("5. static");
  {
    const root = process.cwd();
    const src = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
    const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const layout = code("app/(shell)/layout.tsx");
    ok("shell: no verification notice above the screens", !/EmailVerification|verify-banner|email\/status|topSlot/.test(layout));
    ok("shell: the rest of the layout is intact (refresh coordinator, reminders, stale-client reload)",
      ["<RefreshCoordinator>", "<ShellChrome>", "<ReminderCenter />", "<StaleClientReload />"].every((s) => layout.includes(s)));
    ok("shell: the banner component is gone and nothing imports it",
      !fs.existsSync(path.join(root, "components/auth/email-verification-banner.tsx")));
    const page = code("app/settings/security/page.tsx");
    ok("settings → security: email status next to Google and devices (both still there)",
      page.includes("<EmailVerificationStatus />") && page.includes("<GoogleConnection") && page.includes("<DevicesScreen />"));
    const comp = code("components/settings/security/email-verification-status.tsx");
    ok("component: reads the state again when the screen returns, until verified", /watchReturnToScreen\(/.test(comp) && /if \(settled\) return;/.test(comp));
    ok("component: never hides the state by itself (no storage switch, no dismiss)", !/sessionStorage|localStorage|dismiss|hide\(/.test(comp));
    ok("component: no blocking — the only navigation is to sign-in on 401", (comp.match(/redirectToLogin\(\)/g) ?? []).length === 2 && !/router\.(push|replace)|location\.(href|assign|replace)/.test(comp));
    const client = code("lib/auth/email-verification-client.ts");
    ok("client: talks only to the existing status / resend routes", /"\/api\/auth\/email\/status"/.test(client) && /"\/api\/auth\/email\/resend"/.test(client) && !/\/verify"/.test(client));
    ok("client: never decides 'verified' without the server saying so", /if \(d\.verified === true\) return \{ kind: "verified" \}/.test(client));
    ok("unchanged: the token / verify / stamp path has no new caller here",
      !/consumeEmailVerification|issueAccountLink|auth_email_verify_consume|emailVerifiedAt/.test(client + comp));
    ok("no gate: nothing outside settings reads the verification status",
      !/\/api\/auth\/email\/status/.test(code("components/navigation/shell-chrome.tsx")) && !/\/api\/auth\/email\/status/.test(code("app/login/login-form.tsx")));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
