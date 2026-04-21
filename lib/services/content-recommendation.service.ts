export type RecommendationInput = {
  goal: string;
  contentAngle: string;
  mode: "ai" | "camera" | "voice";
  audienceTypes?: string[];
};

export type FormatRecommendation = {
  format: string;
  reasoning: string;
  score: number;
};

export function getFormatRecommendations(
  input: RecommendationInput
): FormatRecommendation[] {
  const { goal, contentAngle, mode } = input;

  const recommendations: FormatRecommendation[] = [];

  // -------------------------
  // SALES
  // -------------------------
  if (goal === "sales") {
    if (contentAngle === "cta") {
      recommendations.push({
        format: "short_video",
        reasoning: "תוכן קצר וישיר עם הנעה לפעולה עובד הכי טוב למכירות",
        score: 10,
      });

      recommendations.push({
        format: "testimonial",
        reasoning: "הוכחה חברתית מחזקת סגירה",
        score: 8,
      });
    }

    if (contentAngle === "show_difference") {
      recommendations.push({
        format: "comparison_video",
        reasoning: "השוואה מבליטה יתרון ומובילה להחלטה",
        score: 9,
      });
    }
  }

  // -------------------------
  // TRUST
  // -------------------------
  if (goal === "trust") {
    if (contentAngle === "explain") {
      recommendations.push({
        format: "educational_video",
        reasoning: "הסבר ממצב אותך כמומחה",
        score: 10,
      });
    }

    if (contentAngle === "trust") {
      recommendations.push({
        format: "behind_the_scenes",
        reasoning: "שקיפות יוצרת אמון",
        score: 9,
      });
    }
  }

  // -------------------------
  // EXPOSURE
  // -------------------------
  if (goal === "exposure") {
    if (contentAngle === "attention") {
      recommendations.push({
        format: "viral_short",
        reasoning: "תוכן מהיר עם hook מייצר חשיפה",
        score: 10,
      });

      recommendations.push({
        format: "pattern_break_video",
        reasoning: "תוכן מפתיע מגדיל שיתופים",
        score: 9,
      });
    }
  }

  // -------------------------
  // LEADS
  // -------------------------
  if (goal === "leads") {
    if (
      contentAngle === "show_result" ||
      contentAngle === "show_difference"
    ) {
      recommendations.push({
        format: "before_after",
        reasoning: "הצגת תוצאה יוצרת רצון לפנות",
        score: 10,
      });

      recommendations.push({
        format: "problem_solution",
        reasoning: "בעיה → פתרון מוביל ללידים",
        score: 9,
      });
    }
  }

  // -------------------------
  // MODE ADJUSTMENTS
  // -------------------------
  if (mode === "camera") {
    recommendations.forEach((r) => {
      if (r.format.includes("video")) {
        r.score += 1;
      }
    });
  }

  if (mode === "voice") {
    recommendations.forEach((r) => {
      if (r.format.includes("educational")) {
        r.score += 1;
      }
    });
  }

  // -------------------------
  // FALLBACK
  // -------------------------
  if (recommendations.length === 0) {
    recommendations.push({
      format: "general_video",
      reasoning: "פורמט כללי שמתאים לרוב המצבים",
      score: 5,
    });
  }

  // -------------------------
  // SORT
  // -------------------------
  return recommendations.sort((a, b) => b.score - a.score);
}