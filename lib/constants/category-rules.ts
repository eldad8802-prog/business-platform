export const CATEGORY_RULES = [
  {
    category: "fuel",
    keywords: ["דלק", "פז", "סונול", "דור אלון", "תחנה"],
  },
  {
    category: "equipment",
    keywords: ["ציוד", "כלי", "מכשיר", "אביזר"],
  },
  {
    category: "supplies",
    keywords: ["חומרים", "אספקה", "מלאי"],
  },
  {
    category: "services",
    keywords: ["שירות", "תיקון", "תחזוקה"],
  },
  {
    category: "marketing",
    keywords: ["פרסום", "קמפיין", "מודעה", "פייסבוק", "גוגל"],
  },
  {
    // A payment of tax — to the tax authority — not a document that MENTIONS tax. "מע״מ" and "חשבונית מס"
    // are printed on nearly every Israeli invoice and receipt, so they made "tax" the category of any
    // expense with no other keyword (a café receipt included). They are the document's vocabulary, not its
    // subject, and are deliberately absent here.
    category: "tax",
    keywords: [
      "מסים",
      "מס הכנסה",
      "רשות המסים",
      "ניכוי מס",
      "ניכוי מס במקור",
      "דוח מס",
      "מקדמות מס",
      "תשלום מע״מ",
      "תשלום מע\"מ",
      "דיווח מע״מ",
      "דיווח מע\"מ",
    ],
  },
  {
    category: "rent",
    keywords: ["שכירות", "שכר דירה"],
  },
];