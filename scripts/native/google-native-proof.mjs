// DIAGNOSTIC ONLY (branch diag/android-google-native) — drives the Google-in-app transport proof on a
// real emulator: real Capacitor WebView, real Custom Tab (Chrome), real Android intents. Taps in the
// Custom Tab are real (uiautomator + adb input). Scenarios: warm round trip; app process killed while
// the Custom Tab is open (cold return); replay; no cookie (another client / wrong app).
// usage: node scripts/native/google-native-proof.mjs <outDir>
import { _android as android } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const PKG = "il.co.promaxgroup.dubiz";
mkdirSync(join(OUT, "shots"), { recursive: true });
const results = [];
const log = (o) => { results.push(o); writeFileSync(join(OUT, "proof.json"), JSON.stringify(results, null, 1)); console.log(JSON.stringify(o).slice(0, 700)); };
const adb = (...a) => { try { return execFileSync("adb", a, { timeout: 30000, maxBuffer: 64 << 20 }).toString(); } catch (e) { return `ERR ${e.message}`; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [device] = await android.devices();
const shot = async (n) => writeFileSync(join(OUT, "shots", `${n}.png`), await device.screenshot());
const focus = () => adb("shell", "dumpsys", "window").match(/mCurrentFocus=Window\{[^}]*\s(\S+)\}/)?.[1] || "?";
const pid = () => adb("shell", "pidof", PKG).trim();
// Tap a visible text in whatever is on screen (Custom Tab / app) — real input.
const tapText = async (re, tries = 12) => {
  for (let i = 0; i < tries; i++) {
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
    const x = adb("shell", "cat", "/sdcard/ui.xml");
    for (const m of x.matchAll(/<node [^>]*?(?:text|content-desc)="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
      if (re.test(m[1])) { const cx = (+m[2] + +m[4]) >> 1, cy = (+m[3] + +m[5]) >> 1; adb("shell", "input", "tap", String(cx), String(cy)); return m[1]; }
    }
    await sleep(1500);
  }
  return null;
};
const sockets = () => adb("shell", "cat", "/proc/net/unix").split("\n").filter((l) => /devtools/.test(l)).map((l) => l.trim().split(/\s+/).pop()).join(" ");
const webview = async () => {
  for (let i = 0; i < 3; i++) {
    try { return await device.webView({ pkg: PKG }, { timeout: 25000 }); }
    catch (e) { log({ note: "webview not found yet", attempt: i + 1, pid: pid(), focus: focus(), sockets: sockets() }); if (i === 1) { adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`); await sleep(6000); } }
  }
  throw new Error("webview never appeared");
};
const proofText = async () => { const wv = await webview(); const p = await wv.page(); await p.waitForTimeout(2500); return p.evaluate(() => ({ path: location.pathname + location.hash, proof: window.__proof || [], status: document.getElementById("s")?.textContent })); };
const launch = async () => { adb("shell", "am", "force-stop", PKG); await sleep(1500); adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`); await sleep(8000); };
// Chrome's first-run screens can show inside the Custom Tab on a fresh emulator: tap through them.
const passChromeFirstRun = async () => {
  for (let i = 0; i < 8; i++) {
    if (!/chrome/.test(focus())) return;
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
    if (/Continue as test user/.test(adb("shell", "cat", "/sdcard/ui.xml"))) return;
    const t = await tapText(/^(Use without an account|Accept & continue|Accept &amp; continue|No thanks|No, thanks|Continue|Got it|Skip|Not now|OK)$/i, 2);
    log({ note: "chrome first-run", tapped: t, focus: focus() });
    await sleep(2500);
  }
};
const startFlow = async () => { const wv = await webview(); const p = await wv.page(); await p.waitForTimeout(1500); await p.click("#g"); await sleep(5000); await passChromeFirstRun(); };

// Chrome without first-run screens (debug-app command line), as in the earlier issue-2 harness.
adb("shell", "am", "set-debug-app", "--persistent", "com.android.chrome");
adb("shell", "sh", "-c", "echo 'chrome --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line");
log({ check: "env", sdk: adb("shell", "getprop", "ro.build.version.sdk").trim() });

// S1 — warm round trip.
try {
  adb("shell", "pm", "clear", PKG); await sleep(1000);
  await launch();
  await startFlow();
  const f1 = focus();
  await shot("s1-1-custom-tab");
  const t1 = await tapText(/Continue as test user/);
  await sleep(4000);
  await shot("s1-2-return-in-browser");
  const t2 = await tapText(/חזרה לאפליקציה/);
  await sleep(6000);
  const r = await proofText();
  await shot("s1-3-back-in-app");
  log({ check: "S1-warm", focusAfterStart: f1, tappedContinue: !!t1, tappedBack: !!t2, focusAtEnd: focus(), ...r });
} catch (e) { log({ check: "S1-warm", error: String(e).slice(0, 200) }); }

// S2 — the app process dies while the Custom Tab is open; the return cold-starts the app.
try {
  await launch();
  await startFlow();
  const before = pid();
  adb("shell", "am", "kill", PKG); // kills the (background) app process; the Custom Tab lives in Chrome
  await sleep(2000);
  const after = pid();
  await shot("s2-1-app-killed-tab-open");
  const t1 = await tapText(/Continue as test user/);
  await sleep(4000);
  const t2 = await tapText(/חזרה לאפליקציה/);
  await sleep(12000);
  const r = await proofText();
  await shot("s2-2-cold-return");
  log({ check: "S2-killed-mid-flow", pidBefore: before, pidAfterKill: after || "(dead)", pidAtEnd: pid(), tappedContinue: !!t1, tappedBack: !!t2, ...r });
} catch (e) { log({ check: "S2-killed-mid-flow", error: String(e).slice(0, 200) }); }

// S3 — a code presented by another client (no WebView cookie): e.g. a code that reached the wrong app.
try {
  const page = execFileSync("curl", ["-s", "http://localhost:3000/fake-google?state=foreign"]).toString();
  const code = page.match(/code=([^&"]+)/)[1];
  const r = execFileSync("curl", ["-s", "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify({ code, state: "foreign" }), "http://localhost:3000/native/complete"]).toString();
  log({ check: "S3-no-cookie-client", response: JSON.parse(r) });
} catch (e) { log({ check: "S3-no-cookie-client", error: String(e).slice(0, 200) }); }

// Log audit: which requests ever carried a code, and from where.
const lines = readFileSync(join(OUT, "proof-server.log"), "utf8").split("\n").filter(Boolean);
log({
  check: "log-audit",
  requestsWithCodeInUrl: lines.filter((l) => / REQ /.test(l) && /code=/.test(l)).map((l) => l.replace(/code=[^&\s#]+/, "code=<…>").replace(/state=[^&\s#]+/, "state=<…>").slice(25)),
  webviewRequestsWithCode: lines.filter((l) => / REQ WEBVIEW /.test(l) && /code=/.test(l)).length,
  completeVerdicts: lines.filter((l) => / COMPLETE /.test(l)).map((l) => l.slice(25)),
});
await device.close();
