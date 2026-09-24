const fs = require("fs");
const ed = (p, pairs) => { let s = fs.readFileSync(p, "utf8"); const crlf = s.includes("\r\n"); s = s.replace(/\r\n/g, "\n");
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(p + " miss: " + a.slice(0, 60)); s = s.replace(a, b); }
  fs.writeFileSync(p, crlf ? s.replace(/\n/g, "\r\n") : s); };
ed("scripts/ci/tenant-context-guard.sh", [
  ["knowledgeMeasure knowledgeMeasureEvidenceLink businessInsight", "knowledgeMeasure knowledgeMeasureEvidenceLink temporalKnowledge businessInsight"],
  ["            | grep -v 'measure-reconciler.ts$' | grep -v 'insight.service.ts$' \\n",
   "            | grep -v 'measure-reconciler.ts$' | grep -v 'insight.service.ts$' \\n            | grep -v '/temporal/temporal-writer.ts$' | grep -v 'knowledge-selector.ts$' \\n"],
  ["  can=$(grep -c \"tenantTx(businessId\" \"$ca\" || true)\n",
   "  can=$(grep -c \"tenantTx(businessId\" \"$ca\" || true)\n  # M6 — the temporal writer and the M7-facing selector are the two further named seams.\n  tw=$(grep -c \"tenantTx(businessId\" \"$ROOT/lib/knowledge/temporal/temporal-writer.ts\" 2>/dev/null || echo 0)\n  ks=$(grep -c \"tenantTx(businessId\" \"$ROOT/lib/knowledge/knowledge-selector.ts\" 2>/dev/null || echo 0)\n"],
  ["&& [ \"$can\" -ge 1 ] && [ \"$ins\" -ge 1 ] && n=1", "&& [ \"$can\" -ge 1 ] && [ \"$ins\" -ge 1 ] && [ \"$tw\" -ge 1 ] && [ \"$ks\" -ge 1 ] && n=1"],
]);
ed("app/api/knowledge/derive/route.ts", [
  ["  \"KnowledgeMeasure\",\n", "  \"KnowledgeMeasure\",\n  \"TemporalKnowledge\",\n"],
  ["    const insights = await generateInsightsForBusiness(businessId);\n",
   "    const insights = await generateInsightsForBusiness(businessId);\n    // M6 — temporal knowledge AS OF the same instant the measures were derived at.\n    const temporal = await deriveTemporalForBusiness(businessId, new Date(derivation.now));\n"],
  ["        insights: insights.length,", `        // Per temporal rule: outcome and COUNTS by knowledge type and status. No baseline, no value,
        // no entity id — the same public-log rule as the measures above.
        temporal: {
          asOf: temporal.asOf,
          rulesRun: temporal.rulesRun,
          rulesOk: temporal.rulesOk,
          rulesFailed: temporal.rulesFailed,
          totalDurationMs: temporal.totalDurationMs,
          rules: temporal.rules.map((r) => ({
            ruleId: r.ruleId, ruleVersion: r.ruleVersion, outcome: r.outcome, failedStage: r.failedStage,
            series: r.series, artifacts: r.artifacts, written: r.written, confirmed: r.confirmed,
            superseded: r.superseded, staled: r.staled, durationMs: r.durationMs,
          })),
        },
        insights: insights.length,`],
  ["import { generateInsightsForBusiness } from \"@/lib/knowledge/insight.service\";\n",
   "import { generateInsightsForBusiness } from \"@/lib/knowledge/insight.service\";\nimport { deriveTemporalForBusiness } from \"@/lib/knowledge/temporal/derive-temporal.service\";\n"],
]);
