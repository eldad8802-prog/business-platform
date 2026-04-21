type Input = {
  goal: "leads" | "trust" | "exposure" | "sales";
  intent: "message" | "follow" | "watch" | "sale";
  audienceDescription: string;
  strategy: string;
  angle: string;
  tone: string;
  businessName: string;
  effectiveServiceLabel: string;
};

type ContentStructure = {
  hook: string;
  problem: string;
  value: string;
  proof: string;
  cta: string;
};

function pickHook(strategy: string, problem: string, value: string) {
  if (strategy === "pain") {
    return `נמאס לך מ${problem}?`;
  }

  if (strategy === "result") {
    return `רוצה ${value}?`;
  }

  return `רוב האנשים עושים טעות כשמדובר ב${problem}`;
}

function buildProblem(audience: string, service: string) {
  if (!audience) {
    return `לקוחות שלא מקבלים תוצאה מ${service}`;
  }

  return `${audience} שלא מקבלים תוצאה מ${service}`;
}

function buildValue(service: string) {
  return `${service} בצורה פשוטה, מהירה ואפקטיבית`;
}

function buildProof(businessName: string) {
  return `${businessName} עם ניסיון והתמחות בתחום`;
}

function buildCTA(intent: Input["intent"]) {
  if (intent === "message") return "שלחו הודעה עכשיו";
  if (intent === "follow") return "עקבו אחרי לעוד";
  if (intent === "watch") return "תמשיכו לראות";
  return "הזמינו עכשיו";
}

export function buildContentStructure(input: Input): ContentStructure {
  const problem = buildProblem(
    input.audienceDescription,
    input.effectiveServiceLabel
  );

  const value = buildValue(input.effectiveServiceLabel);

  return {
    hook: pickHook(input.strategy, problem, value),
    problem,
    value,
    proof: buildProof(input.businessName),
    cta: buildCTA(input.intent),
  };
}