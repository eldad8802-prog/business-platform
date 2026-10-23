#!/usr/bin/env node
/**
 * cross-currency-sum-guard — one rule: money of different currencies is never added together
 * silently.
 *
 * WHY
 *
 * Fifteen ledger tables already carry a `currency` column, and payment requests, payables
 * commitments, obligations and verified payments can be written in USD / EUR today. Every
 * cross-row total that adds `amount` without grouping by `currency` is correct only while every
 * row happens to be ILS — and the day one row is not, the number on the screen (or in the
 * accountant's file) is silently wrong. `FinancialRecord` has no currency column at all, so every
 * total over it is in the same position by construction. See docs/money/FINANCIAL-DATA-MODEL-AUDIT.md.
 *
 * WHAT IT CHECKS (application code: app/ lib/ features/ components/ hooks/, tests excluded)
 *
 * The money columns are not listed by hand: they are read from prisma/schema.prisma — every
 * numeric money-named field of a model that HAS a `currency` column, plus FinancialRecord.amount
 * (which has none). A site is a finding when it:
 *
 *   PRISMA_SUM   `<model>.aggregate(` / `<model>.groupBy(` on such a model, with `_sum` / `_avg`
 *                over a money column, and neither `by: [... "currency" ...]` nor a `currency`
 *                filter in the call;
 *   JS_FOLD      `.reduce(` whose callback reads a money column (`x.amount`, `a.allocatedAmount`)
 *                and adds it (`+` / `.plus(` / `.add(`), with no `currency` in the call or in the
 *                3 lines above it;
 *   JS_ACCUMULATE `+= <...>.<moneyColumn>` or `= <acc>.plus(<...>.<moneyColumn>)`, same exemption;
 *   SQL_SUM      `SUM(` / `AVG(` over a money column inside source text (raw SQL), with no
 *                `currency` in the 6 lines around it;
 *   FIRST_ROW_CURRENCY  a total labelled with the first row's currency (`xs[0].currency`,
 *                `items[0]?.currency`) — the "sum everything, call it ILS" pattern (audit R5).
 *
 * Calls that go through lib/money (`sumByCurrency`, `totalIn`) are never findings: they cannot
 * add across currencies.
 *
 * THE BASELINE IS NOT A PARKING SPACE
 *
 * scripts/ci/cross-currency-sum-guard.baseline.json lists every finding that existed when the
 * guard was introduced, each reviewed and given a risk (SAFE | LATENT | BROKEN) and a reason.
 *   - a NEW finding (not in the baseline)        → FAIL: group by currency / use sumByCurrency,
 *                                                  or add a reviewed baseline entry WITH a reason;
 *   - a STALE entry (baseline, no longer found)  → FAIL: the site was fixed or moved — delete or
 *                                                  update the entry (the baseline can only shrink
 *                                                  honestly);
 *   - an entry without risk/reason               → FAIL.
 * Entries are matched by (file, rule, normalised source line), never by line number, so an
 * unrelated edit above a site does not churn the baseline.
 *
 * WHAT IT DELIBERATELY DOES NOT DO (limits)
 *
 * It is a text scanner, not a type checker. It cannot see that `rows` came from one invoice
 * (single currency by construction) — that is what the baseline reason records. It does not see
 * money columns renamed through a mapping (`amountMinor` derived from `amount`), sums done in a
 * helper whose parameters are plain numbers, or spreadsheet formulas. A name collision (a non-money
 * `amount`) is possible and is resolved in the baseline. It never connects to anything.
 *
 * Run:  node scripts/ci/cross-currency-sum-guard.mjs [root]
 *       node scripts/ci/cross-currency-sum-guard.mjs --self-test
 *       node scripts/ci/cross-currency-sum-guard.mjs --print     (all current findings, JSON)
 * Exit: 0 PASS · 1 FAIL · 2 could not evaluate.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_PATH = "scripts/ci/cross-currency-sum-guard.baseline.json";
const SCAN_DIRS = ["app", "lib", "features", "components", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__tests__", "__fixtures__"]);
const SKIP_FILE = /\.(test|spec)\.|\.verify\.|\.d\.ts$/;
/** lib/money is the safe engine itself; lib/i18n/messages holds only strings. */
const SKIP_PREFIX = ["lib/money/", "lib/i18n/messages/"];
export const RISKS = ["SAFE", "LATENT", "BROKEN"];

