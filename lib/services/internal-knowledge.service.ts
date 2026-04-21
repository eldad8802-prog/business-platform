export type KnowledgePack = {
  category: "food";

  marketTruths: string[];

  audienceDrives: {
    emotional: string[];
    practical: string[];
    social: string[];
    riskReduction: string[];
  };

  objections: {
    trust: string[];
    price: string[];
    quality: string[];
    fit: string[];
  };

  contentLevers: string[];

  angles: {
    visual: string[];
    experiential: string[];
    educational: string[];
    credibility: string[];
    novelty: string[];
    urgency: string[];
    social: string[];
    story: string[];
  };

  expressionPatterns: {
    reel: string[];
    video: string[];
    image: string[];
    post: string[];
  };

  hooks: {
    curiosity: string[];
    desire: string[];
    warning: string[];
    proof: string[];
    surprise: string[];
    immediacy: string[];
  };

  topics: {
    product: string[];
    process: string[];
    ingredient: string[];
    experience: string[];
    socialProof: string[];
    seasonal: string[];
    behindTheScenes: string[];
    recommendation: string[];
  };

  ctas: {
    instant: string[];
    save: string[];
    share: string[];
    order: string[];
    visit: string[];
  };
};

export function getFoodKnowledge(): KnowledgePack {
  return {
    category: "food",

    marketTruths: [
      "אנשים אוכלים קודם עם העיניים",
      "חשק מניע יותר מהיגיון",
      "ויזואליות יוצרת החלטה",
      "חוויה חשובה כמו הטעם",
    ],

    audienceDrives: {
      emotional: ["חשק", "פינוק", "סקרנות"],
      practical: ["זמינות", "מהירות"],
      social: ["שיתוף", "בילוי"],
      riskReduction: ["לא להתאכזב", "שווה את המחיר"],
    },

    objections: {
      trust: ["לא מכיר את המקום"],
      price: ["יקר מדי"],
      quality: ["לא בטוח טעים"],
      fit: ["לא מתאים לי עכשיו"],
    },

    contentLevers: [
      "visual",
      "novelty",
      "indulgence",
      "socialProof",
      "urgency",
    ],

    angles: {
      visual: ["food porn", "close-up"],
      experiential: ["חוויה", "טעימה"],
      educational: ["איך מכינים"],
      credibility: ["איכות", "מקצועיות"],
      novelty: ["חדש בתפריט"],
      urgency: ["לזמן מוגבל"],
      social: ["לקוחות נהנים"],
      story: ["מאחורי המנה"],
    },

    expressionPatterns: {
      reel: ["fast-cut", "hook-first"],
      video: ["story", "process"],
      image: ["hero-shot"],
      post: ["storytelling"],
    },

    hooks: {
      curiosity: ["לא תאמין מה יש פה"],
      desire: ["אם אתה רעב עכשיו זה מסוכן"],
      warning: ["אל תראה את זה בדיאטה"],
      proof: ["כולם מדברים על זה"],
      surprise: ["לא ציפיתי לזה"],
      immediacy: ["אתה חייב לנסות"],
    },

    topics: {
      product: ["מנה מובילה"],
      process: ["איך מכינים"],
      ingredient: ["מרכיב מיוחד"],
      experience: ["חוויה"],
      socialProof: ["לקוחות"],
      seasonal: ["חורף/קיץ"],
      behindTheScenes: ["מאחורי הקלעים"],
      recommendation: ["המלצה"],
    },

    ctas: {
      instant: ["תזמין עכשיו"],
      save: ["שמור לפעם הבאה"],
      share: ["שלח לחבר רעב"],
      order: ["הזמן עכשיו"],
      visit: ["בוא לטעום"],
    },
  };
}