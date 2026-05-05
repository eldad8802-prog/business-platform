import fs from "fs";
import { runUnifiedDocumentIntelligence } from "../lib/services/documents/unified-extraction-engine.service";

async function main() {
  const raw65 = JSON.parse(fs.readFileSync("tmp/doc65.json", "utf8")).document
    .ocrText as string;
  const u65 = await runUnifiedDocumentIntelligence({
    businessId: 1,
    rawText: raw65,
  });

  const text270 = `רמי לוי בעמ
קבלה
סהכ לתשלום
ש"ח 270.00
שולם במזומן`;
  const u270 = await runUnifiedDocumentIntelligence({
    businessId: 1,
    rawText: text270,
  });

  const rawZeroElig = `קבלה
פריט 12.00
פריט 15.00`;
  const uZero = await runUnifiedDocumentIntelligence({
    businessId: 1,
    rawText: rawZeroElig,
  });

  const rawTwoElig = `סה"כ 100.00
סה"כ 200.00
שולם`;
  const uTwo = await runUnifiedDocumentIntelligence({
    businessId: 1,
    rawText: rawTwoElig,
  });

  console.log(
    JSON.stringify(
      {
        doc65_amount: u65.amount,
        receipt270_amount: u270.amount,
        syntheticZeroEligible_amount: uZero.amount,
        syntheticTwoDistinct_amount: uTwo.amount,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
