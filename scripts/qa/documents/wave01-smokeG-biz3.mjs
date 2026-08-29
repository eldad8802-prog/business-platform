/**
 * Smoke G (only) — accountant ZIP on the REAL historically-failing months,
 * under the business where the 504 was observed (business 3 / QA persona).
 * READ-ONLY: performs exports only, creates and changes nothing.
 *
 * Clears the stored token first so the operator logs in as the business-3 QA
 * user in the opened window.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.SMOKE_BASE_URL || "https://promaxgroup.co.il";
const OUT = process.env.SMOKE_OUT_DIR || path.join(process.cwd(), ".smoke-out");
const PROFILE = process.env.SMOKE_PROFILE_DIR || path.join(OUT, "pw-profile");
const MONTHS = ["2026-07", "2026-06", "2026-08"];

async function fetchZipBase64(page, body) {
  return page.evaluate(async ({ body }) => {
    const token = localStorage.getItem("token");
    const started = Date.now();
    const res = await fetch("/api/reports/export-zip", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - started;
    if (!res.ok) return { status: res.status, ms, base64: null };
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return {
      status: res.status,
      ms,
      bytes: buf.length,
      contentLength: res.headers.get("content-length"),
      base64: btoa(bin),
    };
  }, { body });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("token"));
  await page.reload({ waitUntil: "domcontentloaded" });
  console.log("\n=== התחבר בחלון כמשתמש ה-QA של עסק 3 (dana.cohen.test@promax-qa.com) ===");
  console.log("ממתין עד 60 דקות...\n");

  let token = null;
  const started = Date.now();
  while (!token && Date.now() - started < 60 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 2000));
    token = await page.evaluate(() => localStorage.getItem("token")).catch(() => null);
  }
  if (!token) {
    console.error("FAIL: no login");
    await ctx.close();
    process.exit(2);
  }
  console.log("OK  : authenticated\n");

  let failed = 0;
  for (const m of MONTHS) {
    const zip = await fetchZipBase64(page, { type: "month", month: m });
    const ok = zip.status === 200 && zip.base64;
    console.log(
      `${ok ? "OK  " : "FAIL"}: ${m} export — status=${zip.status} ms=${zip.ms} bytes=${zip.bytes ?? 0} content-length=${zip.contentLength}`
    );
    if (!ok) failed += 1;
    if (zip.base64) {
      await writeFile(path.join(OUT, `accountant-biz3-${m}.zip`), Buffer.from(zip.base64, "base64"));
    }
  }
  await ctx.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
