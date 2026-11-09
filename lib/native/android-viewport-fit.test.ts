/**
 * Unit test — Android shell viewport switch (issue 2, status-bar overlap).
 * Run: npx tsx lib/native/android-viewport-fit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ANDROID_SHELL_VIEWPORT_SCRIPT, ensureAndroidShellViewport } from "@/lib/native/android-viewport-fit";

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

  // Hydration puts the cover back → the observer strips it again (Capacitor reads it later).
  {
    const meta = {
      content: NEXT,
      getAttribute() {
        return this.content;
      },
      setAttribute(_n: string, v: string) {
        this.content = v;
      },
    };
    let onMutation: (() => void) | null = null;
    let observed: unknown = null;
    let disconnected = false;
    class FakeObserver {
      constructor(cb: () => void) {
        onMutation = cb;
      }
      observe(target: unknown, opts: unknown) {
        observed = { target, opts };
      }
      disconnect() {
        disconnected = true;
      }
    }
    const html = {};
    const metasInDoc: typeof meta[] = [meta];
    const listeners: Record<string, () => void> = {};
    const timers: { fn: () => void; ms: number }[] = [];
    const ctx = {
      window: { CapacitorSystemBarsAndroidInterface: {} },
      document: {
        documentElement: html,
        readyState: "loading",
        querySelectorAll: () => metasInDoc,
        addEventListener: (ev: string, fn: () => void) => { listeners[ev] = fn; },
      },
      MutationObserver: FakeObserver,
      setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); },
    };
    runInNewContext(ANDROID_SHELL_VIEWPORT_SCRIPT, ctx);
    assert.equal(meta.content, "width=device-width, initial-scale=1");
    assert.ok(onMutation && observed, "Android shell watches the document");
    // the whole document — a replaced <head> must not escape the observer
    assert.equal((observed as { target: unknown }).target, html);
    meta.content = NEXT; // in-place content change
    (onMutation as unknown as () => void)();
    assert.equal(meta.content, "width=device-width, initial-scale=1", "restored cover is stripped again");
    // What React 19 actually does on hydration: it appends a NEW meta with the
    // original content (cover), which becomes the last one Capacitor reads.
    const appended = { ...meta, content: NEXT };
    metasInDoc.push(appended);
    (onMutation as unknown as () => void)();
    assert.equal(appended.content, "width=device-width, initial-scale=1", "an appended cover meta is stripped too");
    (onMutation as unknown as () => void)(); // no cover → no write, no loop
    assert.equal(meta.content, "width=device-width, initial-scale=1");

    // Capacitor reads once per load: the observer stops 15 s after DOMContentLoaded.
    assert.equal(disconnected, false);
    listeners.DOMContentLoaded();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 15000);
    timers[0].fn();
    assert.equal(disconnected, true, "observer disconnects after the load window");

    // Run late (document already parsed): the 15 s window starts immediately.
    {
      let lateDisconnect = false;
      const lateTimers: { fn: () => void; ms: number }[] = [];
      runInNewContext(ANDROID_SHELL_VIEWPORT_SCRIPT, {
        window: { CapacitorSystemBarsAndroidInterface: {} },
        document: { documentElement: {}, readyState: "complete", querySelectorAll: () => [], addEventListener() {} },
        MutationObserver: class {
          observe() {}
          disconnect() {
            lateDisconnect = true;
          }
        },
        setTimeout: (fn: () => void, ms: number) => { lateTimers.push({ fn, ms }); },
      });
      assert.equal(lateTimers.length, 1, "late run still schedules the disconnect");
      lateTimers[0].fn();
      assert.equal(lateDisconnect, true);
    }

    // Outside the Android shell nothing is observed.
    let created = false;
    runInNewContext(ANDROID_SHELL_VIEWPORT_SCRIPT, {
      window: {},
      document: { documentElement: {}, querySelectorAll: () => [meta], addEventListener() {} },
      MutationObserver: class {
        constructor() {
          created = true;
        }
        observe() {}
      },
    });
    assert.equal(created, false, "no observer outside the Android shell");
  }

  // Client backstop (error-fallback documents, where the inline script never runs).
  {
    const mk = (content: string) => ({
      content,
      getAttribute() {
        return this.content;
      },
      setAttribute(_n: string, v: string) {
        this.content = v;
      },
    });
    let reads = 0;
    const shellWin = { CapacitorSystemBarsAndroidInterface: { onDOMReady: () => { reads++; } } };

    const m1 = mk(NEXT);
    assert.equal(ensureAndroidShellViewport(shellWin, { querySelectorAll: () => [m1] }), true);
    assert.equal(m1.content, "width=device-width, initial-scale=1");
    assert.equal(reads, 1, "Capacitor is asked to read the viewport again");

    // Normal page: the script already stripped it → no change, no extra read.
    assert.equal(ensureAndroidShellViewport(shellWin, { querySelectorAll: () => [m1] }), false);
    assert.equal(reads, 1);

    // Browser / iOS: no interface → untouched, nothing called.
    const m2 = mk(NEXT);
    assert.equal(ensureAndroidShellViewport({}, { querySelectorAll: () => [m2] }), false);
    assert.equal(m2.content, NEXT);

    // A throwing onDOMReady never breaks the page.
    const m3 = mk(NEXT);
    assert.doesNotThrow(() =>
      ensureAndroidShellViewport(
        { CapacitorSystemBarsAndroidInterface: { onDOMReady: () => { throw new Error("x"); } } },
        { querySelectorAll: () => [m3] }
      )
    );

    // NativeShellInit runs the backstop.
    const init = readFileSync(join(process.cwd(), "components/native/NativeShellInit.tsx"), "utf8");
    assert.match(init, /ensureAndroidShellViewport\(\)/, "NativeShellInit calls the backstop");

    // SystemBars still exposes onDOMReady to JavaScript.
    const sb = readFileSync(
      join(process.cwd(), "node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java"),
      "utf8"
    );
    assert.ok(/@JavascriptInterface\s+public void onDOMReady\(\)/.test(sb), "SystemBars.onDOMReady is a JavascriptInterface");
  }

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
