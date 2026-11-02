export function cleanOCRText(raw: string): string {
  if (!raw) return "";

  let text = raw;

  text = text.replace(/[\u200e\u200f\u202a-\u202e]/g, "");

  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\r/g, "\n");

  text = text.replace(/₪/g, " ₪ ");

  text = text.replace(/([0-9])([א-תA-Za-z])/g, "$1 $2");
  text = text.replace(/([א-תA-Za-z])([0-9])/g, "$1 $2");

  // Each decimal amount on its own line — the WHOLE amount: "1,180.00" stays one number. Matching only
  // `\d+\.\d{2}` cut it into "1," and "180.00", so every amount of 1,000 and up lost its thousands and the
  // VAT line could win as the total (an invoice of 1,180.00 was read as 180, with high confidence).
  text = text.replace(/(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})/g, "\n$1\n");

  const anchors = [
    "סהכ בשח",
    'סה"כ בש"ח',
    "סה״כ בש״ח",
    "סהכ",
    'סה"כ',
    "סה״כ",
    "סך הכל",
    "לתשלום",
    "תאריך",
    "קבלה",
    "חשבונית",
    "אשראי",
    "העברה",
    "מזומן",
    "סוג כרטיס",
    "מס כרטיס",
    "תוקף כרטיס",
  ];

  for (const anchor of anchors) {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), `\n${anchor}\n`);
  }

  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  return text.trim();
}