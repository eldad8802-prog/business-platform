"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getContentDirections = getContentDirections;
var DIRECTIONS_LIBRARY = {
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
function getContentDirections(input) {
    var hasContentActivity = input.hasContentActivity, businessModel = input.businessModel, userIntent = input.userIntent;
    // שלב ראשון: אם יש intent מהמשתמש — נחזיר משהו בסיסי (נשפר בהמשך)
    if (userIntent) {
        return [DIRECTIONS_LIBRARY.LEAD_GENERATION];
    }
    // אין פעילות תוכן בכלל
    if (!hasContentActivity) {
        return [
            DIRECTIONS_LIBRARY.LEAD_GENERATION,
            DIRECTIONS_LIBRARY.TRUST_BUILDING,
        ];
    }
    // לפי סוג עסק
    if (businessModel === "local_service") {
        return [
            DIRECTIONS_LIBRARY.LEAD_GENERATION,
            DIRECTIONS_LIBRARY.TRUST_BUILDING,
            DIRECTIONS_LIBRARY.PROMOTION,
        ];
    }
    // ברירת מחדל
    return [
        DIRECTIONS_LIBRARY.TRUST_BUILDING,
        DIRECTIONS_LIBRARY.EDUCATION,
    ];
}
