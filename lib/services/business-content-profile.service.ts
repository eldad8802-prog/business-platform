export type BusinessType =
  | "hair_salon"
  | "beauty_clinic"
  | "nail_studio"
  | "barbershop"
  | "spa"
  | "restaurant"
  | "cafe"
  | "bakery"
  | "catering"
  | "retail_store"
  | "fashion_store"
  | "jewelry_store"
  | "electronics_store"
  | "home_decor"
  | "ecommerce"
  | "real_estate"
  | "mortgage"
  | "law_firm"
  | "accounting"
  | "financial_advisor"
  | "insurance"
  | "medical_clinic"
  | "dental_clinic"
  | "therapy"
  | "fitness"
  | "personal_trainer"
  | "yoga_pilates"
  | "education"
  | "course_creator"
  | "coaching"
  | "consulting"
  | "marketing_agency"
  | "creative_studio"
  | "photography"
  | "event_business"
  | "wedding_business"
  | "home_services"
  | "cleaning"
  | "moving"
  | "repair"
  | "automotive"
  | "travel"
  | "technology"
  | "saas"
  | "manufacturing"
  | "other";

export type BusinessContentProfile = {
  marketCategory:
    | "beauty"
    | "food"
    | "retail"
    | "services"
    | "real_estate"
    | "health"
    | "education"
    | "finance"
    | "legal"
    | "home"
    | "events"
    | "automotive"
    | "technology"
    | "other";

  offerType: "service" | "product" | "hybrid";

  salesCycle: "instant" | "short" | "medium" | "long";

  trustLevel: "low" | "medium" | "high";

  visualStrength: "low" | "medium" | "high";

  emotionalDriver:
    | "desire"
    | "pain"
    | "status"
    | "security"
    | "convenience"
    | "trust";

  brandPersona:
    | "personal"
    | "professional"
    | "premium"
    | "friendly"
    | "energetic"
    | "luxury";

  contentStyle:
    | "demonstration"
    | "explanation"
    | "testimonial"
    | "transformation"
    | "authority"
    | "offer";

  hookPriority:
    | "pattern_break"
    | "pain_first"
    | "result_first"
    | "trust_first"
    | "offer_first";

  ctaStyle:
    | "message_now"
    | "book_now"
    | "buy_now"
    | "follow"
    | "learn_more";

  recommendedVideoType: "SHORT" | "MID" | "FULL";

  notes: string[];
};

export type BusinessProfileInput = {
  businessType?: string;
  businessCategory?: string;
  businessName?: string;
  services?: string[];
  products?: string[];
  targetAudience?: string[];
  brandTone?: string;
  primaryGoal?: "leads" | "trust" | "exposure" | "sales";
  priceLevel?: "budget" | "mid" | "premium";
  differentiators?: string[];
};