const MONEY_NAME = /(amount|price|cost|total|minor|subtotal|vat|value|fee|balance)/i;
const NOT_MONEY_NAME = /(count|percent|rate|score|confidence|qty|quantity|index|sequence|version|days|hour|step|rows)/i;

// ── pure helpers (exercised by --self-test) ──────────────────────────────────────────────────

/** Models → { hasCurrency, money: Set<field> } from a Prisma schema source. */
export function parseMoneyModels(schemaSrc) {
  const models = new Map();
  let cur = null;
  for (const raw of schemaSrc.split(/\r?\n/)) {
    const line = raw.trim();
    const open = line.match(/^model (\w+) \{/);
    if (open) {
      cur = { name: open[1], hasCurrency: false, money: new Set() };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("}")) {
      models.set(cur.name, cur);
      cur = null;
      continue;
    }
    const f = line.match(/^(\w+)\s+(\w+)(\??)(\[\])?/);
    if (!f || line.startsWith("//") || line.startsWith("@@")) continue;
    const [, name, type] = f;
    if (name === "currency" && type === "String") cur.hasCurrency = true;
    // "discountAmount" contains "count": a name that ENDS as money is money whatever it contains.
    const endsAsMoney = /(amount|minor|price|cost|total|fee|balance)$/i.test(name);
    if (/^(Decimal|Float|Int|BigInt)$/.test(type) && MONEY_NAME.test(name) && (endsAsMoney || !NOT_MONEY_NAME.test(name))) cur.money.add(name);
  }
  return models;
}

/** The guarded set: money columns of currency-bearing models, plus FinancialRecord (no currency). */
export function guardedColumns(models) {
  const byModel = new Map();
  for (const m of models.values()) {
    if (m.money.size === 0) continue;
    if (m.hasCurrency || m.name === "FinancialRecord") byModel.set(m.name, m.money);
  }
  const columns = new Set();
  for (const s of byModel.values()) for (const c of s) columns.add(c);
  return { byModel, columns };
}

/** Text of a call starting at `openIdx` (the index of its "("), up to the balancing ")". */
export function callText(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length && i < openIdx + 6000; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx, openIdx + 6000);
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
export const normalise = (s) => s.trim().replace(/\s+/g, " ");

/** Findings in one file's source. */
export function scanSource(rel, src, guarded) {
  const out = [];
  const lines = src.split(/\r?\n/);
  const colAlt = [...guarded.columns].sort().join("|");
  if (!colAlt) return out;
  const memberRe = new RegExp(`\\.(${colAlt})\\b`);
  const lowerModels = new Map([...guarded.byModel.keys()].map((m) => [m.charAt(0).toLowerCase() + m.slice(1), m]));
  const above = (ln, n) => lines.slice(Math.max(0, ln - 1 - n), ln - 1).join("\n");
  const push = (rule, idx, column, model = null) => {
    const ln = lineOf(src, idx);
    out.push({ file: rel, line: ln, rule, model, column, match: normalise(lines[ln - 1] ?? "") });
  };

  // PRISMA_SUM
  for (const m of src.matchAll(/\.(\w+)\.(aggregate|groupBy)\(/g)) {
    const model = lowerModels.get(m[1]);
    if (!model) continue;
    const text = callText(src, m.index + m[0].length - 1);
    const sumBlock = text.match(/_(sum|avg)\s*:\s*\{([^}]*)\}/);
    if (!sumBlock) continue;
    const cols = [...guarded.byModel.get(model)].filter((c) => new RegExp(`\\b${c}\\s*:\\s*true`).test(sumBlock[2]));
    if (cols.length === 0) continue;
    if (/\bcurrency\b/.test(text)) continue; // grouped by or filtered to one currency
    push("PRISMA_SUM", m.index, cols.join(","), model);
  }

  // JS_FOLD
  for (const m of src.matchAll(/\.reduce\(/g)) {
    const text = callText(src, m.index + m[0].length - 1);
    const col = text.match(memberRe);
    if (!col) continue;
    if (!/\+|\.plus\(|\.add\(/.test(text)) continue;
    const ln = lineOf(src, m.index);
    if (/\bcurrency\b|sumByCurrency/.test(text) || /\bcurrency\b/.test(above(ln, 3))) continue;
    push("JS_FOLD", m.index, col[1]);
  }

  // JS_ACCUMULATE
  lines.forEach((line, i) => {
    if (/\.reduce\(/.test(line)) return; // already judged as a fold
    const acc = line.match(new RegExp(`\\+=\\s*[^;]*?\\.(${colAlt})\\b`)) ||
      line.match(new RegExp(`=\\s*[\\w.\\[\\]]+\\.plus\\([^;]*?\\.(${colAlt})\\b`));
    if (!acc) return;
    if (/\bcurrency\b/.test(line) || /\bcurrency\b/.test(above(i + 1, 3))) return;
    const idx = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
    push("JS_ACCUMULATE", idx, acc[1]);
  });

  // SQL_SUM
  const sqlRe = new RegExp(`\\b(SUM|AVG|sum|avg)\\s*\\(\\s*(?:\\w+\\.)?"?(${colAlt})"?\\s*\\)`, "g");
  for (const m of src.matchAll(sqlRe)) {
    const ln = lineOf(src, m.index);
    const around = lines.slice(Math.max(0, ln - 4), ln + 3).join("\n");
    if (/\bcurrency\b/.test(around)) continue;
    push("SQL_SUM", m.index, m[2]);
  }

  // FIRST_ROW_CURRENCY
  for (const m of src.matchAll(/\[0\]\??\.currency\b/g)) push("FIRST_ROW_CURRENCY", m.index, "currency");

  return out;
}

const keyOf = (f) => `${f.file}\u0000${f.rule}\u0000${f.match}`;

/** Compare findings with the baseline. Returns { newFindings, stale, invalid, matched }. */
export function evaluate(findings, baseline) {
  const invalid = [];
  const want = new Map();
  for (const e of baseline) {
    if (!e || typeof e.file !== "string" || typeof e.rule !== "string" || typeof e.match !== "string") {
      invalid.push(`malformed entry ${JSON.stringify(e)}`);
      continue;
    }
    if (!RISKS.includes(e.risk)) invalid.push(`${e.file} ${e.rule}: risk must be one of ${RISKS.join("|")}`);
    if (typeof e.reason !== "string" || e.reason.trim().length < 12) invalid.push(`${e.file} ${e.rule}: a reviewed reason is required`);
    const k = keyOf(e);
    want.set(k, (want.get(k) ?? 0) + (Number.isInteger(e.count) && e.count > 0 ? e.count : 1));
  }
  const have = new Map();
  for (const f of findings) have.set(keyOf(f), [...(have.get(keyOf(f)) ?? []), f]);
  const newFindings = [];
  const stale = [];
  let matched = 0;
  for (const [k, fs] of have) {
    const allowed = want.get(k) ?? 0;
    matched += Math.min(allowed, fs.length);
    if (fs.length > allowed) newFindings.push(...fs.slice(allowed));
  }
  for (const [k, n] of want) {
    const got = have.get(k)?.length ?? 0;
    if (got < n) {
      const [file, rule, match] = k.split("\u0000");
      stale.push({ file, rule, match, expected: n, found: got });
    }
  }
  return { newFindings, stale, invalid, matched };
}

// ── repository I/O ───────────────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts)$/.test(entry) && !SKIP_FILE.test(entry)) out.push(full);
  }
  return out;
}

export function scanRepo(root) {
  const guarded = guardedColumns(parseMoneyModels(readFileSync(path.join(root, "prisma/schema.prisma"), "utf8")));
  const findings = [];
  let files = 0;
  for (const d of SCAN_DIRS) {
    for (const full of walk(path.join(root, d))) {
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (SKIP_PREFIX.some((p) => rel.startsWith(p))) continue;
      files++;
      findings.push(...scanSource(rel, readFileSync(full, "utf8"), guarded));
    }
  }
  return { guarded, findings, files };
}

// ── self-test: every rule must be able to fail, every exemption must hold ────────────────────

function selfTest() {
  const schema = `
model Invoice {
  id       Int     @id
  totalAmount Decimal @db.Decimal(18, 2)
  lineCount Int
  discountAmount Float?
  currency String @default("ILS")
}
model FinancialRecord {
  id     Int   @id
  amount Float
}
model Note {
  id Int @id
  price Float
}`;
  const g = guardedColumns(parseMoneyModels(schema));
  const scan = (src) => scanSource("lib/x.ts", src, g);
  const rules = (src) => scan(src).map((f) => f.rule).sort().join(",");
  const cases = [
    ["schema: Invoice.totalAmount guarded", () => g.byModel.get("Invoice")?.has("totalAmount") === true],
    ["schema: counts are not money", () => !g.byModel.get("Invoice")?.has("lineCount")],
    ["schema: discountAmount is money although it contains 'count'", () => g.byModel.get("Invoice")?.has("discountAmount") === true],
    ["schema: FinancialRecord guarded although it has no currency", () => g.byModel.get("FinancialRecord")?.has("amount") === true],
    ["schema: a model without currency is not guarded", () => !g.byModel.has("Note")],
    ["PRISMA_SUM: _sum over a guarded column is caught", () => rules(`await tx.invoice.aggregate({ where: { businessId }, _sum: { totalAmount: true } });`) === "PRISMA_SUM"],
    ["PRISMA_SUM: multi-line call is caught", () => rules(`await db.financialRecord.aggregate({\n  where: { direction: "income" },\n  _sum: { amount: true },\n});`) === "PRISMA_SUM"],
    ["PRISMA_SUM: groupBy by currency is exempt", () => rules(`await tx.invoice.groupBy({ by: ["currency"], _sum: { totalAmount: true } });`) === ""],
    ["PRISMA_SUM: a currency filter is exempt", () => rules(`await tx.invoice.aggregate({ where: { currency: base }, _sum: { totalAmount: true } });`) === ""],
    ["PRISMA_SUM: _count only is not a sum", () => rules(`await tx.invoice.groupBy({ by: ["status"], _count: { _all: true } });`) === ""],
    ["PRISMA_SUM: an unguarded model is ignored", () => rules(`await tx.note.aggregate({ _sum: { price: true } });`) === ""],
    ["JS_FOLD: reduce adding a money column is caught", () => rules(`const t = rows.reduce((s, r) => s + r.amount, 0);`) === "JS_FOLD"],
    ["JS_FOLD: Decimal .plus fold is caught", () => rules(`const t = rows.reduce((s, r) => s.plus(r.totalAmount), ZERO);`) === "JS_FOLD"],
    ["JS_FOLD: a currency filter on the line above is exempt", () => rules(`const xs = rows.filter((r) => r.currency === c);\nconst t = xs.reduce((s, r) => s + r.amount, 0);`) === ""],
    ["JS_FOLD: a fold over counts is ignored", () => rules(`const t = rows.reduce((s, r) => s + r.lineCount, 0);`) === ""],
    ["JS_ACCUMULATE: += money column is caught", () => rules(`for (const r of rows) {\n  total += r.amount;\n}`) === "JS_ACCUMULATE"],
    ["JS_ACCUMULATE: x = x.plus(r.money) is caught", () => rules(`for (const r of rows) {\n  total = total.plus(r.totalAmount);\n}`) === "JS_ACCUMULATE"],
    ["JS_ACCUMULATE: currency-guarded loop is exempt", () => rules(`for (const r of rows) {\n  if (r.currency !== base) continue;\n  total += r.amount;\n}`) === ""],
    ["SQL_SUM: raw SUM over a money column is caught", () => rules('const q = sql`SELECT SUM("totalAmount") FROM "Invoice" WHERE x`;') === "SQL_SUM"],
    ["SQL_SUM: GROUP BY currency nearby is exempt", () => rules('const q = sql`SELECT currency, SUM("totalAmount")\nFROM "Invoice" GROUP BY currency`;') === ""],
    ["FIRST_ROW_CURRENCY: labelling a total with rows[0].currency is caught", () => rules(`return { total, currency: rows[0].currency };`) === "FIRST_ROW_CURRENCY"],
    ["FIRST_ROW_CURRENCY: optional chaining form is caught", () => rules(`const c = items[0]?.currency ?? "ILS";`) === "FIRST_ROW_CURRENCY"],
    ["callText: parentheses inside strings do not end the call", () => callText(`f(")", (a) => a)`, 1) === `(")", (a) => a)`],
  ];
  const f1 = { file: "lib/a.ts", line: 3, rule: "JS_FOLD", match: "x" };
  const ok = (e) => ({ ...e, risk: "LATENT", reason: "only ILS rows today, see audit" });
  const evalCases = [
    ["baseline: a known finding passes", () => { const v = evaluate([f1], [ok(f1)]); return !v.newFindings.length && !v.stale.length && !v.invalid.length; }],
    ["baseline: a NEW finding fails", () => evaluate([f1, { ...f1, match: "y" }], [ok(f1)]).newFindings.length === 1],
    ["baseline: a second identical site beyond `count` fails", () => evaluate([f1, { ...f1, line: 9 }], [ok(f1)]).newFindings.length === 1],
    ["baseline: `count` admits identical sites", () => evaluate([f1, { ...f1, line: 9 }], [{ ...ok(f1), count: 2 }]).newFindings.length === 0],
    ["baseline: a STALE entry fails", () => evaluate([], [ok(f1)]).stale.length === 1],
    ["baseline: line numbers do not matter", () => evaluate([{ ...f1, line: 300 }], [ok(f1)]).newFindings.length === 0],
    ["baseline: an entry without a reason fails", () => evaluate([f1], [{ ...f1, risk: "SAFE" }]).invalid.length === 1],
    ["baseline: an unknown risk fails", () => evaluate([f1], [{ ...ok(f1), risk: "FINE" }]).invalid.length === 1],
  ];
  let failed = 0;
  for (const [name, fn] of [...cases, ...evalCases]) {
    let pass = false;
    try { pass = fn() === true; } catch { pass = false; }
    if (!pass) failed++;
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}`);
  }
  const total = cases.length + evalCases.length;
  if (failed) {
    console.log(`cross-currency-sum-guard self-test: ${failed} of ${total} FAILED`);
    process.exit(1);
  }
  console.log(`cross-currency-sum-guard self-test: ${total} passed`);
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
  } else {
    const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
    let repo, baseline;
    try {
      repo = scanRepo(root);
      const doc = JSON.parse(readFileSync(path.join(root, BASELINE_PATH), "utf8"));
      baseline = Array.isArray(doc.findings) ? doc.findings : [];
    } catch (error) {
      console.error(`cross-currency-sum-guard: could not evaluate — ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    if (args.includes("--print")) {
      console.log(JSON.stringify(repo.findings, null, 2));
      process.exit(0);
    }
    const v = evaluate(repo.findings, baseline);
    const risk = (r) => baseline.filter((e) => e.risk === r).reduce((n, e) => n + (e.count ?? 1), 0);
    console.log(`guarded money columns: ${[...repo.guarded.byModel].map(([m, s]) => `${m}(${[...s].join(",")})`).join(" ")}`);
    console.log(`application files scanned: ${repo.files}; findings: ${repo.findings.length}; baselined: ${v.matched} (SAFE ${risk("SAFE")} · LATENT ${risk("LATENT")} · BROKEN ${risk("BROKEN")})`);
    for (const i of v.invalid) console.log(`  [FAIL] INVALID BASELINE ENTRY ${i}`);
    for (const s of v.stale) console.log(`  [FAIL] STALE ${s.file} ${s.rule} (expected ${s.expected}, found ${s.found}): ${s.match}`);
    for (const f of v.newFindings) console.log(`  [FAIL] NEW ${f.file}:${f.line} ${f.rule} ${f.model ?? ""}${f.model ? "." : ""}${f.column}: ${f.match}`);
    if (v.invalid.length || v.stale.length || v.newFindings.length) {
      console.log(
        "\nA NEW finding adds money without grouping by currency. Group by currency (Prisma `by: [\"currency\"]`,\n" +
          "a per-currency Map) or use lib/money sumByCurrency / totalIn. If the site is single-currency by\n" +
          "construction, add a baseline entry WITH its risk and reason — that is a reviewed decision.\n" +
          "A STALE entry means the site was fixed or moved: update or delete the entry."
      );
      console.log("\nCROSS-CURRENCY SUM GUARD: FAIL");
      process.exit(1);
    }
    console.log("\nCROSS-CURRENCY SUM GUARD: PASS");
  }
}
