/**
 * Unit test — Android shell status bar below the WebView on Android 14 and older (issue 2, part 2).
 * Run: npx tsx lib/native/android-status-bar.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  ANDROID_SHELL_STATUS_BAR_SCRIPT,
  ANDROID_STATUS_BAR_COLOR,
  placeAndroidStatusBarBelow,
} from "@/lib/native/android-status-bar";

type Call = { plugin: string; method: string; options: unknown };

function runInline(window: Record<string, unknown>) {
  runInNewContext(ANDROID_SHELL_STATUS_BAR_SCRIPT, { window, Promise });
}

function shell(nativePromise: (plugin: string, method: string, options: unknown) => unknown) {
  return { CapacitorSystemBarsAndroidInterface: { onDOMReady() {} }, Capacitor: { nativePromise } } as Record<string, unknown>;
}

function fakeStatusBar(color: string, calls: string[], opts: { failSetters?: boolean; failInfo?: boolean } = {}) {
  return {
    async setOverlaysWebView(o: { overlay: boolean }) {
      calls.push(`setOverlaysWebView:${o.overlay}`);
      if (opts.failSetters) throw new Error("not implemented");
    },
    async setBackgroundColor(o: { color: string }) {
      calls.push(`setBackgroundColor:${o.color}`);
      if (opts.failSetters) throw new Error("not implemented");
    },
    async getInfo() {
      calls.push("getInfo");
      if (opts.failInfo) throw new Error("boom");
      return { color };
    },
  };
}

async function main() {
  // ── Inline script ────────────────────────────────────────────────────────────
  {
    // Android shell: overlay off, then the cream bar — once, through the bridge Capacitor injects at document start.
    const calls: Call[] = [];
    const win = shell((plugin, method, options) => {
      calls.push({ plugin, method, options });
      return Promise.resolve();
    });
    runInline(win);
    // The script builds its option objects in the vm realm: compare their JSON, not their prototypes.
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      { plugin: "StatusBar", method: "setOverlaysWebView", options: { overlay: false } },
      { plugin: "StatusBar", method: "setBackgroundColor", options: { color: ANDROID_STATUS_BAR_COLOR } },
    ]);
    assert.ok(win.__dzStatusBarBelow instanceof Promise, "leaves its promise for initNativeShell");
    runInline(win);
    assert.equal(calls.length, 2, "never runs twice in one document");
  }
  {
    // iPhone, iOS shell and browsers: no SystemBars Android interface → nothing called, no flag.
    const calls: Call[] = [];
    const win = { Capacitor: { nativePromise: (...a: unknown[]) => calls.push(a as unknown as Call) } } as Record<string, unknown>;
    runInline(win);
    assert.equal(calls.length, 0);
    assert.equal(win.__dzStatusBarBelow, undefined);
    const bare: Record<string, unknown> = {};
    runInline(bare);
    assert.equal(bare.__dzStatusBarBelow, undefined);
  }
  {
    // Android shell without the bridge yet: no flag, so initNativeShell makes the calls itself.
    const win = { CapacitorSystemBarsAndroidInterface: {} } as Record<string, unknown>;
    runInline(win);
    assert.equal(win.__dzStatusBarBelow, undefined);
  }
  {
    // A missing plugin (rejection) or a throwing bridge never breaks the page or leaves an unhandled rejection.
    let unhandled = 0;
    const onUnhandled = () => unhandled++;
    process.on("unhandledRejection", onUnhandled);
    const rejecting = shell(() => Promise.reject(new Error('"StatusBar" plugin is not implemented on android')));
    runInline(rejecting);
    await rejecting.__dzStatusBarBelow;
    const throwing = shell(() => {
      throw new Error("bridge gone");
    });
    assert.doesNotThrow(() => runInline(throwing));
    await throwing.__dzStatusBarBelow;
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    assert.equal(unhandled, 0, "no unhandled rejection");
  }

  // ── initNativeShell backstop ────────────────────────────────────────────────
  {
    // The inline script already ran: no second native call, and the bar is read only after its calls resolved.
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const result = placeAndroidStatusBarBelow(fakeStatusBar("#FEF8F2", calls), { __dzStatusBarBelow: pending });
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(calls, [], "getInfo waits for the inline calls (setters run on the main thread, getInfo does not)");
    release();
    assert.equal(await result, true, "cream bar (Android 14 and older)");
    assert.deepEqual(calls, ["getInfo"], "no setter called twice");
  }
  {
    // Documents where the inline script never ran: the backstop makes both calls, once.
    const calls: string[] = [];
    const win: { __dzStatusBarBelow?: Promise<unknown> } = {};
    assert.equal(await placeAndroidStatusBarBelow(fakeStatusBar("#FEF8F2", calls), win), true);
    assert.deepEqual(calls, ["setOverlaysWebView:false", `setBackgroundColor:${ANDROID_STATUS_BAR_COLOR}`, "getInfo"]);
    await placeAndroidStatusBarBelow(fakeStatusBar("#FEF8F2", calls), win);
    assert.equal(calls.filter((c) => c.startsWith("set")).length, 2, "setters never repeat in one document");
  }
  {
    // Android 15+: the plugin leaves the bar colour alone → not cream → system-following icons.
    const calls: string[] = [];
    assert.equal(await placeAndroidStatusBarBelow(fakeStatusBar("#000000", calls), {}), false);
    // Failures: setters rejecting or getInfo throwing never throw out of the backstop.
    assert.equal(await placeAndroidStatusBarBelow(fakeStatusBar("#FEF8F2", [], { failSetters: true }), {}), true);
    assert.equal(await placeAndroidStatusBarBelow(fakeStatusBar("#FEF8F2", [], { failInfo: true }), {}), false);
    // Lower-case colour report still recognised.
    assert.equal(await placeAndroidStatusBarBelow(fakeStatusBar("#fef8f2", []), {}), true);
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  const root = process.cwd();
  const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
  assert.match(layout, /__html:\s*ANDROID_SHELL_VIEWPORT_SCRIPT\s*\+\s*ANDROID_SHELL_STATUS_BAR_SCRIPT/, "root layout ships the status-bar script inline");
  const nativeShell = readFileSync(join(root, "lib/native/native-shell.ts"), "utf8");
  assert.match(nativeShell, /placeAndroidStatusBarBelow\(StatusBar\)/, "initNativeShell runs the backstop on Android");
  assert.match(nativeShell, /creamBar \? Style\.Light : Style\.Default/, "dark icons on the cream bar, system-following on 15+");

  // ── Premises in the installed native code (a Capacitor upgrade that changes one fails here) ──
  const read = (p: string) => readFileSync(join(root, "node_modules", p), "utf8");
  const sbConfig = read("@capacitor/status-bar/android/src/main/java/com/capacitorjs/plugins/statusbar/StatusBarConfig.java");
  assert.ok(sbConfig.includes("private boolean overlaysWebView = true;"), "StatusBar overlays the WebView by default");
  assert.ok(sbConfig.includes('WebColor.parseColor("#000000")'), "the bar colour restored by overlay off defaults to black");
  const sb = read("@capacitor/status-bar/android/src/main/java/com/capacitorjs/plugins/statusbar/StatusBar.java");
  assert.ok(/~getSystemUiFlagLayoutFullscreenDeprecated\(\)/.test(sb), "overlay off clears the fullscreen layout flag");
  assert.ok(/deviceApi < Build\.VERSION_CODES\.VANILLA_ICE_CREAM\)\s*\{[^}]*canSetStatusBar = true/.test(sb), "the plugin paints the bar only below Android 15 (or with the opt-out)");
  assert.ok(sb.includes('String.format("#%06X"'), "getInfo reports the colour as #RRGGBB");
  const systemBars = read("@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java");
  assert.ok(/if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.VANILLA_ICE_CREAM\) \{\s*\/\/ We need to correct for a possible shown IME\s*v\.setPadding\(\s*systemBarsInsets\.left/.test(systemBars), "SystemBars pads only on Android 15+");
  const bridgeJs = read("@capacitor/android/capacitor/src/main/assets/native-bridge.js");
  assert.ok(bridgeJs.includes("cap.nativePromise = (pluginName, methodName, options) =>"), "the injected bridge exposes nativePromise");
  const bridge = read("@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java");
  assert.ok(bridge.includes("addDocumentStartJavaScript"), "the bridge is injected at document start");

  console.log("android-status-bar: all assertions passed");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
