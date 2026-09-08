/**
 * TEST-ONLY. Disposable cookie-contract probe for the Android WebView.
 *
 * NOT part of Dubiz. It serves no product page, touches no database, and knows
 * nothing about authentication. It exists to answer one question with runtime
 * evidence rather than argument:
 *
 *   does an Android WebView honour HttpOnly + Secure + SameSite=Strict +
 *   Path=/api/auth/refresh, and does that cookie survive the app's process
 *   being killed?
 *
 * The cookie value is a synthetic random marker generated per run. It is never
 * a credential, never derived from one, and grants nothing.
 *
 * WHY PLAIN HTTP ON LOOPBACK IS CORRECT HERE
 *
 * `Secure` requires a trustworthy origin, not literally TLS. Chromium — and
 * therefore the Android WebView — treats 127.0.0.1 as potentially trustworthy,
 * so a Secure cookie is accepted over http on loopback. That removes the need
 * for a certificate authority, a trust-store edit, or any external host: the
 * emulator reaches this server through `adb reverse`, so the origin the WebView
 * sees IS a loopback origin. Verified first in desktop Chromium; the emulator
 * run is what proves it for the WebView.
 *
 * The runner drives phases through /control; the page reports what it observed
 * to /report, which this server writes to disk as the evidence artefact.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PROBE_PORT ?? 3171);
const OUT = process.env.PROBE_REPORT ?? "native-evidence/cookie-probe.json";
const NAME = "dz_probe_marker";
/** Synthetic, per-run, meaningless outside this process. */
const MARKER = randomBytes(16).toString("hex");
const ATTRS = "HttpOnly; Secure; SameSite=Strict; Path=/api/auth/refresh";
/**
 * DIAGNOSTIC TWIN — not a proposal, not a fallback.
 *
 * The probe reaches the emulator over loopback http, because that is the only
 * trustworthy origin available without a certificate authority. Chromium
 * ACCEPTS a Secure cookie there, but it may decline to write one from a
 * non-cryptographic origin to disk. If so, a failure to survive process death
 * would be an artefact of the transport shortcut rather than anything true
 * about the Android WebView.
 *
 * This twin is identical except that it omits Secure. If the twin survives a
 * kill and the real cookie does not, the harness is at fault and the
 * architecture is unaffected. The production cookie stays Secure regardless of
 * what this shows.
 */
const TWIN = "dz_probe_twin_nonsecure";
const TWIN_ATTRS = "HttpOnly; SameSite=Strict; Path=/api/auth/refresh";

/** The runner advances this; the page asks what to do. */
let phase = "SET";
const report = [];

const hasCookie = (req) => (req.headers.cookie ?? "").includes(`${NAME}=`);
const json = (res, body) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

/**
 * The page. It asks for the current phase, performs exactly that phase's
 * observations, and posts them back. Kept in one file so the WebView loads a
 * single document with no subresources to go wrong.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>cookie probe</title></head>
<body style="font:16px system-ui;padding:24px">
<h1 id="h">probe</h1><pre id="out">running…</pre>
<script>
async function jget(p, init) {
  const r = await fetch(p, Object.assign({ credentials: "same-origin", cache: "no-store" }, init || {}));
  return r.json();
}
async function run() {
  const plan = await jget("/plan");
  const observed = {
    phase: plan.phase,
    locationOrigin: location.origin,
    href: location.href,
  };

  if (plan.phase.indexOf("SET") === 0) {
    // Any phase named SET* re-arms the cookie, so one run can time a kill that
    // follows the write closely and another that follows it after a settling
    // period. Android showed those two answers differ.
    observed.setResponse = await jget("/set");
  }

  // document.cookie must never contain the marker: that is what HttpOnly means.
  observed.documentCookie = document.cookie;

  if (plan.phase === "CLEAR") {
    observed.clearResponse = await jget("/clear");
  }

  observed.refreshEndpoint = await jget("/api/auth/refresh", { method: "POST" });
  observed.otherEndpoint = await jget("/api/other");

  await fetch("/report", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(observed),
  });

  document.getElementById("h").textContent = "phase " + plan.phase + " done";
  document.getElementById("out").textContent = JSON.stringify(observed, null, 2);
}

// Re-run when the app comes back to the foreground, so background→foreground
// is observed as its own event rather than inferred from a reload.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void run();
});
void run();
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/plan") return json(res, { phase });

  if (url.pathname === "/control") {
    phase = url.searchParams.get("phase") ?? phase;
    return json(res, { phase });
  }

  if (url.pathname === "/set") {
    res.setHeader("Set-Cookie", [
      `${NAME}=${MARKER}; ${ATTRS}; Max-Age=7776000`,
      `${TWIN}=${MARKER}; ${TWIN_ATTRS}; Max-Age=7776000`,
    ]);
    return json(res, { set: true, attributes: ATTRS, twinAttributes: TWIN_ATTRS });
  }

  if (url.pathname === "/clear") {
    res.setHeader("Set-Cookie", [
      `${NAME}=; ${ATTRS}; Max-Age=0`,
      `${TWIN}=; ${TWIN_ATTRS}; Max-Age=0`,
    ]);
    return json(res, { cleared: true });
  }

  // The scoped endpoint: the cookie's Path points exactly here.
  if (url.pathname === "/api/auth/refresh") {
    const jar = req.headers.cookie ?? "";
    return json(res, {
      cookiePresent: jar.includes(`${NAME}=`),
      matchesMarker: jar.includes(MARKER),
      twinPresent: jar.includes(`${TWIN}=`),
    });
  }

  // Any other API path: the cookie must NOT arrive.
  if (url.pathname === "/api/other") {
    return json(res, { cookiePresent: hasCookie(req) });
  }

  if (url.pathname === "/report" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const entry = JSON.parse(body);
        entry.receivedAt = new Date().toISOString();
        // Never write the marker itself into the artefact.
        entry.documentCookieContainsMarker = String(entry.documentCookie ?? "").includes(MARKER);
        entry.documentCookie = String(entry.documentCookie ?? "").length === 0 ? "(empty)" : "(non-empty)";
        report.push(entry);
        writeFileSync(OUT, JSON.stringify({ cookieName: NAME, attributes: ATTRS, report }, null, 2));
        console.log(`[probe] ${entry.phase}: refresh=${entry.refreshEndpoint?.cookiePresent} other=${entry.otherEndpoint?.cookiePresent} docCookieHasMarker=${entry.documentCookieContainsMarker}`);
      } catch (e) {
        console.error("[probe] bad report:", e instanceof Error ? e.message : e);
      }
      json(res, { ok: true });
    });
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(PAGE);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[probe] listening on http://127.0.0.1:${PORT} (cookie ${NAME}, attributes: ${ATTRS})`);
});
