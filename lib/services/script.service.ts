type Input = {
  contentStructure: {
    hook: string;
    problem: string;
    value: string;
    proof: string;
    cta: string;
  };
  contentFormat: "reel" | "video" | "image" | "post";
};

export function generateScriptAndInstructions(input: Input) {
  const s = input.contentStructure;

  const script = [
    s.hook,
    s.problem,
    s.value,
    s.proof,
    s.cta,
  ].join("\n");

  const instructions = [
    "פתיחה חזקה שמושכת תשומת לב",
    "הצגת הבעיה בצורה שהלקוח מזדהה איתה",
    "הצגת הפתרון בצורה ברורה",
    "חיזוק באמינות או הוכחה",
    "סיום עם קריאה לפעולה ברורה",
  ];

  return {
    script,
    instructions,
  };
}