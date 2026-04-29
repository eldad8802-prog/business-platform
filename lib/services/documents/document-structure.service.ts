export type DocumentStructure = {
  headerLines: string[];
  customerLines: string[];
  bodyLines: string[];
  totalLines: string[];
  paymentLines: string[];
  footerLines: string[];
  allLines: string[];
};

function normalize(line: string): string {
  return line.trim();
}

function isEmpty(line: string): boolean {
  return line.trim().length === 0;
}

function containsAny(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function parseDocumentStructure(text: string): DocumentStructure {
  const lines = text
    .split("\n")
    .map(normalize)
    .filter((l) => !isEmpty(l));

  const headerLines: string[] = [];
  const customerLines: string[] = [];
  const bodyLines: string[] = [];
  const totalLines: string[] = [];
  const paymentLines: string[] = [];
  const footerLines: string[] = [];

  const totalKeywords = [
    "סהכ",
    'סה"כ',
    "סה״כ",
    "סך הכל",
    "לתשלום",
    "total",
  ];

  const paymentKeywords = [
    "אשראי",
    "כרטיס",
    "visa",
    "mastercard",
    "מס כרטיס",
    "תוקף",
    "emv",
  ];

  const customerKeywords = [
    "לקוח",
    "לכבוד",
    "שם לקוח",
  ];

  // 🔥 חלוקה לפי מיקום + תוכן
  const headerZoneEnd = Math.floor(lines.length * 0.2);
  const footerZoneStart = Math.floor(lines.length * 0.85);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // HEADER
    if (i <= headerZoneEnd) {
      headerLines.push(line);
      continue;
    }

    // FOOTER
    if (i >= footerZoneStart) {
      footerLines.push(line);
      continue;
    }

    // TOTAL
    if (containsAny(line, totalKeywords)) {
      totalLines.push(line);
      continue;
    }

    // PAYMENT
    if (containsAny(line, paymentKeywords)) {
      paymentLines.push(line);
      continue;
    }

    // CUSTOMER
    if (containsAny(line, customerKeywords)) {
      customerLines.push(line);
      continue;
    }

    // BODY (ברירת מחדל)
    bodyLines.push(line);
  }

  return {
    headerLines,
    customerLines,
    bodyLines,
    totalLines,
    paymentLines,
    footerLines,
    allLines: lines,
  };
}