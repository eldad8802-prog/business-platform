/**
 * Unit test — Android shell viewport switch (issue 2, status-bar overlap).
 * Run: npx tsx lib/native/android-viewport-fit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ANDROID_SHELL_VIEWPORT_SCRIPT } from "@/lib/native/android-viewport-fit";

type FakeMeta = { content: string; getAttribute(n: string): string; setAttribute(n: string, v: string): void };

function run(contents: string[], androidShell: boolean): string[] {
  const metas: FakeMeta[] = contents.map((content) => ({
    content,
    getAttribute() {
      return this.content;
    },
    setAttribute(_n: string, v: string) {
      this.content = v;
    },
  }));
  const window: Record<string, unknown> = {};
  if (androidShell) window.CapacitorSystemBarsAndroidInterface = { onDOMReady() {} };
  const document = { querySelectorAll: () => metas };
  runInNewContext(ANDROID_SHELL_VIEWPORT_SCRIPT, { window, document });
  return metas.map((m) => m.content);
}

function main() {
  const NEXT = "width=device-width, initial-scale=1, viewport-fit=cover";

  // Android shell: cover is dropped, everything else kept.
  assert.deepEqual(run([NEXT], true), ["width=device-width, initial-scale=1"]);
  assert.deepEqual(run(["viewport-fit=cover, width=device-width"], true), ["width=device-width"]);
  assert.deepEqual(run(["width=device-width,viewport-fit=cover,initial-scale=1"], true), ["width=device-width,initial-scale=1"]);
  // Capacitor reads the LAST viewport meta — every one is normalised.
  assert.deepEqual(run([NEXT, NEXT], true), ["width=device-width, initial-scale=1", "width=device-width, initial-scale=1"]);
  // No cover → untouched.
  assert.deepEqual(run(["width=device-width, initial-scale=1"], true), ["width=device-width, initial-scale=1"]);

  // iPhone / iOS shell / browsers: no SystemBars Android interface → untouched.
  assert.deepEqual(run([NEXT], false), [NEXT]);

  // A throwing DOM never breaks the page.
  assert.doesNotThrow(() =>
    runInNewContext(ANDROID_SHELL_VIEWPORT_SCRIPT, {
      window: { CapacitorSystemBarsAndroidInterface: {} },
      document: { querySelectorAll: () => { throw new Error("boom"); } },
    })
  );

  const root = process.cwd();
  // The root layout still declares cover (iPhone needs it) and ships the script.
  const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
  assert.match(layout, /viewportFit:\s*"cover"/, "root viewport keeps viewport-fit=cover for iOS");
  assert.match(layout, /__html:\s*ANDROID_SHELL_VIEWPORT_SCRIPT/, "root layout ships the Android viewport script");

  // The premise: the installed Capacitor still keys its passthrough on viewport-fit=cover
  // and exposes the interface the script detects. A Capacitor upgrade that changes this fails here.
  const systemBars = readFileSync(
    join(root, "node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java"),
    "utf8"
  );
  assert.ok(systemBars.includes('addJavascriptInterface(this, "CapacitorSystemBarsAndroidInterface")'), "SystemBars exposes its Android interface");
  assert.ok(systemBars.includes('metaContent.includes("viewport-fit=cover")'), "SystemBars decides passthrough from viewport-fit=cover");
  assert.ok(/shouldPassthroughInsets\s*=\s*[^;]*hasViewportCover/.test(systemBars), "passthrough requires the viewport cover");

  console.log("android-viewport-fit: all assertions passed");
}

main();
