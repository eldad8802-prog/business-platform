type Input = {
  businessCategory: string;
  serviceLabel: string;
  audienceDescription: string;
};

export type ContentConcept = {
  id: string;
  label: string;
  type: string;

  coreIdea: string;
  visualMoment: string;
  hookDirection: string;
};

function isFood(text: string) {
  const lower = text.toLowerCase();

  return [
    "food",
    "restaurant",
    "אוכל",
    "מסעדה",
    "מטבח",
  ].some((k) => lower.includes(k));
}

export function runConceptEngine(input: Input): ContentConcept[] {
  const combined = `${input.businessCategory} ${input.serviceLabel}`;

  const food = isFood(combined);

  // -------------------------
  // 1. מושך / עניין
  // -------------------------
  const desireConcept: ContentConcept = food
    ? {
        id: "desire",
        label: "מושך ומעורר עניין",
        type: "craving",
        coreIdea: "להראות רגע ויזואלי חזק שגורם לרצות מיד",
        visualMoment: "קלוזאפ של תוצאה (למשל חלמון נפתח)",
        hookDirection: "חכה שתראה את זה",
      }
    : {
        id: "desire",
        label: "מושך ומעורר עניין",
        type: "visual_wow",
        coreIdea: "להראות משהו לא צפוי או מעניין מיד",
        visualMoment: "רגע שמושך תשומת לב",
        hookDirection: "לא תאמין מה קורה כאן",
      };

  // -------------------------
  // 2. מקצועי / אמון
  // -------------------------
  const trustConcept: ContentConcept = {
    id: "trust",
    label: "מקצועי ובונה אמון",
    type: "behind_scenes",
    coreIdea: "להראות איך עושים את זה נכון או מה חשוב באמת",
    visualMoment: "שלב קריטי בתהליך",
    hookDirection: "זה מה שעושה את ההבדל",
  };

  // -------------------------
  // 3. תוצאה / פעולה
  // -------------------------
  const resultConcept: ContentConcept = {
    id: "result",
    label: "ישיר ומניע לפעולה",
    type: "transformation",
    coreIdea: "להראות הבדל ברור בין לא נכון לנכון",
    visualMoment: "לפני ואחרי",
    hookDirection: "זה ההבדל בין זה לזה",
  };

  return [desireConcept, trustConcept, resultConcept];
}