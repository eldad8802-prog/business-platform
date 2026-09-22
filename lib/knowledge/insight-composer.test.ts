/**
 * M3 — the Dubiz Insight composer. Run:
 *   npx tsx lib/knowledge/insight-composer.test.ts
 *
 * What is guarded here is almost entirely about what the composer must NOT do. It is easy to make a
 * system that says something interesting; the contract that decides whether an owner keeps reading is
 * that every line is either true or clearly marked as an opinion, that nothing claims causality, and
 * that knowledge which has not earned ACTIVE never reaches the page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeMoneyPressure, composeInsights, type ComposerInput } from "./insight-composer";
import type { BusinessStatusItem } from "@/lib/business-status/types";

let failed = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`OK: ${name}`);
  else {
    failed += 1;
    console.error(`FAIL: ${name}`, extra ?? "");
  }
}

const fact = (itemId: string, domain: BusinessStatusItem["domain"], severity: BusinessStatusItem["severity"]): BusinessStatusItem => ({
  itemId, domain, severity,
  semanticCategory: "ACTION_REQUIRED",
  title: "t", summary: null, priorityScore: 1,
  entityRef: { type: "x", id: 1 }, state: "open",
  createdAt: "2026-09-22T00:00:00.000Z",
  primaryAction: { kind: "navigate", label: "l", href: "/" },
  sourceEngine: "e",
});

const measure = {
  measureKey: "documents.paperwork_lag",
  valueNumeric: 12.5, valueUnit: "days", observationCount: 6,
  trend: "WORSENING", ruleVersion: "v1", measureId: 77,
};

const input = (over: Partial<ComposerInput> = {}): ComposerInput => ({
  businessId: 9,
  facts: [
    fact("payables:overdue:1", "payables", "HIGH"),
    fact("payables:overdue:2", "payables", "CRITICAL"),
    fact("payables:due_soon:3", "payables", "LOW"),
    fact("documents:needs_review:10", "documents", "MEDIUM"),
  ],
  activeMeasures: [],
  ...over,
});

// ── It requires more than one domain ───────────────────────────────────────
{
  const payablesOnly = input({ facts: [fact("payables:overdue:1", "payables", "HIGH")] });
  ok("a single domain produces NO insight", composeMoneyPressure(payablesOnly) === null);

  const docsOnly = input({ facts: [fact("documents:needs_review:1", "documents", "MEDIUM")] });
  ok("documents alone produce NO insight", composeMoneyPressure(docsOnly) === null);

  const none = input({ facts: [] });
  ok("no facts produce NO insight", composeInsights(none).length === 0);
}

// ── The cross-domain case ──────────────────────────────────────────────────
{
  const d = composeMoneyPressure(input())!;
  ok("two domains produce an insight", d !== null);
  ok("it takes the highest severity present", d.severity === "CRITICAL", d.severity);
  ok("it states the overdue count", d.factLines.some((f) => f.text.includes("2 תשלומים עברו")));
  ok("it states the upcoming count", d.factLines.some((f) => f.text.includes("1 תשלומים מתקרבים")));
  ok("it states the paperwork count", d.factLines.some((f) => f.text.includes("1 מסמכים ממתינים")));
  ok("every fact line points at its source", d.factLines.every((f) => f.sourceRef.length > 0));
  ok("every contributing rule is named with a version",
    d.contributingRules.every((r) => r.ruleId.length > 0 && r.ruleVersion.length > 0));
  ok("the dedupe key is stable", d.dedupeKey === "payables.pressure_with_paperwork_backlog");
}

// ── Without a measure it says LESS, it does not guess ──────────────────────
{
  const d = composeMoneyPressure(input())!;
  ok("with no ACTIVE measure there is NO interpretation", d.interpretation === null);
  ok("…and the uncertainty says so plainly", (d.uncertainty ?? "").includes("אין מספיק היסטוריה"));
  ok("…and no fact line claims a habit", !d.factLines.some((f) => f.sourceKind === "measure"));
}

// ── With a measure it may interpret — clearly marked, never causal ─────────
{
  const d = composeMoneyPressure(input({ activeMeasures: [measure] }))!;
  ok("an ACTIVE measure becomes a fact line", d.factLines.some((f) => f.sourceKind === "measure"));
  ok("…that carries the observation count", d.factLines.some((f) => f.text.includes("6 מקרים")));
  ok("…and points at the measure artifact",
    d.factLines.some((f) => f.sourceRef === "knowledge-measure:77"));
  ok("interpretation is present and SEPARATE from the facts", typeof d.interpretation === "string");
  ok("interpretation is never stored inside a fact line",
    !d.factLines.some((f) => f.text === d.interpretation));
  ok("uncertainty names the sample size", (d.uncertainty ?? "").includes("6"));
  ok("DOC-04 is credited with its version",
    d.contributingRules.some((r) => r.ruleId === "DOC-04" && r.ruleVersion === "v1"));
}

// ── No causality, ever ─────────────────────────────────────────────────────
{
  const d = composeMoneyPressure(input({ activeMeasures: [measure] }))!;
  const causal = /בגלל|גורם ל|הוביל ל|כתוצאה מ|because|caused/;
  ok("no fact line claims causality", !d.factLines.some((f) => causal.test(f.text)));
  ok("the interpretation claims no causality", !causal.test(d.interpretation ?? ""));
}

// ── No fabricated numbers ──────────────────────────────────────────────────
{
  const d = composeMoneyPressure(input({ activeMeasures: [measure] }))!;
  const asJson = JSON.stringify(d);
  ok("the draft carries no confidence score", !/confidence/i.test(asJson));
  ok("the draft carries no probability or percentage", !/probability|\d+%/i.test(asJson));
  // Every number in a fact line must be traceable to an input, not conjured by the composer.
  ok("the lag number is the measure's own", d.factLines.some((f) => f.text.includes("12.5")));
}

// ── Suggestions are suggestions ────────────────────────────────────────────
{
  const d = composeMoneyPressure(input())!;
  ok("actions are offered, not taken", d.suggestedActions.length > 0);
  ok("no action is phrased as already done",
    !d.suggestedActions.some((a) => /בוצע|שולם בהצלחה|נשלח/.test(a)));
}

// ── The three levels stay separable, and only the first is authoritative ───
// Every fact can be correct while the interpretation joining them is wrong, or irrelevant, or right
// about a situation the owner already handled — and a suggested action can be wrong even when the
// interpretation is sound. The structure does not make an insight correct. It makes each level
// separately rejectable, so a bad interpretation can be dismissed without discrediting the facts
// underneath it. That is the property that has to survive when a reasoning layer writes the middle
// level instead of this file.
{
  const d = composeMoneyPressure(input({ activeMeasures: [measure] }))!;
  ok("facts are a list, each independently attributable",
    Array.isArray(d.factLines) && d.factLines.every((f) => f.text.length > 0 && f.sourceRef.length > 0));
  ok("interpretation is ONE field, never mixed into the facts",
    typeof d.interpretation === "string" && !d.factLines.some((f) => f.text === d.interpretation));
  ok("suggested actions are their own level — neither fact nor interpretation",
    d.suggestedActions.length > 0 &&
      !d.suggestedActions.some((a) => d.factLines.some((f) => f.text === a)) &&
      !d.suggestedActions.some((a) => a === d.interpretation));
  ok("dropping the interpretation leaves every fact intact and still attributable",
    d.factLines.every((f) => f.sourceRef.length > 0));
  ok("no fact line carries a suggestion verb — that belongs one level up",
    !d.factLines.some((f) => /כדאי|מומלץ|בדוק |עבור על/.test(f.text)));
}

// ── STATIC: the composer stays pure and blind to non-ACTIVE knowledge ──────
{
  const src = readFileSync(join(__dirname, "insight-composer.ts"), "utf8");
  ok("the composer imports no Prisma", !/@prisma\/client|lib\/prisma/.test(src));
  ok("the composer reads no clock", !/Date\.now\(\)|new Date\(\)/.test(src));
  ok("the composer reads no env", !/process\.env/.test(src));
  ok("the composer never mentions a non-ACTIVE status",
    !/INSUFFICIENT_EVIDENCE|STALE|SUPERSEDED/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")));

  const svc = readFileSync(join(__dirname, "insight.service.ts"), "utf8");
  ok("the service selects ACTIVE measures only", /status:\s*"ACTIVE"/.test(svc));
  ok("the owner decision requires a server-derived userId", /server-derived userId is required/.test(svc));
  ok("the decision write is tenant-predicated as well as tenant-scoped",
    /updateMany\(\{[\s\S]*?where:\s*\{\s*id:\s*insightId,\s*businessId\s*\}/.test(svc));
  // A refresh rewrites the CONTENT of an insight and must leave the decision alone. The precise
  // invariant is that the object handed to `update` carries no status/decision fields — checking for
  // the string "OPEN" anywhere would also match the read in `listOpenInsights`, which is not a write.
  const contentBlock = svc.slice(svc.indexOf("const content = {"), svc.indexOf("if (!existing)"));
  ok("the refreshed content sets no status", !/\bstatus\b/.test(contentBlock));
  ok("the refreshed content touches no owner decision", !/ownerDecision/.test(contentBlock));
  ok("…and the refresh really does write that content", /update\(\{\s*where:\s*\{\s*id:\s*existing\.id\s*\},\s*data:\s*content\s*\}\)/.test(svc));
}

console.log(failed === 0 ? "\nM3 composer: facts stay facts, opinions stay opinions. ✔" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
