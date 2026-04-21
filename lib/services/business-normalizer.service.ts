type BusinessContext = {
  category?: string;
  subcategory?: string;
};

export function normalizeBusiness(context: BusinessContext) {
  const raw =
    context.subcategory ||
    context.category ||
    "business";

  const lower = raw.toLowerCase();

  // 🔥 התאמות לפי תחומים
  if (lower.includes("beauty") || lower.includes("hair")) {
    return {
      label: "טיפוח ושיער",
      service: "שירותי טיפוח",
      hashtags: ["#טיפוח", "#שיער"],
    };
  }

  if (lower.includes("fitness")) {
    return {
      label: "כושר ואימונים",
      service: "אימונים",
      hashtags: ["#כושר", "#אימונים"],
    };
  }

  if (lower.includes("food")) {
    return {
      label: "אוכל",
      service: "אוכל",
      hashtags: ["#אוכל", "#מסעדות"],
    };
  }

  return {
    label: raw,
    service: raw,
    hashtags: [`#${raw}`],
  };
}