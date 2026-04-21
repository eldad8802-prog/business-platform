type FeedbackItem = {
  success: boolean;
  content: any;
  timestamp: number;
};

export function getLearningInsights(): string {
  try {
    const raw = localStorage.getItem("content_feedback");
    if (!raw) return "";

    const data: FeedbackItem[] = JSON.parse(raw);

    if (!data.length) return "";

    const successItems = data.filter((item) => item.success);

    if (successItems.length === 0) return "";

    // 🔥 לוקחים 3 אחרונים שעבדו
    const recent = successItems.slice(-3);

    const hooks = recent
      .map((item) => item.content?.hook)
      .filter(Boolean)
      .join("\n");

    return `
תובנות מתוכן שעבד:
${hooks}

נסה לייצר תוכן דומה בסגנון הזה.
`;
  } catch {
    return "";
  }
}