const BUSINESS_TYPE_MAP: Record<BusinessType, BusinessContentProfile> = {
  hair_salon: {
    marketCategory: "beauty",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "personal",
    contentStyle: "transformation",
    hookPriority: "result_first",
    ctaStyle: "book_now",
    recommendedVideoType: "MID",
    notes: ["Before/after works well", "Human presence should be strong"],
  },
  beauty_clinic: {
    marketCategory: "beauty",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "high",
    emotionalDriver: "trust",
    brandPersona: "premium",
    contentStyle: "transformation",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Trust and results must appear together"],
  },
  nail_studio: {
    marketCategory: "beauty",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "friendly",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "book_now",
    recommendedVideoType: "SHORT",
    notes: ["Close-up visuals matter a lot"],
  },
  barbershop: {
    marketCategory: "beauty",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "energetic",
    contentStyle: "transformation",
    hookPriority: "pattern_break",
    ctaStyle: "book_now",
    recommendedVideoType: "SHORT",
    notes: ["Fast punchy edits fit well"],
  },
  spa: {
    marketCategory: "beauty",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "luxury",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "book_now",
    recommendedVideoType: "MID",
    notes: ["Atmosphere is part of the sell"],
  },
  restaurant: {
    marketCategory: "food",
    offerType: "product",
    salesCycle: "instant",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "energetic",
    contentStyle: "demonstration",
    hookPriority: "pattern_break",
    ctaStyle: "message_now",
    recommendedVideoType: "SHORT",
    notes: ["Food visuals should appear immediately"],
  },
  cafe: {
    marketCategory: "food",
    offerType: "product",
    salesCycle: "instant",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "friendly",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "message_now",
    recommendedVideoType: "SHORT",
    notes: ["Lifestyle visuals help"],
  },
  bakery: {
    marketCategory: "food",
    offerType: "product",
    salesCycle: "instant",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "friendly",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "message_now",
    recommendedVideoType: "SHORT",
    notes: ["Texture and close-ups are strong assets"],
  },
  catering: {
    marketCategory: "food",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "high",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "testimonial",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Events and proof matter more than appetite alone"],
  },
  retail_store: {
    marketCategory: "retail",
    offerType: "product",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "desire",
    brandPersona: "friendly",
    contentStyle: "offer",
    hookPriority: "offer_first",
    ctaStyle: "buy_now",
    recommendedVideoType: "SHORT",
    notes: ["Offer clarity is key"],
  },
  fashion_store: {
    marketCategory: "retail",
    offerType: "product",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "premium",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "buy_now",
    recommendedVideoType: "SHORT",
    notes: ["Looks and styling should lead"],
  },
  jewelry_store: {
    marketCategory: "retail",
    offerType: "product",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "luxury",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Premium framing matters"],
  },
  electronics_store: {
    marketCategory: "retail",
    offerType: "product",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "convenience",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "buy_now",
    recommendedVideoType: "MID",
    notes: ["Benefits and use cases should be clear"],
  },
  home_decor: {
    marketCategory: "retail",
    offerType: "product",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "premium",
    contentStyle: "transformation",
    hookPriority: "result_first",
    ctaStyle: "buy_now",
    recommendedVideoType: "SHORT",
    notes: ["Before/after room context works well"],
  },
  ecommerce: {
    marketCategory: "retail",
    offerType: "product",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "convenience",
    brandPersona: "energetic",
    contentStyle: "offer",
    hookPriority: "offer_first",
    ctaStyle: "buy_now",
    recommendedVideoType: "SHORT",
    notes: ["Fast decision support is important"],
  },
  real_estate: {
    marketCategory: "real_estate",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "high",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "authority",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Authority and trust must be central"],
  },
  mortgage: {
    marketCategory: "finance",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "FULL",
    notes: ["Clarity lowers fear and resistance"],
  },
  law_firm: {
    marketCategory: "legal",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "authority",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Calm confidence beats flashy content"],
  },
  accounting: {
    marketCategory: "finance",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Useful guidance builds trust"],
  },
  financial_advisor: {
    marketCategory: "finance",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "authority",
    hookPriority: "trust_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "FULL",
    notes: ["Risk reduction is a strong theme"],
  },
  insurance: {
    marketCategory: "finance",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Urgency and peace of mind work well"],
  },
  medical_clinic: {
    marketCategory: "health",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "medium",
    emotionalDriver: "trust",
    brandPersona: "professional",
    contentStyle: "authority",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Professional credibility is essential"],
  },
  dental_clinic: {
    marketCategory: "health",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "medium",
    emotionalDriver: "trust",
    brandPersona: "professional",
    contentStyle: "transformation",
    hookPriority: "trust_first",
    ctaStyle: "book_now",
    recommendedVideoType: "FULL",
    notes: ["Results and comfort should both appear"],
  },
  therapy: {
    marketCategory: "health",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "trust",
    brandPersona: "personal",
    contentStyle: "authority",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Warmth and safety matter most"],
  },
  fitness: {
    marketCategory: "health",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "energetic",
    contentStyle: "transformation",
    hookPriority: "result_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Energy and visible results drive attention"],
  },
  personal_trainer: {
    marketCategory: "health",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "personal",
    contentStyle: "testimonial",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Personal connection is a strong lever"],
  },
  yoga_pilates: {
    marketCategory: "health",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "convenience",
    brandPersona: "friendly",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "book_now",
    recommendedVideoType: "SHORT",
    notes: ["Calm rhythm and accessibility help"],
  },
  education: {
    marketCategory: "education",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "medium",
    emotionalDriver: "trust",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "MID",
    notes: ["Clear value and outcomes matter"],
  },
  course_creator: {
    marketCategory: "education",
    offerType: "product",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "convenience",
    brandPersona: "personal",
    contentStyle: "authority",
    hookPriority: "pain_first",
    ctaStyle: "buy_now",
    recommendedVideoType: "MID",
    notes: ["Specific learning promise works well"],
  },
  coaching: {
    marketCategory: "education",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "trust",
    brandPersona: "personal",
    contentStyle: "testimonial",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Transformation and personal tone are important"],
  },
  consulting: {
    marketCategory: "services",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "low",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "authority",
    hookPriority: "pain_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "FULL",
    notes: ["Expert positioning should lead"],
  },
  marketing_agency: {
    marketCategory: "services",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "results",
    brandPersona: "professional",
    contentStyle: "testimonial",
    hookPriority: "result_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Results and case studies are strong assets"],
  } as unknown as BusinessContentProfile,
  creative_studio: {
    marketCategory: "services",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "status",
    brandPersona: "premium",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Portfolio style visuals matter"],
  },
  photography: {
    marketCategory: "services",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "personal",
    contentStyle: "testimonial",
    hookPriority: "result_first",
    ctaStyle: "book_now",
    recommendedVideoType: "MID",
    notes: ["Visual proof is the main asset"],
  },
  event_business: {
    marketCategory: "events",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "high",
    visualStrength: "high",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "testimonial",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Energy + reliability should both be shown"],
  },
  wedding_business: {
    marketCategory: "events",
    offerType: "service",
    salesCycle: "long",
    trustLevel: "high",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "luxury",
    contentStyle: "testimonial",
    hookPriority: "trust_first",
    ctaStyle: "message_now",
    recommendedVideoType: "FULL",
    notes: ["Emotion and trust are both critical"],
  },
  home_services: {
    marketCategory: "home",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "convenience",
    brandPersona: "friendly",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Speed and simplicity matter"],
  },
  cleaning: {
    marketCategory: "home",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "convenience",
    brandPersona: "friendly",
    contentStyle: "transformation",
    hookPriority: "result_first",
    ctaStyle: "book_now",
    recommendedVideoType: "SHORT",
    notes: ["Before/after is very strong"],
  },
  moving: {
    marketCategory: "home",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "high",
    visualStrength: "medium",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Stress reduction is a strong angle"],
  },
  repair: {
    marketCategory: "home",
    offerType: "service",
    salesCycle: "short",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "pain",
    brandPersona: "professional",
    contentStyle: "demonstration",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "SHORT",
    notes: ["Problem/solution works best"],
  },
  automotive: {
    marketCategory: "automotive",
    offerType: "hybrid",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "demonstration",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Practical proof matters"],
  },
  travel: {
    marketCategory: "services",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "high",
    emotionalDriver: "desire",
    brandPersona: "friendly",
    contentStyle: "demonstration",
    hookPriority: "result_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "MID",
    notes: ["Escape and aspiration are strong"],
  },
  technology: {
    marketCategory: "technology",
    offerType: "hybrid",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "convenience",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "MID",
    notes: ["Clarity beats hype"],
  },
  saas: {
    marketCategory: "technology",
    offerType: "product",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "low",
    emotionalDriver: "convenience",
    brandPersona: "professional",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "MID",
    notes: ["Problem/solution is the core"],
  },
  manufacturing: {
    marketCategory: "other",
    offerType: "product",
    salesCycle: "long",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "security",
    brandPersona: "professional",
    contentStyle: "authority",
    hookPriority: "trust_first",
    ctaStyle: "learn_more",
    recommendedVideoType: "FULL",
    notes: ["Capability and reliability matter"],
  },
  other: {
    marketCategory: "other",
    offerType: "service",
    salesCycle: "medium",
    trustLevel: "medium",
    visualStrength: "medium",
    emotionalDriver: "trust",
    brandPersona: "friendly",
    contentStyle: "explanation",
    hookPriority: "pain_first",
    ctaStyle: "message_now",
    recommendedVideoType: "MID",
    notes: ["Use a balanced default until more business data is available"],
  },
};

