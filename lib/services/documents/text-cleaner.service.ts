export function cleanOCRText(raw: string): string {
  if (!raw) return "";

  let text = raw;

  text = text.replace(/[\u200e\u200f\u202a-\u202e]/g, "");

  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\r/g, "\n");

  text = text.replace(/₪/g, " ₪ ");

  text = text.replace(/([0-9])([א-תA-Za-z])/g, "$1 $2");
  text = text.replace(/([א-תA-Za-z])([0-9])/g, "$1 $2");

  text = text.replace(/(\d+\.\d{2})/g, "\n$1\n");

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