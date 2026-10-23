#!/usr/bin/env node
/**
 * Production uptime monitor — evaluator (no dependencies, no network).
 *
 *   node ops/monitor/evaluate.mjs --samples S.tsv [--baseline B.json] [--prev PREV.json]
 *        [--state-out STATE.json] [--summary SUMMARY.md] [--force-breach] [--run-id ID]
 *   node ops/monitor/evaluate.mjs --self-test
 *
 * Per target (round 0 = warm-up, discarded):
 *   sample = OK (2xx/3xx) | CHALLENGE (403 + x-vercel-mitigated: challenge) | 5XX | ERROR (timeout, other code)
 *   target = 5XX if any sample is 5xx; MEASURED if a majority is OK (median TTFB of the OK samples);
 *            UNREACHABLE if a majority is ERROR; otherwise INCONCLUSIVE (checkpoint challenge — never an outage).
 * Latency compares OFFSETS, not absolute times (the runner is not where the baseline was measured):
 *   excess = (median - reference median) - baseline offset;  breach = excess > thresholdMs.
 * Run BREACHING = >= minBreachingTargets breaches, or any 5XX, or any UNREACHABLE target.
 * ALERT (exit 1) only when this run AND the previous scheduled run (state no older than
 * maxPrevStateAgeMinutes) are both BREACHING — a single cold-start spike never alerts.
 * Exit: 0 no alert, 1 alert, 2 bad input.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORCE_THRESHOLD = -1e9;

export function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split("\t");
  return lines.map((l) => {
    const c = l.split("\t");
    const r = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    for (const k of ["round", "code", "ttfb_ms", "total_ms", "curl_exit"]) r[k] = Number(r[k]);
    return r;
  });
}

export function classify(s) {
  if (s.code === 403 && /challenge/i.test(s.mitigated ?? "")) return "CHALLENGE";
  if (s.code >= 500) return "5XX";
  if (s.curl_exit === 0 && s.code >= 200 && s.code < 400) return "OK";
  return "ERROR";
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const mode = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => (c.size > 1 ? `${v}×${n}` : v)).join(" ");
};

export function summarizeTarget(rows) {
  const samples = rows.filter((r) => r.round >= 1);
  const kinds = samples.map(classify);
  const n = samples.length;
  const count = (k) => kinds.filter((x) => x === k).length;
  const majority = Math.floor(n / 2) + 1;
  const ok = samples.filter((_, i) => kinds[i] === "OK");
  let status;
  if (count("5XX") > 0) status = "5XX";
  else if (n > 0 && ok.length >= majority) status = "MEASURED";
  else if (n > 0 && count("ERROR") >= majority) status = "UNREACHABLE";
  else status = "INCONCLUSIVE";
  return {
    status,
    n,
    ok: ok.length,
    challenged: count("CHALLENGE"),
    errors: count("ERROR"),
    fivexx: count("5XX"),
    codes: mode(samples.map((s) => s.code)),
    medianMs: ok.length ? median(ok.map((s) => s.ttfb_ms)) : null,
    cache: mode(samples.map((s) => s.cache).filter((x) => x && x !== "-")) || "-",
    regions: mode(samples.map((s) => s.regions).filter((x) => x && x !== "-")) || "-",
    lang: mode(samples.map((s) => s.lang).filter((x) => x && x !== "-")) || "-",
  };
}

export function evaluate({ rows, baseline, prev, now = new Date(), force = false }) {
  const threshold = force ? FORCE_THRESHOLD : baseline.thresholdMs;
  const ref = baseline.reference;
  const all = [ref, ...Object.keys(baseline.targets)];
  const targets = Object.fromEntries(all.map((t) => [t, summarizeTarget(rows.filter((r) => r.target === t))]));
  const refT = targets[ref];
  const latencyInconclusive = refT.status !== "MEASURED";
  let breaches = 0;
  for (const t of Object.keys(baseline.targets)) {
    const x = targets[t];
    x.baselineOffsetMs = baseline.targets[t].offsetMs;
    if (x.status === "MEASURED" && !latencyInconclusive) {
      x.offsetMs = x.medianMs - refT.medianMs;
      x.excessMs = x.offsetMs - x.baselineOffsetMs;
      x.breach = x.excessMs > threshold;
      if (x.breach) breaches++;
    } else {
      x.offsetMs = x.excessMs = null;
      x.breach = false;
    }
  }
  const fivexx = all.filter((t) => targets[t].status === "5XX");
  const unreachable = all.filter((t) => targets[t].status === "UNREACHABLE");
  const inconclusive = all.filter((t) => targets[t].status === "INCONCLUSIVE");
  const latencyBreach = breaches >= baseline.minBreachingTargets;
  const breaching = force || latencyBreach || fivexx.length > 0 || unreachable.length > 0;
  const reasons = [];
  if (force) reasons.push("FORCED self-test (threshold overridden, previous run assumed breaching)");
  if (latencyBreach) reasons.push(`${breaches} targets > ${force ? "FORCED" : threshold} ms over baseline offset`);
  if (fivexx.length) reasons.push(`5xx on ${fivexx.join(", ")}`);
  if (unreachable.length) reasons.push(`unreachable: ${unreachable.join(", ")}`);

  let prevBreaching = false;
  let prevNote;
  if (force) {
    prevBreaching = true;
    prevNote = "FORCED (self-test assumes the previous run was breaching)";
  } else if (!prev) {
    prevNote = "none found (first run, expired artifact, or not a main run)";
  } else {
    const ageMin = (now - new Date(prev.at)) / 60000;
    if (!(ageMin >= 0) || ageMin > baseline.maxPrevStateAgeMinutes) prevNote = `ignored: ${Math.round(ageMin)} min old (> ${baseline.maxPrevStateAgeMinutes})`;
    else {
      prevBreaching = prev.breaching === true;
      prevNote = `${prevBreaching ? "BREACHING" : "healthy"} (run ${prev.runId ?? "?"}, ${Math.round(ageMin)} min ago)`;
    }
  }
  const alert = breaching && prevBreaching;
  return { at: now.toISOString(), force, threshold, targets, breaches, fivexx, unreachable, inconclusive, latencyInconclusive, breaching, reasons, prevBreaching, prevNote, alert };
}

export function renderSummary(v, baseline) {
  const verdict = v.alert ? "ALERT — sustained breach (this run and the previous scheduled run)"
    : v.breaching ? "BREACHING this run only — not sustained, no alert (a single spike never alerts)"
    : "HEALTHY";
  const fmt = (x) => (x === null || x === undefined ? "—" : `${x > 0 ? "+" : ""}${x}`);
  const L = [];
  L.push(`## Production uptime monitor — ${verdict}${v.force ? " (FORCED self-test)" : ""}`);
  L.push("");
  L.push(`Base \`${baseline.base}\` · reference \`${baseline.reference}\` · threshold ${v.force ? "FORCED" : `${v.threshold} ms`} · breach needs ≥${baseline.minBreachingTargets} targets, or any 5xx / unreachable`);
  if (v.reasons.length) L.push(`\n**Breaching because:** ${v.reasons.join("; ")}`);
  L.push(`\n**Previous scheduled run:** ${v.prevNote}`);
  if (v.latencyInconclusive) L.push(`\n**Latency INCONCLUSIVE:** the reference was not measured (${v.targets[baseline.reference].status}); offsets not computed.`);
  if (v.inconclusive.length) L.push(`\n**INCONCLUSIVE (Vercel checkpoint challenge / mixed results — not an outage):** ${v.inconclusive.join(", ")}`);
  L.push("");
  L.push("| target | status | ok/n | challenged | codes | median TTFB ms | offset vs ref ms | baseline offset ms | excess ms | breach | x-vercel-cache | region path | html lang |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [t, x] of Object.entries(v.targets)) {
    const isRef = t === baseline.reference;
    L.push(`| \`${t}\`${isRef ? " (ref)" : ""} | ${x.status} | ${x.ok}/${x.n} | ${x.challenged} | ${x.codes} | ${x.medianMs ?? "—"} | ${isRef ? "0" : fmt(x.offsetMs)} | ${isRef ? "—" : x.baselineOffsetMs} | ${isRef ? "—" : fmt(x.excessMs)} | ${isRef ? "—" : x.breach ? "**YES**" : "no"} | ${x.cache} | ${x.regions} | ${x.lang} |`);
  }
  const pages = Object.keys(baseline.targets).map((t) => v.targets[t]).filter((x) => x.lang !== "-");
  const he = pages.filter((x) => x.lang === "he").length;
  L.push("");
  L.push(`Hebrew default (no cookie): ${he}/${pages.length} HTML pages served \`lang="he"\`.`);
  if (v.targets[baseline.reference].cache !== "HIT") L.push(`\nNote: the reference was not a CDN HIT this run (${v.targets[baseline.reference].cache}).`);
  L.push("");
  L.push(`Baseline: ${baseline.provenance.measuredAt}, ${baseline.provenance.measuredFrom}, flag ${baseline.provenance.flagState}. Alert-only: nothing is rolled back or changed.`);
  return L.join("\n") + "\n";
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const samples = arg(argv, "--samples");
  if (!samples) { console.error("--samples is required"); return 2; }
  const baseline = JSON.parse(fs.readFileSync(arg(argv, "--baseline") ?? path.join(HERE, "prod-baseline.json"), "utf8"));
  const rows = parseTsv(fs.readFileSync(samples, "utf8"));
  let prev = null;
  const prevPath = arg(argv, "--prev");
  if (prevPath && fs.existsSync(prevPath)) {
    try { prev = JSON.parse(fs.readFileSync(prevPath, "utf8")); } catch { prev = null; }
  }
  const force = argv.includes("--force-breach");
  const v = evaluate({ rows, baseline, prev, force });
  const summary = renderSummary(v, baseline);
  process.stdout.write(summary);
  const s = arg(argv, "--summary");
  if (s) fs.appendFileSync(s, summary + "\n");
  const out = arg(argv, "--state-out");
  if (out) {
    const state = { schema: 1, at: v.at, runId: arg(argv, "--run-id") ?? null, force, breaching: v.breaching, alert: v.alert, breaches: v.breaches,
      fivexx: v.fivexx, unreachable: v.unreachable, inconclusive: v.inconclusive, latencyInconclusive: v.latencyInconclusive,
      targets: Object.fromEntries(Object.entries(v.targets).map(([t, x]) => [t, { status: x.status, medianMs: x.medianMs, excessMs: x.excessMs ?? null, cache: x.cache, regions: x.regions }])) };
    fs.writeFileSync(out, JSON.stringify(state, null, 2) + "\n");
  }
  if (v.inconclusive.length || v.latencyInconclusive) console.log(`::warning::monitor INCONCLUSIVE for ${v.inconclusive.join(", ") || "latency"} (Vercel checkpoint challenge or mixed results — not treated as an outage)`);
  if (v.alert) console.log(`::error::SUSTAINED Production breach: ${v.reasons.join("; ")}`);
  else if (v.breaching) console.log(`::warning::Production breaching this run only (${v.reasons.join("; ")}) — alerts only if the next scheduled run also breaches`);
  return v.alert ? 1 : 0;
}

function selfTest() {
  const baseline = JSON.parse(fs.readFileSync(path.join(HERE, "prod-baseline.json"), "utf8"));
  const pages = Object.keys(baseline.targets);
  const all = [baseline.reference, ...pages];
  const row = (target, round, code, ttfb, extra = {}) => ({ target, round, code, ttfb_ms: ttfb, total_ms: ttfb, curl_exit: code === 0 ? 28 : 0, mitigated: "-", cache: "HIT", regions: "iad1", lang: "he", ...extra });
  // ms(target) -> ttfb; each target gets a warm-up (round 0, 5000 ms: must be ignored) + 5 samples.
  const make = (ms, over = () => null) => all.flatMap((t) => [row(t, 0, 200, 5000), ...[1, 2, 3, 4, 5].map((r) => over(t, r) ?? row(t, r, 200, ms(t)))]);
  const healthy = (t) => 200 + (baseline.targets[t]?.offsetMs ?? 0);
  const recent = { at: new Date(Date.now() - 15 * 60000).toISOString(), breaching: true, runId: "prev" };
  const stale = { at: new Date(Date.now() - 600 * 60000).toISOString(), breaching: true, runId: "old" };
  const slow = (k) => (t) => healthy(t) + (pages.indexOf(t) >= 0 && pages.indexOf(t) < k ? 300 : 0);
  const ev = (rows, prev = null, force = false) => evaluate({ rows, baseline, prev, force });
  const cases = [
    ["healthy run: not breaching, no alert (warm-up outliers ignored)", () => { const v = ev(make(healthy), recent); return !v.breaching && !v.alert && v.breaches === 0; }],
    ["3 targets +300 ms, no previous: breaching but NO alert (single spike)", () => { const v = ev(make(slow(3))); return v.breaching && !v.alert; }],
    ["3 targets +300 ms, previous breaching: ALERT", () => ev(make(slow(3)), recent).alert],
    ["2 targets +300 ms, previous breaching: not breaching (needs >=3)", () => { const v = ev(make(slow(2)), recent); return !v.breaching && !v.alert && v.breaches === 2; }],
    ["+240 ms on every page: under the 250 ms threshold", () => !ev(make((t) => healthy(t) + (t === baseline.reference ? 0 : 240)), recent).breaching],
    ["absolute slowness that moves the reference too (runner location) is NOT a breach", () => !ev(make((t) => healthy(t) + 400), recent).breaching],
    ["one cold-start sample of 3000 ms per target: median absorbs it", () => !ev(make(healthy, (t, r) => (r === 1 ? row(t, r, 200, 3000) : null)), recent).breaching],
    ["stale previous state (600 min) is ignored: no alert", () => { const v = ev(make(slow(3)), stale); return v.breaching && !v.alert; }],
    ["previous healthy: no alert", () => !ev(make(slow(5)), { ...recent, breaching: false }).alert],
    ["any 5xx is breaching (and alerts when sustained)", () => { const v = ev(make(healthy, (t, r) => (t === "/login" && r === 3 ? row(t, r, 502, 100) : null)), recent); return v.breaching && v.alert && v.fivexx.includes("/login"); }],
    ["timeouts on a target: UNREACHABLE, breaching", () => { const v = ev(make(healthy, (t, r) => (t === "/home" && r <= 3 ? row(t, r, 0, 20000) : null))); return v.breaching && v.unreachable.includes("/home"); }],
    ["404 on a target: UNREACHABLE (non-2xx/3xx)", () => ev(make(healthy, (t) => (t === "/app" ? row(t, 1, 404, 100) : null))).unreachable.includes("/app")],
    ["3xx redirect counts as up", () => !ev(make(healthy, (t, r) => (t === "/app" ? row(t, r, 307, 200) : null)), recent).breaching],
    ["checkpoint challenge (403 + mitigated) on every target: INCONCLUSIVE, never breaching", () => { const v = ev(make(healthy, (t, r) => row(t, r, 403, 50, { mitigated: "challenge" })), recent); return !v.breaching && !v.alert && v.inconclusive.length === all.length && v.latencyInconclusive; }],
    ["plain 403 (no mitigated header) is NOT a challenge: UNREACHABLE", () => ev(make(healthy, (t, r) => (t === "/about" ? row(t, r, 403, 50) : null))).unreachable.includes("/about")],
    ["challenged reference: latency inconclusive, slow pages do not breach", () => { const v = ev(make(slow(5), (t, r) => (t === baseline.reference ? row(t, r, 403, 50, { mitigated: "challenge" }) : null)), recent); return v.latencyInconclusive && !v.breaching; }],
    ["--force-breach on a healthy run: ALERT (proves the failure path)", () => ev(make(healthy), null, true).alert],
    ["--force-breach alerts even when the checkpoint challenged everything", () => ev(make(healthy, (t, r) => row(t, r, 403, 50, { mitigated: "challenge" })), null, true).alert],
  ];
  let ok = true;
  for (const [name, fn] of cases) {
    let pass = false;
    try { pass = fn() === true; } catch (e) { console.log(String(e)); }
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  }
  const sum = renderSummary(ev(make(slow(3)), recent), baseline);
  const pub = !/@|cookie|token|password|secret/i.test(sum.replace(/no cookie/g, ""));
  console.log(`${pub ? "PASS" : "FAIL"}  summary contains only paths, codes, timings`);
  ok &&= pub;
  console.log(ok ? `prod-monitor evaluator self-test: ${cases.length + 1} checks passed` : "prod-monitor evaluator self-test FAILED");
  return ok;
}

const argv = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(argv.includes("--self-test") ? (selfTest() ? 0 : 1) : main(argv));
}
