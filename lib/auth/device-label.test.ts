/**
 * Device label + User-Agent handling (run manually):
 *   npx tsx lib/auth/device-label.test.ts
 *
 * The input is attacker-controlled, so the property that matters is not "does it
 * recognise Chrome" but "can a hostile header ever put text of its choosing on
 * the owner's screen". Every assertion below is really about that.
 */

import {
  UNKNOWN_DEVICE,
  USER_AGENT_MAX_LENGTH,
  deviceLabel,
  normalizeUserAgent,
} from "@/lib/auth/device-label";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  ok  - ${name}`);
  else {
    failed += 1;
    console.error(`FAIL  - ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const UA = {
  chromeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  edgeWin:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
  ipad:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15 iPad",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/115.0.0.0",
  curl: "curl/8.4.0",
};

function main() {
  // ---- recognition, including the ones that lie about themselves -----------
  ok("Chrome on Windows", deviceLabel(UA.chromeWin) === "Chrome · Windows");
  ok("Edge is not read as Chrome", deviceLabel(UA.edgeWin) === "Edge · Windows");
  ok("Opera is not read as Chrome", deviceLabel(UA.opera) === "Opera · Windows");
  ok("Samsung Internet is not read as Chrome", deviceLabel(UA.samsung) === "Samsung Internet · Android");
  ok("Safari on iPhone", deviceLabel(UA.safariIphone) === "Safari · iPhone");
  ok("Chrome on Android", deviceLabel(UA.chromeAndroid) === "Chrome · Android");
  ok("Safari on Mac", deviceLabel(UA.safariMac) === "Safari · Mac");
  ok("Firefox on Linux", deviceLabel(UA.firefoxLinux) === "Firefox · Linux");
  ok("Chrome on iOS reports Chrome, not Safari", deviceLabel(UA.chromeIos) === "Chrome · iPhone");
  ok("iPad is not read as Mac", deviceLabel(UA.ipad) === "Safari · iPad");

  // ---- the honest answers -------------------------------------------------
  ok("no header at all", deviceLabel(null) === UNKNOWN_DEVICE);
  ok("undefined", deviceLabel(undefined) === UNKNOWN_DEVICE);
  ok("empty string", deviceLabel("   ") === UNKNOWN_DEVICE);
  ok("something we do not recognise", deviceLabel(UA.curl) === UNKNOWN_DEVICE);

  // ---- the property that actually matters ---------------------------------
  {
    const hostile = '<script>alert(1)</script> Chrome/1 Windows "><img src=x>';
    const label = deviceLabel(hostile);
    ok(
      "a hostile header cannot put its own text in the label",
      !label.includes("<") && !label.includes(">") && !label.includes("script") && !label.includes('"'),
      label
    );
    ok("...and it still produces a usable label", label === "Chrome · Windows", label);
  }
  {
    // Every output must come from the closed set, so no input can invent one.
    const allowed = new Set([
      UNKNOWN_DEVICE,
      ...["Chrome", "Edge", "Safari", "Firefox", "Opera", "Samsung Internet"].flatMap((b) => [
        b,
        ...["Windows", "Mac", "iPhone", "iPad", "Android", "Linux"].map((p) => `${b} · ${p}`),
      ]),
      ...["Windows", "Mac", "iPhone", "iPad", "Android", "Linux"],
    ]);
    const inputs = [...Object.values(UA), "", "x".repeat(4000), "Android Windows iPhone Chrome Safari Firefox"];
    ok(
      "every label is a member of the closed output set",
      inputs.every((i) => allowed.has(deviceLabel(i))),
      inputs.filter((i) => !allowed.has(deviceLabel(i))).map((i) => deviceLabel(i)).join(" | ")
    );
  }

  // ---- truncation, before the database sees it ----------------------------
  {
    const huge = "M".repeat(5000);
    const stored = normalizeUserAgent(huge);
    ok("an oversized header is truncated, not rejected", stored !== null && stored.length === USER_AGENT_MAX_LENGTH);
    ok("...to exactly the column width", USER_AGENT_MAX_LENGTH === 512);
    ok("a normal header is stored whole", normalizeUserAgent(UA.chromeWin) === UA.chromeWin);
    ok("an empty header becomes NULL, not an empty string", normalizeUserAgent("  ") === null);
    ok("a missing header becomes NULL", normalizeUserAgent(null) === null && normalizeUserAgent(undefined) === null);
    ok("a non-string becomes NULL", normalizeUserAgent(42 as unknown as string) === null);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

main();
