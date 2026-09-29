/**
 * Content evidence — pure. No database.
 *   npx tsx lib/services/content/content-evidence.verify.test.ts
 */

import { buildInputSnapshotData } from "@/lib/services/content-plan-persistence-v1.service";
import { sanitizeContentInsightAnswers } from "@/lib/services/content/content-insight-snapshot";
import { contentDecisionPayload } from "@/lib/services/content/content-decision.evidence";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (!condition) {
    console.error("FAIL:", name);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

const answers = sanitizeContentInsightAnswers([
  {
    questionFamily: "hesitation",
    questionVariantId: "q1",
    text: "לקוחות חוששים מהמחיר",
    chipsUsed: ["מחיר"],
    recordedAtIso: "2026-09-01T00:00:00.000Z",
    script: "should not survive",
  },
]);

ok("insight answer text survives", answers?.[0]?.text === "לקוחות חוששים מהמחיר");
ok(
  "insight snapshot drops fields that are not the answer",
  answers?.[0] !== undefined && !("script" in answers[0])
);

const snapshot = buildInputSnapshotData({
  goal: "trust",
  contentInsightAnswers: [
    {
      questionFamily: "result",
      questionVariantId: "r1",
      text: "אחרי חודש רואים שינוי",
    },
  ],
});

ok(
  "plan snapshot keeps insight answers",
  Array.isArray(snapshot.contentInsightAnswers) &&
    snapshot.contentInsightAnswers[0]?.text === "אחרי חודש רואים שינוי"
);
ok(
  "omitted insight answers are explicit null",
  buildInputSnapshotData({}).contentInsightAnswers === null
);

const script = "FULL SCRIPT THAT MUST NOT BE COPIED INTO EVIDENCE";
const payload = contentDecisionPayload("trust");
const encoded = JSON.stringify(payload);
ok("decision payload names the variant", payload.data.variantKey === "trust");
ok("decision payload does not contain a script argument", !encoded.includes(script));
ok("decision payload data has only the variant key", Object.keys(payload.data).join(",") === "variantKey");

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\ncontent evidence: all checks passed");
