/**
 * Unit test — layouts that fit every phone width, text size and font state (no per-device patches).
 * Run: npx tsx components/navigation/mobile-fit.test.ts
 *
 * Source checks that pin the content-driven layout rules. They do not replace the browser audit (bounds of every
 * element at 320–430 px, zoom 100/200 %, loaded and fallback font) — they stop the fixed-column / per-width
 * patterns from coming back.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function main() {
  // Secretary "תחנות ניהול": wrap by content, never split a word.
  const sec = read("app/(shell)/secretary/secretary-home.module.css");
  const notes = /\.notes \{[^}]*\}/.exec(sec)?.[0] ?? "";
  assert.match(notes, /display: flex;/, "notes are a wrapping flex row");
  assert.match(notes, /flex-wrap: wrap;/);
  assert.doesNotMatch(sec, /\.notes[^{]*\{[^}]*repeat\(3,/, "no fixed three-column notes grid");
  const title = /\.noteTitle \{[^}]*\}/.exec(sec)?.[0] ?? "";
  assert.doesNotMatch(title, /overflow-wrap: anywhere/, "a note title never breaks mid-word");
  const slot = /\.noteSlot \{[^}]*\}/.exec(sec)?.[0] ?? "";
  assert.match(slot, /flex: 1 1 0;/, "equal notes while they fit");
  assert.doesNotMatch(slot, /min-width: 0/, "a note slot never gets narrower than its title (wraps before splitting a word)");
  assert.match(/\.page \{[^}]*\}/.exec(sec)?.[0] ?? "", /grid-template-columns: minmax\(0, 1fr\);/, "one wide item cannot widen the page");
  assert.doesNotMatch(/\.note \{[^}]*\}/.exec(sec)?.[0] ?? "", /^\s*min-width: 0;/m, "a note is at least as wide as its title (the row wraps first)");
  assert.match(/\.actions \{[^}]*\}/.exec(sec)?.[0] ?? "", /flex-wrap: wrap;/, "create actions wrap instead of overflowing");

  // Week strip: seven columns only while a day fits; in em so it follows text size.
  const hub = read("app/(shell)/secretary/secretary-hub.module.css");
  const week = /\.week \{[^}]*\}/.exec(hub)?.[0] ?? "";
  assert.match(week, /repeat\(auto-fit, minmax\(max\(2em, calc\(\(100% - 18px\) \/ 7\)\), 1fr\)\)/);

  // Floating accessibility button: publishes its strip; the shell content never ends under it.
  const fab = read("components/ui/accessibility/accessibility-fab.tsx");
  assert.match(fab, /const FAB_CLEARANCE_VAR = "--dz-fab-clearance";/);
  assert.match(fab, /setProperty\(FAB_CLEARANCE_VAR, isDocked \? "0px" : `\$\{inset \+ FAB_SIZE \+ FAB_CLEAR_GAP\}px`\)/);
  assert.match(fab, /new ResizeObserver/, "the bar is watched for size changes (text size)");
  assert.match(fab, /removeProperty\(FAB_CLEARANCE_VAR\)/, "cleared on unmount");
  const shell = read("components/navigation/shell-chrome.tsx");
  const paddings = shell.match(/\.shell-content \{ padding-bottom: [^;]+;/g) ?? [];
  assert.equal(paddings.length, 3, "mobile, tablet/desktop and chrome-off paddings");
  for (const p of paddings) assert.match(p, /max\([^;]*var\(--dz-fab-clearance, 0px\)\)/, `reserves the FAB strip: ${p}`);

  // Home: the cashflow header wraps at every width; no per-width patches; whole business name; fit rows.
  const cash = read("features/home/v3/cashflow-card.tsx");
  assert.match(cash, /<div style=\{\{ display: "flex", flexWrap: "wrap", gap: variant === "desktop" \? 12 : "10px 12px"/);
  assert.doesNotMatch(cash, /flexWrap: variant === "desktop" \? "wrap" : undefined/);
  const parts = read("features/home/v3/home-parts.tsx");
  assert.doesNotMatch(parts, /389\.98px|dzh-cash-title \{ white-space: nowrap/, "no device-width patches");
  assert.match(parts, /\.dzh-root \.dzh-fit-row > \* \{ flex: 1 1 0; min-width: auto !important; \}/);
  const home = read("features/home/v3/home-v3.tsx");
  assert.doesNotMatch(home, /<h1 style=\{\{[^}]*textOverflow: "ellipsis"/, "the business name is never cut");
  assert.doesNotMatch(home + parts, /gridTemplateColumns: "repeat\(3, minmax\(0, 1fr\)\)"/, "no fixed three-card rows");

  console.log("mobile-fit: all checks passed");
}

main();
