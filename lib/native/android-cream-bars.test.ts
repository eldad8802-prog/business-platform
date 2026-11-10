/**
 * Unit test — cream system bars with dark icons in the consolidated Android build (light and dark mode).
 * Run: npx tsx lib/native/android-cream-bars.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_CREAM_BAR_COLOR,
  ANDROID_CREAM_BARS_MIN_BUILD,
  androidHasCreamBars,
  paintAndroidCreamBars,
} from "@/lib/native/native-shell";
import { ANDROID_BAR_COLOR, isAndroidCapBuild } from "@/capacitor.config";

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), "utf8");

async function main() {
  // ── 1. Which build carries the cream bars: App.getInfo().build is the versionCode ──────────────────
  const app = (build: unknown) => ({ getInfo: async () => ({ build: build as string }) });
  assert.equal(ANDROID_CREAM_BARS_MIN_BUILD, 2, "the Play build today is versionCode 1");
  for (const [build, want] of [
    ["1", false], // the Google Play build installed today
    ["2", true], // the consolidated release (#1027 proposes 2)
    ["3", true], // …or any later number Play accepts (versionCode only grows)
    ["10", true],
    ["2147483647", true],
    [" 2 ", true],
    ["0", false],
    ["", false],
    ["1.0.1", false], // a versionName, not a code
    ["2a", false],
    ["-5", false],
    [undefined, false],
    [null, false],
    [2, true], // a number instead of a string is read the same way
  ] as const) {
    assert.equal(await androidHasCreamBars(app(build)), want, `build ${JSON.stringify(build)}`);
  }
  assert.equal(await androidHasCreamBars({ getInfo: async () => { throw new Error("no plugin"); } }), false, "an unreadable build keeps today's behaviour");

  // ── 2. A build with the cream bars: dark icons on cream, in both modes, no repaint by theme ──────
  {
    const calls: [string, unknown][] = [];
    const sb = {
      setStyle: async (o: unknown) => void calls.push(["setStyle", o]),
      setOverlaysWebView: async (o: unknown) => void calls.push(["setOverlaysWebView", o]),
      setBackgroundColor: async (o: unknown) => void calls.push(["setBackgroundColor", o]),
    } as unknown as Parameters<typeof paintAndroidCreamBars>[0];
    const Style = { Light: "LIGHT", Dark: "DARK", Default: "DEFAULT" } as unknown as Parameters<typeof paintAndroidCreamBars>[1];
    let matchMediaCalls = 0;
    (globalThis as { window?: unknown }).window = { matchMedia: () => { matchMediaCalls++; return { matches: true, addEventListener() {} }; } };
    await paintAndroidCreamBars(sb, Style);
    assert.deepEqual(calls, [
      ["setStyle", { style: "LIGHT" }],
      ["setOverlaysWebView", { overlay: false }],
      ["setBackgroundColor", { color: "#FEF8F2" }],
    ]);
    assert.equal(matchMediaCalls, 0, "the cream build does not follow dark mode");
  }

  // ── 3. The shell picks the path by build; the old path is unchanged ────────────────────────────────
  const shell = read("lib/native/native-shell.ts");
  assert.match(shell, /if \(android && \(await androidHasCreamBars\(\)\)\) \{\s*\/\/[^\n]*\n\s*await paintAndroidCreamBars\(StatusBar, Style\);\s*\} else \{/);
  assert.match(shell, /await StatusBar\.setStyle\(\{ style: android \? Style\.Default : Style\.Light \}\);\s*if \(android\) await placeAndroidWebViewBelowStatusBar\(StatusBar\);/, "older builds and iOS: exactly the previous calls");
  assert.match(shell, /export const ANDROID_STATUS_BAR_COLOR = \{ light: "#FAFAFA", dark: "#303030" \} as const;/, "older builds keep their colours");

  // ── 4. One cream everywhere ─────────────────────────────────────────────────────────────────────
  const colors = read("android/app/src/main/res/values/colors.xml");
  assert.match(colors, /<color name="dubizAppBackground">#FEF8F2<\/color>/);
  assert.equal(ANDROID_CREAM_BAR_COLOR, "#FEF8F2");
  assert.equal(ANDROID_BAR_COLOR, "#FEF8F2");
  assert.match(read("capacitor.config.ts"), /backgroundColor: "#FEF8F2",\s*\},\s*plugins:/, "the WebView background was already this cream");

  // ── 5. The native theme: cream bars and window, dark icons, light AND dark mode ────────────────
  const styles = read("android/app/src/main/res/values/styles.xml");
  const theme = styles.match(/<style name="AppTheme\.NoActionBar"[\s\S]*?<\/style>/)?.[0] ?? "";
  for (const item of ["android:windowBackground", "android:statusBarColor", "android:navigationBarColor"]) {
    assert.match(theme, new RegExp(`<item name="${item}">@color/dubizAppBackground</item>`), item);
  }
  assert.match(theme, /<item name="android:windowLightStatusBar">true<\/item>/);
  assert.match(theme, /<item name="android:windowLightNavigationBar" tools:targetApi="27">true<\/item>/, "API 27+ attribute, minSdk 24");
  assert.match(styles, /<resources xmlns:tools="http:\/\/schemas\.android\.com\/tools">/);
  // The same values in dark mode: there is no values-night override of this theme.
  const res = join(root, "android/app/src/main/res");
  const { readdirSync, existsSync } = await import("node:fs");
  const nightDirs = readdirSync(res).filter((d) => /^values-.*night/.test(d));
  for (const d of nightDirs) assert.ok(!existsSync(join(res, d, "styles.xml")) || !/AppTheme\.NoActionBar/.test(read(`android/app/src/main/res/${d}/styles.xml`)), `${d} does not override the theme`);
  // The launch theme still hands over to this theme.
  assert.match(styles, /<item name="postSplashScreenTheme">@style\/AppTheme\.NoActionBar<\/item>/);

  // ── 6. capacitor.config.ts: the Android-only settings never reach iOS ──────────────────────────
  for (const [argv, want] of [
    [["node", "cap", "sync", "android"], true],
    [["node", "cap", "copy", "android"], true],
    [["node", "cap", "run", "android"], true],
    [["node", "cap", "update", "android"], true],
    [["node", "cap", "sync", "ios"], false],
    [["node", "cap", "sync"], false], // platform unknown → nothing added (iOS safe, Android as today)
    [["node", "cap", "sync", "android", "ios"], false],
    [["node", "next", "build"], false],
  ] as const) {
    assert.equal(isAndroidCapBuild(argv), want, argv.join(" "));
  }
  const cap = read("capacitor.config.ts");
  assert.match(cap, /SystemBars: \{\s*insetsHandling: "css",\s*\.\.\.\(androidBars \? \{ style: "LIGHT" \} : \{\}\),\s*\}/, "SystemBars keeps dark icons on configuration changes (Android only)");
  assert.match(cap, /StatusBar: \{\s*style: "LIGHT",\s*\.\.\.\(androidBars \? \{ overlaysWebView: false, backgroundColor: ANDROID_BAR_COLOR \} : \{\}\),\s*\}/, "overlay off + cream (Android only)");
  assert.doesNotMatch(cap, /url: "https?:\/\/(?!promaxgroup)/, "no hard-coded server URL");
  assert.match(cap, /\.\.\.\(serverUrl \? \{ url: serverUrl \} : \{\}\)/, "server.url unchanged (CAP_SERVER_URL at build time)");

  // ── 7. The native premises (installed plugins) ─────────────────────────────────────────────────
  const sbConfig = read("node_modules/@capacitor/status-bar/android/src/main/java/com/capacitorjs/plugins/statusbar/StatusBarPlugin.java");
  assert.match(sbConfig, /config\.setOverlaysWebView\(getConfig\(\)\.getBoolean\("overlaysWebView", config\.isOverlaysWebView\(\)\)\)/, "the plugin reads overlaysWebView from config");
  const systemBars = read("node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java");
  assert.match(systemBars, /protected void handleOnConfigurationChanged\(Configuration newConfig\) \{[\s\S]*?setStyle\(currentStatusBarStyle, BAR_STATUS_BAR\);/, "SystemBars re-applies its style on configuration changes");
  assert.match(systemBars, /String style = getConfig\(\)\.getString\("style", STYLE_DEFAULT\)/, "SystemBars reads its style from config");
  const appPlugin = read("node_modules/@capacitor/app/android/src/main/java/com/capacitorjs/plugins/app/AppPlugin.java");
  assert.match(appPlugin, /data\.put\("build", Integer\.toString\(\(int\) PackageInfoCompat\.getLongVersionCode\(pinfo\)\)\);/, "App.getInfo().build is the versionCode");
  assert.match(read("android/app/build.gradle"), /versionCode \d+/);

  console.log("android-cream-bars: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
