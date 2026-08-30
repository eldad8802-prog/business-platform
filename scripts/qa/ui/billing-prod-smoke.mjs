/**
 * Billing adaptive production smoke (B0–B3, post-merge).
 *
 * Read-only by construction: it navigates and measures, and issues no PATCH,
 * no issue/void, and creates no document. States that need a fiscal write to
 * reach are simply not covered (owner decision D-3).
 *
 * Uses the persistent profile holding the owner's manual production login —
 * no credentials pass through this script.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.AUDIT_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.AUDIT_OUT_DIR || path.join(process.cwd(), ".billing-prod");
const PROFILE =
  process.env.AUDIT_PROFILE_DIR ||
  "C:/Users/84D7~1/AppData/Local/Temp/claude/c--dev-business-platform/ff50b31f-2d66-4c99-bf1c-dd70619a0b0f/scratchpad/closure-smoke/pw-profile";

const VIEWPORTS = [390, 768, 1024, 1280, 1440, 1920];
const WORKSPACE_TIER = 1280;
const SHELL_DESKTOP_TIER = 1024;

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: Boolean(cond), detail: String(detail) });
  console.log((cond ? "OK  : " : "FAIL: ") + name + (detail ? " — " + detail : ""));
}

async function measure(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const vis = (el) => !!el && getComputedStyle(el).display !== "none";
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const rail = document.querySelector("[data-wsl] > .wsl-start");
    const stage = document.querySelector("[data-wsl] > .wsl-end");
    const col = document.querySelector("[data-billing-column]");
    // Primary navigation surfaces the shell owns. Two visible at once would be
    // the duplicate-navigation failure.
    const navs = Array.from(document.querySelectorAll("nav"))
      .filter((n) => vis(n) && n.getBoundingClientRect().width > 40)
      .map((n) => ({ label: n.getAttribute("aria-label"), w: Math.round(n.getBoundingClientRect().width) }));
    // Everything the page itself pins, excluding the shell's own chrome and the
    // global accessibility button.
    const pinned = Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const cs = getComputedStyle(el);
        return (cs.position === "sticky" || cs.position === "fixed") &&
          el.getBoundingClientRect().height > 0;
      })
      .map((el) => ({
        label: el.getAttribute("aria-label") || el.id || el.className || el.tagName,
        pos: getComputedStyle(el).position,
        z: getComputedStyle(el).zIndex,
      }));
    const pagePinned = pinned.filter(
      (p) => !/נגישות|ניווט|shell-|sidenav/i.test(String(p.label))
    );
    const taps = Array.from(document.querySelectorAll("button, a[href], input, select"))
      .map((el) => ({ t: (el.textContent || "").trim().slice(0, 24), r: el.getBoundingClientRect() }))
      .filter((o) => o.r.width > 0 && o.r.height > 0);
    return {
      iw: window.innerWidth,
      sw: Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0),
      intent: (document.querySelector("[data-page-intent]") || { getAttribute: () => null })
        .getAttribute("data-page-intent"),
      colW: rect(col) ? rect(col).w : null,
      rail: vis(rail) ? rect(rail) : null,
      stage: vis(stage) ? rect(stage) : null,
      navs,
      pagePinned,
      minTap: taps.length ? Math.round(Math.min.apply(null, taps.map((o) => o.r.height))) : null,
      under24: taps.filter((o) => o.r.height < 24 || o.r.width < 24).map((o) => o.t + "=" + Math.round(o.r.height)),
      money: ((document.body.innerText || "").replace(/[‎‏؜⁦-⁩]/g, "").match(/[₪$€]\s*[\d,]+\.\d{2}|[\d,]+\.\d{2}\s*[₪$€]/g) || [])
        .map((s) => s.replace(/\s+/g, " ").trim()).sort(),
      actions: Array.from(document.querySelectorAll("button"))
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ label: (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40), disabled: b.disabled === true }))
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
      dir: de.getAttribute("dir"),
    };
  });
}

async function settle(page) {
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(1500);
}

async function main() {
  await mkdir(path.join(OUT, "shots"), { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // Per-page-load request tally: a remount regression shows up here as more
  // than one fetch per load of the same surface.
  let bucket = "boot";
  const reqs = {};
  page.on("request", (r) => {
    const u = r.url();
    if (!u.includes("/api/")) return;
    const key = r.method() + " " + u.replace(/^https?:\/\/[^/]+/, "").replace(/\d+/g, ":id");
    reqs[bucket] = reqs[bucket] || {};
    reqs[bucket][key] = (reqs[bucket][key] || 0) + 1;
  });

  await page.goto(BASE + "/billing", { waitUntil: "load" });
  await page.waitForTimeout(3000);
  if (!(await page.evaluate(() => localStorage.getItem("token")))) {
    console.error("FAIL: no authenticated production session in profile");
    await ctx.close();
    process.exit(2);
  }

  // Observe existing documents only. Nothing is created.
  const docs = await page.evaluate(async () => {
    const r = await fetch("/api/billing/documents", {
      headers: { authorization: "Bearer " + localStorage.getItem("token") },
    });
    const j = await r.json();
    const arr = j.documents || j.items || j;
    return (Array.isArray(arr) ? arr : []).map((d) => ({
      id: d.id, type: d.documentType, status: d.status,
      number: d.documentNumberFormatted, total: d.totalAmount,
    }));
  });
  console.log("production documents observed: " + docs.length);
  for (const d of docs) console.log("  " + d.id + " " + d.type + "/" + d.status + " " + (d.number || "-") + " " + d.total);

  const rows = [];
  // With no document in the tenant the stage states are unreachable, but the
  // detail ROUTE still is: a missing id renders the not-found state, which sits
  // inside the same <main data-page-intent>, the same [data-billing-column] and
  // the same ShellChrome contract. That is a GET against nothing — it creates no
  // fiscal object — and it proves the container and chrome halves of B2 in
  // production even when the rail cannot be reached.
  const targets = [["hub", "/billing"], ["detail-notfound", "/billing/99999999"]]
    .concat(docs.slice(0, 3).map((d) => ["doc-" + d.id, "/billing/" + d.id]));
  for (const [name, route] of targets) {
    for (const w of VIEWPORTS) {
      bucket = name + "@" + w;
      await page.setViewportSize({ width: w, height: w < 700 ? 844 : 950 });
      await page.goto(BASE + route, { waitUntil: "load", timeout: 60000 });
      await settle(page);
      const m = await measure(page);
      rows.push(Object.assign({ name, w }, m));
      await page.screenshot({ path: path.join(OUT, "shots", name + "__" + w + ".png") });
      console.log(
        name + "@" + w + ": col=" + m.colW + " rail=" + (m.rail ? m.rail.w + "@x" + m.rail.x : "-") +
        " stage=" + (m.stage ? m.stage.w + "@x" + m.stage.x : "-") +
        " navs=" + m.navs.length + " pagePinned=" + m.pagePinned.length +
        " minTap=" + m.minTap + " overflow=" + (m.sw > m.iw + 1)
      );
    }
  }

  const detail = rows.filter((r) => r.name.startsWith("doc-"));
  const routeRows = rows.filter((r) => r.name !== "hub");
  const by = (n, w) => rows.find((r) => r.name === n && r.w === w);

  // --- universal ---
  const of = rows.filter((r) => r.sw > r.iw + 1);
  check("PROD: zero horizontal overflow (" + rows.length + " cells)", of.length === 0,
    of.map((r) => r.name + "@" + r.w).join(", "));
  check("PROD: RTL preserved", rows.every((r) => r.dir === "rtl"));
  const small = rows.filter((r) => r.under24.length);
  check("PROD: no interactive target under 24x24", small.length === 0,
    small.map((r) => r.name + "@" + r.w + ":" + r.under24.join("/")).join(" | "));

  // --- ShellChrome contract ---
  for (const r of routeRows) {
    if (r.w >= SHELL_DESKTOP_TIER) {
      check("PROD: " + r.name + "@" + r.w + " shell nav present (D-1)", r.navs.length === 1,
        "navs=" + JSON.stringify(r.navs));
    } else {
      check("PROD: " + r.name + "@" + r.w + " focused: no shell nav", r.navs.length === 0,
        "navs=" + JSON.stringify(r.navs));
    }
  }
  check("PROD: never two navigation surfaces at once", rows.every((r) => r.navs.length <= 1),
    rows.filter((r) => r.navs.length > 1).map((r) => r.name + "@" + r.w).join(", "));

  // --- contextual rail ---
  for (const r of detail) {
    if (r.w >= WORKSPACE_TIER) {
      check("PROD: " + r.name + "@" + r.w + " rail present", !!r.rail, r.rail ? r.rail.w + "px" : "absent");
      if (r.rail && r.stage) {
        check("PROD: " + r.name + "@" + r.w + " rail at RTL inline-start", r.rail.x > r.stage.x,
          "rail.x=" + r.rail.x + " stage.x=" + r.stage.x);
        check("PROD: " + r.name + "@" + r.w + " editor not stretched (stage <= data cap)",
          r.stage.w <= 1280, "stage=" + r.stage.w);
      }
    } else {
      check("PROD: " + r.name + "@" + r.w + " single region (no rail)", !r.rail,
        r.rail ? "rail=" + r.rail.w : "");
    }
  }

  // --- sticky ownership ---
  const multi = rows.filter((r) => r.pagePinned.length > 1);
  check("PROD: at most one page-owned pinned element per state", multi.length === 0,
    multi.map((r) => r.name + "@" + r.w + ":" + r.pagePinned.map((p) => p.label).join("+")).join(" | "));

  // --- fiscal parity across viewports (layout must not change what is shown) ---
  for (const d of docs.slice(0, 3)) {
    const name = "doc-" + d.id;
    const ref = by(name, 390);
    for (const w of VIEWPORTS.slice(1)) {
      const cur = by(name, w);
      check("PROD: " + name + " monetary values identical at " + w + " vs 390",
        JSON.stringify(cur.money) === JSON.stringify(ref.money),
        JSON.stringify(ref.money) + " vs " + JSON.stringify(cur.money));
      check("PROD: " + name + " lifecycle actions identical at " + w + " vs 390",
        JSON.stringify(cur.actions) === JSON.stringify(ref.actions),
        "n=" + ref.actions.length + " vs " + cur.actions.length);
    }
  }

  // --- refetch parity: one fetch per surface per load, no loops ---
  const detailLoads = Object.entries(reqs).filter(([k]) => k.startsWith("doc-"));
  const worst = detailLoads
    .map(([k, v]) => ({ k, max: Math.max(...Object.values(v)), doc: v["GET /api/billing/documents/:id"] || 0 }))
    .filter((o) => o.doc > 1);
  check("PROD: no refetch regression (one document fetch per page load)", worst.length === 0,
    worst.map((o) => o.k + "=" + o.doc).join(", "));
  const loops = detailLoads.filter(([, v]) => Math.max(...Object.values(v)) > 4);
  check("PROD: no request loop on any load", loops.length === 0,
    loops.map(([k, v]) => k + ":" + JSON.stringify(v)).join(" | "));

  const nf = rows.filter((r) => r.name === "detail-notfound");
  check("PROD: detail route declares the workspace intent", nf.every((r) => r.intent === "workspace"), JSON.stringify(nf.map((r) => r.w + ":" + r.intent)));
  check("PROD: column takes the content cap below the workspace tier", nf.filter((r) => r.w < WORKSPACE_TIER).every((r) => r.colW !== null && r.colW <= 960), JSON.stringify(nf.filter((r) => r.w < WORKSPACE_TIER).map((r) => r.w + ":" + r.colW)));
  check("PROD: column takes the data cap at and above the workspace tier", nf.filter((r) => r.w >= WORKSPACE_TIER).every((r) => r.colW !== null && r.colW > 960 && r.colW <= 1280), JSON.stringify(nf.filter((r) => r.w >= WORKSPACE_TIER).map((r) => r.w + ":" + r.colW)));

  await writeFile(path.join(OUT, "matrix.json"),
    JSON.stringify({ docs, rows, requests: reqs, checks: results }, null, 1));

  const failed = results.filter((r) => !r.pass);
  console.log("\n=== BILLING PROD SMOKE " + (results.length - failed.length) + "/" + results.length + " ===");
  if (failed.length) console.log("FAILED:\n - " + failed.map((f) => f.name + " " + f.detail).join("\n - "));
  await ctx.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
