/**
 * Chain recorder for back-navigation flow QA.
 *
 * A chain = an ENTRY PATH the user really walks (clicks, typing, real links),
 * then N consecutive presses of the screen's back control. Every step records
 * the URL, the visible step marker and the screen state the test asserts
 * (entered text, selections, scroll) — the evidence table is generated from
 * what the browser actually did, never from expectations.
 */
import { mkdirSync, writeFileSync } from "node:fs";

export const results = [];
let pass = 0;
const failures = [];

export function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`    [PASS] ${name}${detail ? " — " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`    [FAIL] ${name}${detail ? " — " + detail : ""}`);
  }
  return !!cond;
}

export function summary() {
  return { pass, failures };
}

export const here = (page) => {
  const u = new URL(page.url());
  return decodeURIComponent(u.pathname + u.search);
};

/** The visible canonical back control. */
export const visibleBack = (page) => page.locator("[data-dz-back]:visible");

export async function backMode(page) {
  await visibleBack(page).first().waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll("[data-dz-back]")].find((e) => e.offsetParent !== null);
    return el && el.getAttribute("data-dz-back") !== "pending";
  });
  return visibleBack(page).first().getAttribute("data-dz-back");
}

/**
 * Runs one chain. `entry` is a list of { label, act } — each act performs the
 * real user action and waits for the step. `backs` is a list of
 * { expect: (url) => bool, label, checks?: async (page) => [name, cond, detail][] }.
 */
export async function runChain(page, { id, title, viewport, entry, backs, shots = true, via = "button", beforeEachBack }) {
  console.log(`
  ■ ${id} — ${title} [${viewport}] (${via === "browser" ? "browser Back" : "back button"})`);
  const record = { id, title, viewport, via, entry: [], backs: [], ok: true };
  for (const step of entry) {
    await step.act(page);
    await page.waitForLoadState("networkidle").catch(() => {});
    record.entry.push({ label: step.label, url: here(page) });
    console.log(`    → ${step.label}: ${here(page)}`);
  }
  for (let i = 0; i < backs.length; i += 1) {
    const b = backs[i];
    const before = here(page);
    beforeEachBack?.(i);
    let mode = "browser";
    // The target the back control computed for this screen (if a control
    // is shown) — every press must land exactly there.
    let computed = null;
    let buttonMode = null;
    if ((await visibleBack(page).count()) > 0) {
      const m = await backMode(page);
      buttonMode = m;
      const t = await visibleBack(page).first().getAttribute("data-dz-back-target");
      if (m !== "step" && t) computed = decodeURIComponent(t);
      if (via !== "browser") mode = m;
    }
    if (via === "browser") {
      await page.goBack().catch(() => {});
    } else if (b.press) {
      // The screen's own exit control (e.g. close X on a success screen).
      mode = b.pressLabel ?? "custom";
      computed = null;
      await b.press(page);
    } else {
      await visibleBack(page).first().click();
    }
    // e.g. answer the unsaved-changes dialog the press opened.
    if (b.afterPress) await b.afterPress(page);
    if (!b.stays) {
      await page
        .waitForFunction((prev) => decodeURIComponent(location.pathname + location.search) !== prev, before, { timeout: 15000 })
        .catch(() => {});
    }
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    const now = here(page);
    const row = { n: i + 1, from: before, mode, computed, to: now, label: b.label, checks: [] };
    const okUrl = check(`${id} back #${i + 1} (${mode}) → ${b.label}`, b.expect(now), `${before} ⇒ ${now}`);
    // Browser Back follows real history; it must match the computed target
    // whenever the control resolved a VERIFIED origin (history mode).
    // Browser Back moves ONE entry; the button deliberately skips same-screen
    // and consumed entries — so the computed target is asserted for button
    // presses; browser presses are asserted against the expected order.
    const compare = computed && !b.stays && via !== "browser";
    const okTarget = compare
      ? check(`${id} back #${i + 1} landed on the computed target`, now === computed, `computed=${computed} landed=${now}`)
      : true;
    row.ok = okUrl && okTarget;
    if (b.checks) {
      for (const [name, cond, detail] of await b.checks(page)) {
        const ok = check(`${id} back #${i + 1}: ${name}`, cond, detail ?? "");
        row.checks.push({ name, ok, detail: detail ?? "" });
        row.ok = row.ok && ok;
      }
    }
    if (shots) {
      const engine = process.env.QA_BROWSER === "webkit" ? "webkit-" : "";
      const file = `qa-evidence/back-nav/chains/${engine}${viewport}-${id}-back${i + 1}.png`;
      await page.screenshot({ path: file });
      row.shot = file;
    }
    record.backs.push(row);
    record.ok = record.ok && row.ok;
  }
  results.push(record);
  return record;
}

export function writeEvidence(path = "qa-evidence/back-nav/flow-chains.md") {
  mkdirSync("qa-evidence/back-nav/chains", { recursive: true });
  const lines = [
    "# Back navigation — flow chains (real browser evidence)",
    "",
    "Generated by `scripts/qa/back-nav-flows-qa.mjs` from what the browser actually did.",
    "Mode: `history` = verified origin (history.go), `fallback` = no verified origin (labelled parent, replace), `step` = in-screen control.",
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.id} — ${r.title} · ${r.viewport} · ${r.via === "browser" ? "browser Back" : "back button"} · ${r.ok ? "PASS" : "FAIL"}`);
    lines.push("");
    lines.push(`**Entry path:** ${r.entry.map((e) => `${e.label} \`${e.url}\``).join(" → ")}`);
    lines.push("");
    lines.push("| # | from | mode | computed target | landed on | expected | state checks |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const b of r.backs) {
      const checks = b.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("<br>");
      const computed = b.computed ? `\`${b.computed}\`` : "— (root / in-screen step control)";
      lines.push(`| ${b.n} | \`${b.from}\` | ${b.mode} | ${computed} | \`${b.to}\` | ${b.ok ? "✓" : "✗"} ${b.label} | ${checks || "—"} |`);
    }
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"));
  writeFileSync(path.replace(/\.md$/, ".json"), JSON.stringify(results, null, 2));
}
