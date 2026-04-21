type Content = {
  hook?: string;
  structure?: string[];
  script?: string;
};

export type ContentIssue = {
  type: "warning" | "suggestion" | "success";
  message: string;
};

export function analyzeContent(content: Content, mediaCount: number): ContentIssue[] {
  const issues: ContentIssue[] = [];

  // 📸 MEDIA
  if (!mediaCount) {
    issues.push({
      type: "warning",
      message: "כדאי להוסיף תמונה או וידאו כדי לשפר ביצועים",
    });
  }

  // 🎯 HOOK
  if (!content.hook || content.hook.length < 10) {
    issues.push({
      type: "suggestion",
      message: "הפתיח קצר מדי — נסה להפוך אותו ליותר מסקרן",
    });
  }

  if (content.hook && content.hook.length > 120) {
    issues.push({
      type: "suggestion",
      message: "הפתיח ארוך מדי — כדאי לקצר אותו",
    });
  }

  // 🧱 STRUCTURE
  if (!content.structure || content.structure.length === 0) {
    issues.push({
      type: "warning",
      message: "אין מבנה ברור לפוסט — זה עלול לפגוע בהבנה",
    });
  }

  // ✅ אם הכל טוב
  if (issues.length === 0) {
    issues.push({
      type: "success",
      message: "התוכן נראה מוכן לפרסום 🚀",
    });
  }

  return issues;
}