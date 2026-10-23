/**
 * Pure tests for .i18n/perf-lib.ts — the statistics and /proc parsing the i18n performance benchmark uses.
 * No DB, no network, no browser. Run: npx tsx .i18n/perf-lib.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_LOCALE } from "../lib/i18n/config";
import { getMessages } from "../lib/i18n/messages";
import { he as heBundled } from "../lib/i18n/messages/he";
import { alternate, childPids, delta, mdTable, parseProcStat, parseVmRss, quantile, summarize } from "./perf-lib";

let n = 0;
function test(name: string, fn: () => void) {
  fn();
  n++;
  console.log(`  ok ${name}`);
}

test("quantile is nearest-rank on an unsorted sample", () => {
  const s = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
  assert.equal(quantile(s, 0.5), 5);
  assert.equal(quantile(s, 0.95), 10);
  assert.equal(quantile(s, 0.99), 10);
  assert.equal(quantile(s, 0.1), 1);
  assert.equal(quantile([42], 0.99), 42);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  // input is not mutated
  assert.deepEqual(s, [5, 1, 4, 2, 3, 10, 9, 8, 7, 6]);
});

test("quantile over 1..100 matches the textbook ranks", () => {
  const s = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.equal(quantile(s, 0.5), 50);
  assert.equal(quantile(s, 0.95), 95);
  assert.equal(quantile(s, 0.99), 99);
});

test("summarize rounds to 0.01 ms and reports n/min/max/mean", () => {
  const sum = summarize([1.234, 2.345, 3.456]);
  assert.deepEqual(sum, { n: 3, p50: 2.35, p95: 3.46, p99: 3.46, mean: 2.35, min: 1.23, max: 3.46 });
  assert.equal(summarize([]).n, 0);
  assert.ok(Number.isNaN(summarize([]).p50));
});

test("delta is ON − OFF, with the p50 ratio", () => {
  const d = delta(summarize([10, 10, 10, 20]), summarize([12, 12, 12, 30]));
  assert.deepEqual(d, { p50: 2, p95: 10, p99: 10, p50Ratio: 1.2 });
  assert.ok(Number.isNaN(delta(summarize([0]), summarize([1])).p50Ratio));
});

test("alternate flips the order every round (ABBA)", () => {
  assert.deepEqual(alternate(["off", "on"], 0), ["off", "on"]);
  assert.deepEqual(alternate(["off", "on"], 1), ["on", "off"]);
  assert.deepEqual(alternate(["off", "on", "on-en"], 3), ["on-en", "on", "off"]);
  const v = ["a", "b"];
  alternate(v, 1);
  assert.deepEqual(v, ["a", "b"]);
});

test("parseProcStat reads ppid and utime+stime even when comm has spaces and parens", () => {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime …
  const stat = "4242 (next-server (v16.3.3)) S 4200 4200 4200 0 -1 4194560 100 0 0 0 150 37 0 0 20 0 11 0 999 1000 2000";
  assert.deepEqual(parseProcStat(stat), { ppid: 4200, ticks: 187 });
  assert.equal(parseProcStat("garbage"), null);
});

test("parseVmRss reads kB from /proc/<pid>/status", () => {
  assert.equal(parseVmRss("Name:\tnode\nVmPeak:\t  900 kB\nVmRSS:\t  123456 kB\nThreads:\t11\n"), 123456);
  assert.equal(parseVmRss("Name:\tnode\n"), null);
});

test("childPids walks every generation, excludes the root and unrelated processes", () => {
  const pairs = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 10 }, { pid: 99, ppid: 1 }];
  assert.deepEqual(childPids(10, pairs), [11, 12, 13]);
  assert.deepEqual(childPids(99, pairs), []);
});

test("mdTable renders a header, a separator and escapes pipes; NaN shows as —", () => {
  assert.equal(mdTable(["a", "b"], [[1, "x|y"], [NaN, "z"]]), "| a | b |\n|---|---|\n| 1 | x\\|y |\n| — | z |");
});

test("root layout payload change: the Hebrew dictionary it no longer serializes IS the object the provider bundles", () => {
  // app/layout.tsx passes `messages` only for a non-default locale; I18nProvider falls back to `he`
  // imported from lib/i18n/messages/he. Identity (not just deep equality) = the same strings, always.
  assert.equal(getMessages(DEFAULT_LOCALE), heBundled);
  assert.equal(DEFAULT_LOCALE, "he");
  assert.notEqual(getMessages("en"), heBundled);
});

console.log(`perf-lib: ${n} tests passed`);
