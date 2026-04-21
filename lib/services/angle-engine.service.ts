export function pickAngle(intent: "desire" | "trust" | "result") {
  if (intent === "desire") {
    return {
      type: "pattern-break",
      hook: "משהו שלא ציפית לראות",
    };
  }

  if (intent === "trust") {
    return {
      type: "authority",
      hook: "למה זה עובד באמת",
    };
  }

  return {
    type: "direct-result",
    hook: "תוצאה ברורה ומהירה",
  };
}