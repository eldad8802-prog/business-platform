export type ContentDirectionType =
  | "lead_generation"
  | "trust_building"
  | "promotion"
  | "education";

export type ContentDirection = {
  id: string;
  title: string;
  description: string;
  reason: string;
  type: ContentDirectionType;
};

type GetContentDirectionsInput = {
  category: string;
  subCategory?: string;
  businessModel?: string;
  hasContentActivity?: boolean;
  userIntent?: string;
};

const DIRECTIONS_LIBRARY: Record<string, ContentDirection> = {
  LEAD_GENERATION: {
    id: "lead_generation",
    title: "תוכן שמביא פניות",
    description: "פוסט או סרטון שמניע אנשים להשאיר פרטים או לפנות אליך",
    reason: "כרגע אין מספיק פניות, צריך תוכן שמייצר פעולה",
    type: "lead_generation",
  },
  TRUST_BUILDING: {
    id: "trust_building",
    title: "תוכן שבונה אמון",
    description: "הצגת ניסיון, תוצאות או סיפורי לקוחות",
    reason: "לפני שאנשים פונים — הם צריכים לסמוך עליך",
    type: "trust_building",
  },
  PROMOTION: {
    id: "promotion",
    title: "תוכן מבצע/הצעה",
    description: "הצגת הצעה ברורה עם סיבה לפעול עכשיו",
    reason: "יש הזדמנות להניע לפעולה עם הצעה",
    type: "promotion",
  },
  EDUCATION: {
    id: "education",
    title: "תוכן שמלמד",
    description: "שיתוף ידע שנותן ערך וממצב אותך כמומחה",
    reason: "בניית סמכות מקצועית תורמת לאמון ולפניות",
    type: "education",
  },
};

export function getContentDirections(
  input: GetContentDirectionsInput
): ContentDirection[] {
  const { hasContentActivity, businessModel } = input;

  if (!hasContentActivity) {
    return [
      DIRECTIONS_LIBRARY.LEAD_GENERATION,
      DIRECTIONS_LIBRARY.TRUST_BUILDING,
    ];
  }

  if (businessModel === "local_service") {
    return [
      DIRECTIONS_LIBRARY.LEAD_GENERATION,
      DIRECTIONS_LIBRARY.TRUST_BUILDING,
      DIRECTIONS_LIBRARY.PROMOTION,
    ];
  }

  return [
    DIRECTIONS_LIBRARY.TRUST_BUILDING,
    DIRECTIONS_LIBRARY.EDUCATION,
  ];
}