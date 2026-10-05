/**
 * Setup after signup — the pure rules.
 *
 * A new owner answers at most two short, skippable questions ("what does the
 * business do", "what do you want to start with") and lands on Home with ONE
 * first action and a short checklist. Everything here is derived from rows the
 * caller already loaded, so the rules are provable without a database.
 *
 * Provenance discipline (the Business Memory rule):
 *   - category / subCategory / businessModel are owner-declared facts and live
 *     in their canonical BusinessProfile columns.
 *   - the goal is a PRODUCT preference, not a fact about the business. When the
 *     owner skips, a default is derived and recorded as DEFAULTED — never as the
 *     owner's choice — and it never enters the knowledge snapshot.
 */

import {
  BUSINESS_CATEGORY_OPTIONS,
  BUSINESS_MODEL_OPTIONS,
} from "@/lib/business/business-categories";

export const SETUP_GOALS = ["LEADS", "BILLING", "DOCUMENTS", "CONTENT"] as const;
export type SetupGoal = (typeof SETUP_GOALS)[number];
export type SetupGoalSource = "OWNER_SELECTED" | "DEFAULTED";

export function isSetupGoal(value: unknown): value is SetupGoal {
  return typeof value === "string" && (SETUP_GOALS as readonly string[]).includes(value);
}

/** What the owner sees on the "what do you want to start with" step. */
export const SETUP_GOAL_OPTIONS: ReadonlyArray<{ value: SetupGoal; title: string; hint: string }> = [
  { value: "LEADS", title: "לקבל ולנהל פניות", hint: "כל פנייה מוואטסאפ במקום אחד, עם מעקב ותזכורות" },
  { value: "BILLING", title: "להוציא מסמכים ולגבות", hint: "הצעת מחיר, חשבונית וקבלה — ומעקב אחרי מי ששילם" },
  { value: "DOCUMENTS", title: "לסדר מסמכים והוצאות", hint: "מצלמים קבלה, ו-Dubiz מזהה ספק, סכום ומע״מ" },
  { value: "CONTENT", title: "ליצור תוכן לשיווק", hint: "פוסטים וסרטונים קצרים שמתאימים לעסק שלך" },
];

/**
 * The first action for each goal. Each target is an existing screen that asks
 * for whatever it needs at that moment — billing asks for invoice identity
 * when the first document is created, the inbox asks for WhatsApp when it is
 * connected — so nothing has to be asked up front.
 */
export const START_ACTIONS: Record<SetupGoal, { title: string; body: string; cta: string; href: string }> = {
  LEADS: {
    title: "חברו את הוואטסאפ של העסק",
    body: "מהרגע שהוא מחובר, כל פנייה נכנסת לכאן — עם תזכורת לחזור אליה.",
    cta: "לחיבור וואטסאפ",
    href: "/inbox",
  },
  BILLING: {
    title: "צרו הצעת מחיר ראשונה",
    body: "פרטי העסק שחסרים למסמך נשאלים בדרך, פעם אחת.",
    cta: "להצעת מחיר",
    href: "/billing?create=QUOTE",
  },
  DOCUMENTS: {
    title: "העלו מסמך ראשון",
    body: "צלמו או העלו קבלה — Dubiz יקרא ממנה ספק, סכום ומע״מ.",
    cta: "להעלאת מסמך",
    href: "/documents",
  },
  CONTENT: {
    title: "צרו תוכן ראשון",
    body: "בחרו מטרה ו-Dubiz יציע כיוון שמתאים לסוג העסק.",
    cta: "ליצירת תוכן",
    href: "/content",
  },
};

/**
 * The goal used when the owner skips. Derived only from what they told us, and
 * always recorded as DEFAULTED. Selling products leans on paperwork; everything
 * else — services, both, or not said — starts with incoming customers.
 */
export function defaultGoalFor(businessModel: string | null | undefined): SetupGoal {
  return businessModel === "product" ? "DOCUMENTS" : "LEADS";
}

/** Validate the "what does the business do" answer against the taxonomy. */
export function validateBusinessAnswer(input: {
  category: unknown;
  subCategory: unknown;
  businessModel: unknown;
}): { category: string; subCategory: string; businessModel: string } | null {
  const { category, subCategory, businessModel } = input;
  if (typeof category !== "string" || typeof subCategory !== "string" || typeof businessModel !== "string") {
    return null;
  }
  const cat = BUSINESS_CATEGORY_OPTIONS.find((c) => c.value === category);
  if (!cat) return null;
  if (!cat.subCategories.some((s) => s.value === subCategory)) return null;
  if (!BUSINESS_MODEL_OPTIONS.some((m) => m.value === businessModel)) return null;
  return { category, subCategory, businessModel };
}

/** The model the owner most likely means, pre-selected and changeable. */
export function suggestedModelFor(category: string | null | undefined): string {
  return category === "Retail" ? "product" : category === "Food" ? "hybrid" : "service";
}

export type SetupFacts = {
  onboardingCompletedAt: Date | null;
  onboardingGoal: string | null;
  onboardingGoalSource: string | null;
  category: string | null;
  businessModel: string | null;
  billingIdentityComplete: boolean;
  whatsappConnected: boolean;
  counts: { leads: number; billingDocuments: number; documents: number; contentRuns: number };
};

export type ChecklistItem = { key: "business" | "billing" | "whatsapp"; title: string; href: string };

export type SetupView = {
  needsSetup: boolean;
  goal: SetupGoal;
  goalSource: SetupGoalSource;
  startAction: (typeof START_ACTIONS)[SetupGoal] & { done: boolean };
  checklist: ChecklistItem[];
  /** Nothing left to show: the first action happened and the checklist is empty. */
  settled: boolean;
};

function firstActionDone(goal: SetupGoal, f: SetupFacts): boolean {
  switch (goal) {
    case "LEADS":
      return f.whatsappConnected || f.counts.leads > 0;
    case "BILLING":
      return f.counts.billingDocuments > 0;
    case "DOCUMENTS":
      return f.counts.documents > 0;
    case "CONTENT":
      return f.counts.contentRuns > 0;
  }
}

/** Home's "your start" card and the /setup redirect, from facts alone. */
export function buildSetupView(f: SetupFacts): SetupView {
  const stored = isSetupGoal(f.onboardingGoal) ? f.onboardingGoal : null;
  const goal = stored ?? defaultGoalFor(f.businessModel);
  const goalSource: SetupGoalSource =
    stored && f.onboardingGoalSource === "OWNER_SELECTED" ? "OWNER_SELECTED" : "DEFAULTED";

  const checklist: ChecklistItem[] = [];
  if (!f.category) checklist.push({ key: "business", title: "ספרו לנו מה העסק עושה", href: "/setup" });
  if (goal !== "LEADS" && !f.whatsappConnected) {
    checklist.push({ key: "whatsapp", title: "חברו את הוואטסאפ של העסק", href: "/inbox" });
  }
  if (goal !== "BILLING" && !f.billingIdentityComplete) {
    checklist.push({ key: "billing", title: "השלימו את פרטי העסק למסמכים", href: "/business" });
  }

  const done = firstActionDone(goal, f);
  return {
    needsSetup: f.onboardingCompletedAt === null,
    goal,
    goalSource,
    startAction: { ...START_ACTIONS[goal], done },
    checklist,
    settled: done && checklist.length === 0,
  };
}
