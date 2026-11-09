/**
 * Unit test — Android <= 14 status bar overlay (issue 2, real-device follow-up).
 * Run: npx tsx lib/native/android-status-bar.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANDROID_STATUS_BAR_COLOR, placeAndroidWebViewBelowStatusBar } from "@/lib/native/native-shell";

type Call = [string, unknown];

function fakeStatusBar(calls: Call[]) {
  return {
    setOverlaysWebView: async (o: unknown) => void calls.push(["setOverlaysWebView", o]),
    setBackgroundColor: async (o: unknown) => void calls.push(["setBackgroundColor", o]),
  } as unknown as Parameters<typeof placeAndroidWebViewBelowStatusBar>[0];
}

function fakeMatchMedia(matches: boolean) {
  const mq = { matches, listener: null as null | (() => void), addEventListener: (_: string, fn: () => void) => { mq.listener = fn; } };
  (globalThis as { window?: unknown }).window = { matchMedia: () => mq };
  return mq;
}

async function main() {
  // Light mode: overlay off FIRST (it restores the plugin's black bar), then the light colour.
  {
    const calls: Call[] = [];
    const mq = fakeMatchMedia(false);
    await placeAndroidWebViewBelowStatusBar(fakeStatusBar(calls));
    assert.deepEqual(calls, [
      ["setOverlaysWebView", { overlay: false }],
      ["setBackgroundColor", { color: ANDROID_STATUS_BAR_COLOR.light }],
    ]);
    // The system switches to dark while the app is open → the bar follows.
    mq.matches = true;
    mq.listener?.();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls[2], ["setBackgroundColor", { color: ANDROID_STATUS_BAR_COLOR.dark }]);
  }

  // Dark mode at launch.
  {
    const calls: Call[] = [];
    fakeMatchMedia(true);
    await placeAndroidWebViewBelowStatusBar(fakeStatusBar(calls));
    assert.deepEqual(calls[1], ["setBackgroundColor", { color: ANDROID_STATUS_BAR_COLOR.dark }]);
  }

  // No matchMedia (very old WebView): still turns the overlay off and paints the light bar.
  {
    const calls: Call[] = [];
    (globalThis as { window?: unknown }).window = {};
    await placeAndroidWebViewBelowStatusBar(fakeStatusBar(calls));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], ["setOverlaysWebView", { overlay: false }]);
  }

  const root = process.cwd();
  // Wired into the shell init for Android only; iOS keeps its overlay (cover + contentInset).
  const shell = readFileSync(join(root, "lib/native/native-shell.ts"), "utf8");
  assert.match(shell, /if \(Capacitor\.getPlatform\(\) === "android"\) await placeAndroidWebViewBelowStatusBar\(StatusBar\)/);

  // The premises, in the installed plugin (same 8.0.3 the Google Play binary ships):
  const sb = (f: string) =>
    readFileSync(join(root, "node_modules/@capacitor/status-bar/android/src/main/java/com/capacitorjs/plugins/statusbar", f), "utf8");
  // overlaysWebView defaults to true and the app config does not override it — the cause on Android <= 14;
  assert.match(sb("StatusBarConfig.java"), /private boolean overlaysWebView = true;/, "status-bar plugin overlays by default");
  const cap = readFileSync(join(root, "capacitor.config.ts"), "utf8");
  assert.doesNotMatch(cap, /overlaysWebView/, "config does not set overlaysWebView (the native fix waits for the consolidated release)");
  const impl = sb("StatusBar.java");
  // setOverlaysWebView(false) clears the fullscreen layout flags;
  assert.match(impl, /uiOptions & ~getSystemUiFlagLayoutStableDeprecated\(\) & ~getSystemUiFlagLayoutFullscreenDeprecated\(\)/);
  // the bar colour is only applied below Android 15 — the plugin gates it, the app does not detect versions.
  assert.match(impl, /if \(deviceApi < Build\.VERSION_CODES\.VANILLA_ICE_CREAM\) \{\s*\/\/[^\n]*\n\s*canSetStatusBar = true;/);
  assert.match(impl, /\} else \{\s*canSetStatusBar = false;/);

  console.log("android-status-bar: all assertions passed");
}

void main();
