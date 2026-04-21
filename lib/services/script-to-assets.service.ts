type Shot = {
  visual: string;
  voice?: string;
};

type Input = {
  shots: Shot[];
  selectedFormat: "reel" | "video" | "image" | "post";
  intentType: "desire" | "trust" | "result";
  distributionGoal?: "retention" | "comments" | "shares" | "saves";
};

type Asset = {
  id: string;
  title: string;
  description: string;
  type: "video" | "image";
  required: boolean;
};

function getIntentGuidance(intent: Input["intentType"]) {
  if (intent === "desire") {
    return "צלם עם תנועה קלה, קלוזאפ חזק, רגע שמושך תשומת לב מיד";
  }

  if (intent === "trust") {
    return "צלם יציב, פריים נקי, תאורה ברורה, להדגיש מקצועיות ותהליך";
  }

  return "צלם את התוצאה בצורה ברורה, להראות שימוש אמיתי או לקוח מרוצה";
}

function getDistributionGuidance(goal?: Input["distributionGoal"]) {
  if (goal === "comments") {
    return "דאג שהשוט האחרון ירגיש כמו הזמנה ברורה לפעולה";
  }

  if (goal === "saves") {
    return "דאג שלפחות שוט אחד ירגיש כמו תובנה ששווה לשמור";
  }

  if (goal === "shares") {
    return "דאג שלפחות שוט אחד ירגיש שווה שליחה למישהו אחר";
  }

  return "דאג לפתיחה חזקה כבר מהשוט הראשון";
}

export function buildAssetsFromScript(input: Input) {
  const assets: Asset[] = [];
  const intentGuidance = getIntentGuidance(input.intentType);
  const distributionGuidance = getDistributionGuidance(input.distributionGoal);

  input.shots.forEach((shot, index) => {
    const baseId = `shot_${index + 1}`;

    if (input.selectedFormat === "reel" || input.selectedFormat === "video") {
      assets.push({
        id: baseId,
        title: `שוט ${index + 1}`,
        description: `${shot.visual}. ${intentGuidance}. ${distributionGuidance}. השתמש בתאורה טובה ותנועה טבעית.`,
        type: "video",
        required: true,
      });
      return;
    }

    if (input.selectedFormat === "image" || input.selectedFormat === "post") {
      assets.push({
        id: `${baseId}_front`,
        title: `שוט ${index + 1} - קדמי`,
        description: `${shot.visual}. ${intentGuidance}. ${distributionGuidance}. צלם מזווית קדמית.`,
        type: "image",
        required: true,
      });

      assets.push({
        id: `${baseId}_side`,
        title: `שוט ${index + 1} - צד`,
        description: `${shot.visual}. ${intentGuidance}. ${distributionGuidance}. צלם מהצד עם עומק.`,
        type: "image",
        required: true,
      });

      assets.push({
        id: `${baseId}_close`,
        title: `שוט ${index + 1} - קלוזאפ`,
        description: `${shot.visual}. ${intentGuidance}. ${distributionGuidance}. תקריב חד וממוקד.`,
        type: "image",
        required: true,
      });
    }
  });

  return {
    requiredAssets: assets,
    optionalAssets: [],
    guidance: [
      "צלם כמה טייקים מכל שוט",
      "השתמש בתאורה טבעית",
      "שמור על יציבות או תנועה עדינה בלבד",
      distributionGuidance,
    ],
  };
}