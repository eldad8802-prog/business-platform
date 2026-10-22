/**
 * Shared scenarios for the per-currency totals tests (audit B2/B3). TEST-ONLY.
 *
 * `per-currency-main-06f425ea.json` beside this file is the output of these exact scenarios run on
 * origin/main 06f425ea — BEFORE the per-currency change — with every row in ILS. The tests run the
 * same scenarios on the current code and require every field main produced to be byte-identical;
 * only new fields may appear.
 *
 * `stubTx` answers the Prisma calls the Home read models make (findMany / aggregate / groupBy, plus
 * the two activity counts) from in-memory rows, applying the same where-clause the services build,
 * so main (aggregate) and this branch (groupBy) read the same data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

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

type Where = {
  status?: string;
  amount?: { gt?: number };
  createdAt?: { gte?: Date; lt?: Date };
};

function matches(r: StubRow, where: Where): boolean {
  if (where.status && r.status !== where.status) return false;
  if (where.amount?.gt !== undefined && !r.amount.greaterThan(where.amount.gt)) return false;
  const c = where.createdAt;
  if (c?.gte && r.createdAt < c.gte) return false;
  if (c?.lt && r.createdAt >= c.lt) return false;
  return true;
}

/** Replaces `prisma.$transaction` with an in-memory transaction over `rows`. */
export function stubTx(rows: StubRow[]): { calls: string[] } {
  const calls: string[] = [];
  const tx = {
    $queryRaw: () => Promise.resolve([]),
    $executeRaw: () => Promise.resolve(0),
    paymentTransaction: {
      findMany: async ({ where, select, orderBy }: { where: Where; select: Record<string, boolean>; orderBy?: { createdAt?: string } }) => {
        calls.push("findMany");
        let out = rows.filter((r) => matches(r, where));
        if (orderBy?.createdAt === "asc") out = [...out].sort((a, b) => +a.createdAt - +b.createdAt);
        return out.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, (r as Record<string, unknown>)[k]])));
      },
      aggregate: async ({ where }: { where: Where }) => {
        calls.push("aggregate");
        const m = rows.filter((r) => matches(r, where));
        return {
          _sum: { amount: m.length ? m.reduce((s, r) => s.plus(r.amount), D("0")) : null },
          _count: { _all: m.length },
        };
      },
      groupBy: async ({ where, by }: { where: Where; by: string[] }) => {
        calls.push(`groupBy:${by.join(",")}`);
        const m = rows.filter((r) => matches(r, where));
        const groups = new Map<string, StubRow[]>();
        for (const r of m) groups.set(r.currency, [...(groups.get(r.currency) ?? []), r]);
        return [...groups].map(([currency, rs]) => ({
          currency,
          _sum: { amount: rs.reduce((s, r) => s.plus(r.amount), D("0")) },
          _count: { _all: rs.length },
        }));
      },
    },
    billingDocument: { count: async () => 3 },
    lead: { count: async () => 2 },
  };
  (prisma as unknown as { $transaction: unknown }).$transaction = async (fn: (client: unknown) => Promise<unknown>) => fn(tx);
  return { calls };
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
