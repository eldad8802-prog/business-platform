/**
 * The call-scoped window.open observer. Run with:
 *   npx tsx components/whatsapp/popup-observer.test.ts
 *
 * The Facebook SDK resolves `window.open` at call time (verified against the
 * real SDK), so wrapping only the FB.login call tells opened / refused apart.
 */
import assert from "node:assert/strict";
import { observeWindowOpen } from "./popup-observer";

let checks = 0;
function test(name: string, fn: () => void) {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
}

function fakeWindow(returns: unknown) {
  const calls: unknown[][] = [];
  const original = (...args: never[]) => {
    calls.push(args);
    return returns;
  };
  return { host: { open: original } as { open: (...args: never[]) => unknown }, original, calls };
}

console.log("\nPopup observer\n");

test("window opened → opened=true, arguments passed through, original restored", () => {
  const w = fakeWindow({ closed: false });
  const r = observeWindowOpen(() => {
    (w.host.open as (u: string, n: string) => unknown)("https://www.facebook.com/dialog", "_blank");
  }, w.host);
  assert.deepEqual(r, { opened: true });
  assert.deepEqual(w.calls[0], ["https://www.facebook.com/dialog", "_blank"]);
  assert.equal(w.host.open, w.original, "original restored");
});

test("browser refuses (null) → opened=false", () => {
  const w = fakeWindow(null);
  const r = observeWindowOpen(() => {
    w.host.open();
  }, w.host);
  assert.deepEqual(r, { opened: false });
  assert.equal(w.host.open, w.original);
});

test("no open attempted → opened=null (unknown, no behaviour change)", () => {
  const w = fakeWindow({});
  assert.deepEqual(observeWindowOpen(() => {}, w.host), { opened: null });
  assert.equal(w.host.open, w.original);
});

test("the wrapper is removed even when the call throws; the error propagates", () => {
  const w = fakeWindow({});
  assert.throws(() =>
    observeWindowOpen(() => {
      throw new Error("sdk threw");
    }, w.host)
  );
  assert.equal(w.host.open, w.original);
});

test("a later window.open outside the call is not observed", () => {
  const w = fakeWindow(null);
  observeWindowOpen(() => {}, w.host);
  assert.equal(w.host.open, w.original, "no lingering wrapper");
});

test("no window (server) → runs the call, reports unknown", () => {
  let ran = false;
  assert.deepEqual(observeWindowOpen(() => { ran = true; }, undefined), { opened: null });
  assert.equal(ran, true);
});

console.log(`\nALL POPUP OBSERVER TESTS PASSED — ${checks} checks\n`);
