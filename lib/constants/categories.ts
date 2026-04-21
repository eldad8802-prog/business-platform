export const CATEGORIES = [
  { value: "fuel", label: "דלק" },
  { value: "equipment", label: "ציוד" },
  { value: "supplies", label: "חומרים" },
  { value: "services", label: "שירותים" },

  { value: "rent", label: "שכירות" },
  { value: "utilities", label: "חשמל ומים" },
  { value: "internet", label: "אינטרנט ותקשורת" },

  { value: "salary", label: "שכר" },
  { value: "outsourcing", label: "קבלנים חיצוניים" },

  { value: "marketing", label: "שיווק" },
  { value: "advertising", label: "פרסום" },

  { value: "tax", label: "מיסים" },
  { value: "insurance", label: "ביטוחים" },
  { value: "fees", label: "עמלות" },

  { value: "general", label: "כללי" },
];

export const CATEGORY_MAP: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label])
);