function normalizeBusinessType(value?: string): BusinessType {
  const text = (value || "").trim().toLowerCase();

  if (!text) return "other";

  if (text.includes("ספר") || text.includes("hair") || text.includes("salon")) {
    return "hair_salon";
  }
  if (text.includes("ברבר") || text.includes("barber")) {
    return "barbershop";
  }
  if (
    text.includes("קוסמט") ||
    text.includes("beauty") ||
    text.includes("skin")
  ) {
    return "beauty_clinic";
  }
  if (text.includes("ציפור") || text.includes("nail")) {
    return "nail_studio";
  }
  if (text.includes("ספא") || text.includes("spa")) {
    return "spa";
  }
  if (text.includes("מסעד") || text.includes("restaurant")) {
    return "restaurant";
  }
  if (text.includes("קפה") || text.includes("cafe")) {
    return "cafe";
  }
  if (text.includes("מאפ") || text.includes("bakery")) {
    return "bakery";
  }
  if (text.includes("קייטר") || text.includes("catering")) {
    return "catering";
  }
  if (text.includes("אופנה") || text.includes("fashion")) {
    return "fashion_store";
  }
  if (text.includes("תכש") || text.includes("jewelry")) {
    return "jewelry_store";
  }
  if (text.includes("אלקטרו") || text.includes("electronics")) {
    return "electronics_store";
  }
  if (text.includes("עיצוב בית") || text.includes("home decor")) {
    return "home_decor";
  }
  if (text.includes("חנות") || text.includes("retail") || text.includes("store")) {
    return "retail_store";
  }
  if (text.includes("איקומרס") || text.includes("ecommerce")) {
    return "ecommerce";
  }
  if (text.includes("נדל") || text.includes("real estate")) {
    return "real_estate";
  }
  if (text.includes("משכנת")) {
    return "mortgage";
  }
  if (text.includes("עור") || text.includes("law")) {
    return "law_firm";
  }
  if (text.includes("רו\"ח") || text.includes("account") || text.includes("חשבונ")) {
    return "accounting";
  }
  if (text.includes("פיננס") || text.includes("finance")) {
    return "financial_advisor";
  }
  if (text.includes("ביטוח") || text.includes("insurance")) {
    return "insurance";
  }
  if (text.includes("רופא") || text.includes("clinic") || text.includes("medical")) {
    return "medical_clinic";
  }
  if (text.includes("שיניים") || text.includes("dental")) {
    return "dental_clinic";
  }
  if (text.includes("טיפול רגשי") || text.includes("therapy")) {
    return "therapy";
  }
  if (text.includes("כושר") || text.includes("gym") || text.includes("fitness")) {
    return "fitness";
  }
  if (text.includes("מאמן") || text.includes("trainer")) {
    return "personal_trainer";
  }
  if (text.includes("יוגה") || text.includes("פילאטיס") || text.includes("pilates")) {
    return "yoga_pilates";
  }
  if (text.includes("חינוך") || text.includes("school") || text.includes("education")) {
    return "education";
  }
  if (text.includes("קורס") || text.includes("course")) {
    return "course_creator";
  }
  if (text.includes("קואצ") || text.includes("coach")) {
    return "coaching";
  }
  if (text.includes("ייעוץ") || text.includes("consult")) {
    return "consulting";
  }
  if (text.includes("שיווק") || text.includes("agency")) {
    return "marketing_agency";
  }
  if (text.includes("סטודיו") || text.includes("creative")) {
    return "creative_studio";
  }
  if (text.includes("צילום") || text.includes("photography")) {
    return "photography";
  }
  if (text.includes("אירוע") || text.includes("event")) {
    return "event_business";
  }
  if (text.includes("חתונ") || text.includes("wedding")) {
    return "wedding_business";
  }
  if (text.includes("ניקיון") || text.includes("cleaning")) {
    return "cleaning";
  }
  if (text.includes("הובלה") || text.includes("moving")) {
    return "moving";
  }
  if (text.includes("תיקון") || text.includes("repair")) {
    return "repair";
  }
  if (
    text.includes("בית") ||
    text.includes("אינסטל") ||
    text.includes("חשמל") ||
    text.includes("שיפוץ") ||
    text.includes("home service")
  ) {
    return "home_services";
  }
  if (text.includes("רכב") || text.includes("auto") || text.includes("automotive")) {
    return "automotive";
  }
  if (text.includes("נסיע") || text.includes("travel")) {
    return "travel";
  }
  if (text.includes("טכנולוג") || text.includes("tech")) {
    return "technology";
  }
  if (text.includes("saas") || text.includes("software")) {
    return "saas";
  }
  if (text.includes("מפעל") || text.includes("manufact")) {
    return "manufacturing";
  }

  return "other";
}

