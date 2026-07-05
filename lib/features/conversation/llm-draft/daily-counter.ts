/**
 * Minimal in-process daily counter for actual LLM calls — a SCOPED fallback,
 * not a new subsystem. Keyed on the UTC day; resets lazily at midnight UTC.
 *
 * Caveat: the count is per Node process. With multiple instances the effective
 * cap is `cap × instances`. That is acceptable for a shadow COST brake (a soft
 * ceiling), and it never over-blocks. A precise global cap would need shared
 * storage — intentionally out of scope here.
 */
let currentDay = "";
let count = 0;

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function rollIfNeeded(): void {
  const day = utcDay();
  if (day !== currentDay) {
    currentDay = day;
    count = 0;
  }
}

/** Actual LLM calls made so far today (this process). */
export function getDailyLlmCount(): number {
  rollIfNeeded();
  return count;
}

/** Record that one actual LLM call was made. */
export function incrementDailyLlmCount(): void {
  rollIfNeeded();
  count += 1;
}
