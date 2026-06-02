/** Display labels only — no business logic. */
export function featureKeyLabel(featureKey: string): string {
  const labels: Record<string, string> = {
    "auth.login": "התחברות",
    "documents.inbox": "תיבת מסמכים",
    "documents.upload": "העלאת מסמך",
    "documents.review.approve": "אישור מסמך",
    "billing.document.create": "יצירת מסמך חיוב",
    "billing.document.issue": "הפקת חשבונית",
  };
  return labels[featureKey] ?? featureKey;
}

export function frictionReasonLabel(reason: string): string {
  switch (reason) {
    case "high_failure_rate":
      return "שיעור כשלונות גבוה";
    case "low_completion_rate":
      return "שיעור השלמה נמוך";
    default:
      return reason;
  }
}

export function formatCompletionRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

export function formatRelativeTime(iso: string): string {
  try {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "עכשיו";
    if (diffMin < 60) return `לפני ${diffMin} דק׳`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `לפני ${diffHours} שע׳`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `לפני ${diffDays} ימים`;
    return date.toLocaleDateString("he-IL");
  } catch {
    return iso;
  }
}