function applyGoalAdjustments(
  profile: BusinessContentProfile,
  primaryGoal?: BusinessProfileInput["primaryGoal"]
): BusinessContentProfile {
  if (!primaryGoal) {
    return profile;
  }

  if (primaryGoal === "trust") {
    return {
      ...profile,
      hookPriority: "trust_first",
      contentStyle:
        profile.contentStyle === "offer" ? "authority" : profile.contentStyle,
      recommendedVideoType:
        profile.recommendedVideoType === "SHORT" ? "MID" : "FULL",
    };
  }

  if (primaryGoal === "sales") {
    return {
      ...profile,
      hookPriority: "offer_first",
      ctaStyle: profile.offerType === "service" ? "book_now" : "buy_now",
      recommendedVideoType:
        profile.salesCycle === "instant" ? "SHORT" : "MID",
    };
  }

  if (primaryGoal === "exposure") {
    return {
      ...profile,
      hookPriority: "pattern_break",
      recommendedVideoType: "SHORT",
    };
  }

  if (primaryGoal === "leads") {
    return {
      ...profile,
      ctaStyle: "message_now",
      recommendedVideoType:
        profile.salesCycle === "long" ? "FULL" : "MID",
    };
  }

  return profile;
}

function applyBrandToneAdjustments(
  profile: BusinessContentProfile,
  brandTone?: string
): BusinessContentProfile {
  const tone = (brandTone || "").toLowerCase();

  if (!tone) return profile;

  if (tone.includes("יוקר") || tone.includes("premium") || tone.includes("luxury")) {
    return { ...profile, brandPersona: "premium" };
  }

  if (tone.includes("אישי") || tone.includes("warm") || tone.includes("friendly")) {
    return { ...profile, brandPersona: "personal" };
  }

  if (tone.includes("מקצוע") || tone.includes("formal") || tone.includes("professional")) {
    return { ...profile, brandPersona: "professional" };
  }

  if (tone.includes("אנרג") || tone.includes("bold") || tone.includes("young")) {
    return { ...profile, brandPersona: "energetic" };
  }

  return profile;
}

function applyOfferAdjustments(
  profile: BusinessContentProfile,
  input: BusinessProfileInput
): BusinessContentProfile {
  const servicesCount = input.services?.length ?? 0;
  const productsCount = input.products?.length ?? 0;

  if (servicesCount > 0 && productsCount > 0) {
    return { ...profile, offerType: "hybrid" };
  }

  if (productsCount > 0 && servicesCount === 0) {
    return { ...profile, offerType: "product" };
  }

  if (servicesCount > 0 && productsCount === 0) {
    return { ...profile, offerType: "service" };
  }

  return profile;
}

export function getBusinessContentProfile(
  input: BusinessProfileInput
): BusinessContentProfile {
  const normalizedType = normalizeBusinessType(
    input.businessType || input.businessCategory
  );

  const baseProfile = BUSINESS_TYPE_MAP[normalizedType] || BUSINESS_TYPE_MAP.other;

  const withOffer = applyOfferAdjustments(baseProfile, input);
  const withGoal = applyGoalAdjustments(withOffer, input.primaryGoal);
  const withTone = applyBrandToneAdjustments(withGoal, input.brandTone);

  return withTone;
}