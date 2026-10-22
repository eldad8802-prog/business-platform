/**
 * Shared scenarios for the per-currency totals tests (audit B2/B3). TEST-ONLY.
 *
 * `per-currency-main-06f425ea.json` beside this file is the output of these exact scenarios run on
 * origin/main 06f425ea — BEFORE the per-currency change — with every row in ILS. The tests run the
 * same scenarios on the current code and require every field main produced to be byte-identical;
 * only new fields may appear.
 *
 * `matches` applies the same where-clause the Home services build to in-memory rows; the Home
 * test's transaction stand-in uses it so main (aggregate) and this branch (groupBy) read the same data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";

export const D = (s: string) => new Prisma.Decimal(s);

export type StubRow = { amount: Prisma.Decimal; currency: string; createdAt: Date; status: string };

/** 2026-10-14 15:25 in Israel. */
export const NOW = new Date("2026-10-14T12:25:00Z");

export function ilsRows(): StubRow[] {
  return (
    [
      ["2026-10-14T05:10:00Z", "120.00"], ["2026-10-14T06:45:00Z", "80.50"], ["2026-10-14T06:59:00Z", "0.10"],
      ["2026-10-14T11:00:00Z", "999.99"], ["2026-10-13T07:00:00Z", "300.00"], ["2026-10-13T13:30:00Z", "45.45"],
      ["2026-10-12T09:00:00Z", "10.00"], ["2026-10-09T09:00:00Z", "77.70"], ["2026-10-05T09:00:00Z", "1.01"],
      ["2026-10-01T09:00:00Z", "5000.00"], ["2026-09-20T09:00:00Z", "2500.25"], ["2026-09-30T21:30:00Z", "33.33"],
      ["2026-09-03T09:00:00Z", "0.00"],
    ] as const
  ).map(([iso, a]) => ({ amount: D(a), currency: "ILS", createdAt: new Date(iso), status: "PAID" }));
}

export type Where = {
  status?: string;
  amount?: { gt?: number };
  createdAt?: { gte?: Date; lt?: Date };
};

export function matches(r: StubRow, where: Where): boolean {
  if (where.status && r.status !== where.status) return false;
  if (where.amount?.gt !== undefined && !r.amount.greaterThan(where.amount.gt)) return false;
  const c = where.createdAt;
  if (c?.gte && r.createdAt < c.gte) return false;
  if (c?.lt && r.createdAt >= c.lt) return false;
  return true;
}

/** The pre-change output captured from main (all-ILS data). */
export function mainFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(__dirname, "per-currency-main-06f425ea.json"), "utf8"));
}

/**
 * Every leaf `before` has must be present in `after` with the identical JSON value; `after` may only
 * ADD fields. Returns the list of differences (empty = compatible) and how many leaves were compared.
 */
export function legacyDiff(before: unknown, after: unknown, at = ""): { diffs: string[]; leaves: number } {
  const diffs: string[] = [];
  let leaves = 0;
  const walk = (x: unknown, y: unknown, p: string) => {
    if (x === null || typeof x !== "object") {
      leaves += 1;
      if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${p}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
      return;
    }
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || y.length !== x.length) {
        diffs.push(`${p}: array shape changed`);
        return;
      }
      x.forEach((v, i) => walk(v, y[i], `${p}[${i}]`));
      return;
    }
    for (const k of Object.keys(x)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown> | undefined)?.[k], `${p}.${k}`);
  };
  walk(before, after, at);
  return { diffs, leaves };
}
