/**
 * Unit test — the Android app's load-error page (capacitor/www/index.html, issue 4).
 * Runs the page's own script in a vm with stand-ins for window, document, fetch and timers.
 * Run: npx tsx lib/native/android-error-page.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const root = process.cwd();
const html = readFileSync(join(root, "capacitor/www/index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
assert.ok(script.length > 200, "the page carries its script");

type Verdict = "page" | "server" | "offline" | "unknown";
type Evidence = { online: boolean | null; server: boolean | null; internet: boolean | null };
type Api = {
  classify(e: Evidence): Verdict;
  serverOrigin(win: { WEBVIEW_SERVER_URL?: unknown }): string;
  probe(win: unknown, url: string): Promise<boolean>;
  COPY: Record<Verdict, { title: string; msg: string }>;
  PROBE_TIMEOUT_MS: number;
};

type Fake = {
  api: Api;
  els: Record<string, { textContent: string; hidden: boolean; click: () => void }>;
  nav: string[];
  fetches: { url: string; init: Record<string, unknown> }[];
  timers: { fn: () => void; ms: number }[];
  fire: (ev: string) => void;
  settle: () => Promise<void>;
};

/** Load the page script. `answers` decides each fetch: "ok" resolves, "fail" rejects, "hang" never settles. */
function load(opts: { historyLength?: number; online?: boolean | undefined; injected?: unknown; answers?: Record<string, "ok" | "fail" | "hang">; wired?: boolean } = {}): Fake {
  const nav: string[] = [];
  const fetches: Fake["fetches"] = [];
  const timers: Fake["timers"] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const mk = (id: string, text = "") => {
    const handlers: (() => void)[] = [];
    return { id, textContent: text, hidden: id === "back", addEventListener: (_: string, fn: () => void) => handlers.push(fn), click: () => handlers.forEach((h) => h()) };
  };
  const els = { title: mk("title", "לא הצלחנו לטעון את הדף"), msg: mk("msg"), retry: mk("retry"), back: mk("back"), home: mk("home") };
  const win: Record<string, unknown> = {
    WEBVIEW_SERVER_URL: opts.injected,
    navigator: { onLine: opts.online },
    history: { length: opts.historyLength ?? 2, back: () => nav.push("back()"), go: (n: number) => nav.push(`go(${n})`) },
    location: { replace: (u: string) => nav.push(`replace(${u})`), reload: () => nav.push("reload()") },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    addEventListener: (ev: string, fn: () => void) => { (listeners[ev] ??= []).push(fn); },
    fetch: (url: string, init: Record<string, unknown>) => {
      fetches.push({ url, init });
      const host = new URL(url).host;
      const a = opts.answers?.[host] ?? "fail";
      return a === "ok" ? Promise.resolve({ type: "opaque" }) : a === "fail" ? Promise.reject(new TypeError("Failed to fetch")) : new Promise(() => {});
    },
  };
  const document = { getElementById: (id: string) => (opts.wired === false ? null : (els as Record<string, unknown>)[id]) ?? null };
  win.window = win;
  runInNewContext(script, { window: win, document, Date, Promise, URL });
  return {
    api: win.DubizErrorPage as Api,
    els,
    nav,
    fetches,
    timers,
    fire: (ev) => (listeners[ev] ?? []).forEach((f) => f()),
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

async function main() {
  const { api } = load({ wired: false });

  // ── 1. The verdict table: a specific claim only with evidence for it ────────────────────────────
  const rows: [Evidence, Verdict][] = [
    [{ online: true, server: true, internet: true }, "page"],
    [{ online: true, server: true, internet: false }, "page"], // the server answers: the page itself failed
    [{ online: null, server: true, internet: null }, "page"],
    [{ online: true, server: false, internet: true }, "server"], // internet answers, the server does not
    [{ online: false, server: false, internet: true }, "server"],
    [{ online: false, server: false, internet: false }, "offline"], // the device says offline AND nothing answers
    [{ online: true, server: false, internet: false }, "unknown"], // onLine=true proves nothing → no claim
    [{ online: null, server: false, internet: false }, "unknown"],
    [{ online: null, server: null, internet: null }, "unknown"], // no evidence yet
  ];
  for (const [e, want] of rows) assert.equal(api.classify(e), want, JSON.stringify(e));
  // The wording follows the verdict: "no internet" / "system unavailable" only for their own verdicts.
  assert.match(api.COPY.offline.title, /אין חיבור לאינטרנט/);
  assert.match(api.COPY.server.title, /המערכת לא זמינה/);
  for (const k of ["page", "unknown"] as const) assert.doesNotMatch(api.COPY[k].title + api.COPY[k].msg, /אין חיבור לאינטרנט|המערכת לא זמינה/, `${k} claims nothing specific`);
  assert.match(api.COPY.unknown.msg, /ייתכן/, "unknown names possibilities, claims none");
  assert.match(api.COPY.page.msg, /ייתכן/);
  // What shows before any evidence is the careful message (static markup).
  assert.match(html, /<div id="title" class="title">לא הצלחנו לטעון את הדף<\/div>/);
  assert.ok(html.includes(api.COPY.unknown.msg), "the initial message is the unknown one");
  assert.doesNotMatch(html, /אין כרגע חיבור למערכת/, "the old always-'no connection' sentence is gone");

  // ── 2. The server origin ─────────────────────────────────────────────────────────────────────────
  assert.equal(api.serverOrigin({ WEBVIEW_SERVER_URL: "https://promaxgroup.co.il" }), "https://promaxgroup.co.il");
  assert.equal(api.serverOrigin({ WEBVIEW_SERVER_URL: "http://localhost:3000" }), "http://localhost:3000", "debug builds");
  assert.equal(api.serverOrigin({ WEBVIEW_SERVER_URL: "https://localhost" }), "https://promaxgroup.co.il", "the app's own local origin is not the server");
  for (const odd of [undefined, "", "javascript:alert(1)", "https://promaxgroup.co.il/app", "https://a.b/?x", 42]) {
    assert.equal(api.serverOrigin({ WEBVIEW_SERVER_URL: odd }), "https://promaxgroup.co.il", `odd value ${String(odd)}`);
  }

  // ── 3. The probe: any answer = reachable; reject / throw / timeout = not; never throws ───────────
  {
    const f = load({ wired: false, answers: { "promaxgroup.co.il": "ok" } });
    const win = { ...{}, fetch: (u: string, i: Record<string, unknown>) => { f.fetches.push({ url: u, init: i }); return Promise.resolve({ type: "opaque", status: 0 }); }, setTimeout: () => 1, clearTimeout: () => {} };
    assert.equal(await f.api.probe(win, "https://promaxgroup.co.il/api/health"), true, "an opaque answer (any status) counts as reachable");
    const init = f.fetches[0].init;
    assert.equal(init.mode, "no-cors");
    assert.equal(init.cache, "no-store");
    assert.equal(init.credentials, "omit", "no cookie is sent");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.match(f.fetches[0].url, /\/api\/health\?t=\d+$/, "cache-busted");
    assert.equal(await f.api.probe({ fetch: () => Promise.reject(new TypeError("x")), setTimeout: () => 1, clearTimeout: () => {} }, "https://x.test/"), false);
    assert.equal(await f.api.probe({ fetch: () => { throw new Error("blocked"); }, setTimeout: () => 1, clearTimeout: () => {} }, "https://x.test/"), false, "a throwing fetch never breaks the page");
    let fireTimeout: () => void = () => {};
    const hanging = f.api.probe({ fetch: () => new Promise(() => {}), setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, f.api.PROBE_TIMEOUT_MS); fireTimeout = fn; return 1; }, clearTimeout: () => {} }, "https://x.test/");
    fireTimeout();
    assert.equal(await hanging, false, "nothing within the timeout = not reachable");
    assert.ok(f.api.PROBE_TIMEOUT_MS <= 5000, "a short timeout");
  }

  // ── 4. The page end to end: evidence → words; never navigates by itself ─────────────────────────
  const scenario = async (name: string, o: Parameters<typeof load>[0], want: Verdict) => {
    const f = load(o);
    await f.settle();
    assert.equal(f.els.title.textContent, f.api.COPY[want].title, name);
    assert.equal(f.els.msg.textContent, f.api.COPY[want].msg, name);
    assert.deepEqual(f.nav, [], `${name}: no navigation without a tap`);
    assert.equal(f.fetches.length, 2, `${name}: exactly two probes`);
    assert.ok(f.fetches.some((x) => x.url.startsWith("https://promaxgroup.co.il/api/health?")), `${name}: server probe`);
    assert.ok(f.fetches.some((x) => x.url.startsWith("https://connectivitycheck.gstatic.com/generate_204?")), `${name}: connectivity probe`);
    return f;
  };
  await scenario("404/500 (server answers)", { online: true, injected: "https://promaxgroup.co.il", answers: { "promaxgroup.co.il": "ok", "connectivitycheck.gstatic.com": "ok" } }, "page");
  await scenario("server down, internet up", { online: true, answers: { "connectivitycheck.gstatic.com": "ok" } }, "server");
  await scenario("no internet (device offline)", { online: false, answers: {} }, "offline");
  await scenario("onLine=true but nothing answers", { online: true, answers: {} }, "unknown");
  await scenario("onLine unsupported, nothing answers", { online: undefined, answers: {} }, "unknown");

  // Connection comes back: the 'online' event re-checks and updates the words — still no navigation.
  {
    const answers: Record<string, "ok" | "fail" | "hang"> = {};
    const f = load({ online: false, answers });
    await f.settle();
    assert.equal(f.els.title.textContent, f.api.COPY.offline.title);
    answers["promaxgroup.co.il"] = "ok";
    answers["connectivitycheck.gstatic.com"] = "ok";
    f.fire("online");
    await f.settle();
    assert.equal(f.els.title.textContent, f.api.COPY.page.title, "re-checked on 'online'");
    assert.deepEqual(f.nav, [], "the re-check never navigates (no reload loop)");
    assert.equal(f.fetches.length, 4);
    // A check already in flight is not doubled.
    answers["promaxgroup.co.il"] = "hang";
    f.fire("online");
    f.fire("online");
    assert.equal(f.fetches.length, 6, "one probe pair at a time");
  }

  // ── 5. The actions, with and without history ───────────────────────────────────────────────────
  // WebView versions disagree on whether the failed entry stays in history (emulator: 14-16 keep it, 17
  // replaces it), so retry never depends on the stack, and back adapts to its length.
  {
    const f = load({ historyLength: 3 });
    assert.equal(f.els.back.hidden, false, "back is offered with history");
    f.els.retry.click();
    f.els.back.click();
    f.els.home.click();
    assert.deepEqual(f.nav, ["replace(https://promaxgroup.co.il/)", "go(-2)", "replace(https://promaxgroup.co.il/app)"], "failed entry kept under this page → back skips it");
  }
  {
    const f = load({ historyLength: 2 });
    assert.equal(f.els.back.hidden, false);
    f.els.back.click();
    f.els.retry.click();
    assert.deepEqual(f.nav, ["back()", "replace(https://promaxgroup.co.il/)"], "failed entry replaced → back is one step; retry is the start page");
  }
  {
    const f = load({ historyLength: 1 });
    assert.equal(f.els.back.hidden, true, "no history → no 'back'");
    f.els.retry.click();
    f.els.back.click();
    f.els.home.click();
    assert.deepEqual(f.nav, ["replace(https://promaxgroup.co.il/)", "replace(https://promaxgroup.co.il/app)", "replace(https://promaxgroup.co.il/app)"], "no history: every action still leads into the app");
  }
  {
    // Should Capacitor ever inject a server origin into this page, the actions follow it.
    const f = load({ historyLength: 1, injected: "http://localhost:3000" });
    f.els.retry.click();
    assert.deepEqual(f.nav, ["replace(http://localhost:3000/)"]);
  }
  for (const n of [1, 2, 3, 6]) {
    const f = load({ historyLength: n });
    f.els.retry.click(); f.els.back.click(); f.els.home.click();
    assert.ok(!f.nav.includes("reload()"), `never reload() (history ${n})`);
  }
  assert.doesNotMatch(script, /location\.reload\(/, "the script never reloads itself");
  assert.doesNotMatch(script, /setInterval|location\.href\s*=/, "no polling, no automatic navigation");
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);

  // ── 6. The premises in the installed Capacitor (8.5) ──────────────────────────────────────────
  const cap = readFileSync(join(root, "node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/BridgeWebViewClient.java"), "utf8");
  for (const hook of ["onReceivedError", "onReceivedHttpError"]) {
    const body = cap.slice(cap.indexOf(`public void ${hook}(`), cap.indexOf(`public void ${hook}(`) + 900);
    assert.match(body, /errorPath != null && request\.isForMainFrame\(\)\s*\)\s*\{\s*view\.loadUrl\(errorPath\);/, `${hook} shows the error page for main-frame loads only`);
  }
  const config = readFileSync(join(root, "capacitor.config.ts"), "utf8");
  assert.match(config, /errorPath: "index\.html"/, "the app still points errorPath at this page");
  // The page's fallback origin is the Production site the release build loads.
  assert.ok(script.includes(`var PRODUCTION_ORIGIN = "https://promaxgroup.co.il";`));

  console.log("android-error-page: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
