// Pure, frontend-safe scoring for Gmail discovery attachments.
//
// Mirrors what was previously inline in `app/documents/upload/page.tsx`.
// Kept in `lib/services/email-import/` so it can be reused by both the
// upload screen and the new `/documents/email` screen without pulling in
// any UI dependencies. No backend, no schema, no API contract changes.

export type GmailDiscoveryAttachment = {
  messageId: string;
  attachmentId: string;
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  fromEmail: string | null;
  subject: string | null;
  sentAt: string | null;
};

export type EmailAttachmentBucket = "recommended" | "possible" | "hidden";

export type EmailAttachmentUiStatus =
  | "pending"
  | "importing"
  | "imported"
  | "duplicate"
  | "failed";

export type ScoredAttachment = GmailDiscoveryAttachment & {
  key: string;
  score: number;
  bucket: EmailAttachmentBucket;
  reason: string;
};

export type BulkImportSummary = {
  totalRecommended: number;
  imported: number;
  duplicates: number;
  failed: number;
  lastDocumentId: number | null;
};

function normalizeText(v: string | null | undefined): string {
  return String(v ?? "")
    .toLowerCase()
    .trim();
}

export function attachmentKey(a: GmailDiscoveryAttachment): string {
  return `${a.messageId}:${a.attachmentId}`;
}

export function scoreAttachment(a: GmailDiscoveryAttachment): {
  score: number;
  bucket: EmailAttachmentBucket;
  reason: string;
} {
  let score = 0;
  const reasons: string[] = [];

  const mime = normalizeText(a.mimeType);
  const filename = normalizeText(a.filename);
  const fromEmail = normalizeText(a.fromEmail);
  const subject = normalizeText(a.subject);

  const isPdf = mime === "application/pdf" || filename.endsWith(".pdf");
  const isImage =
    mime.startsWith("image/") || /\.(png|jpg|jpeg|webp|gif)$/.test(filename);

  if (isPdf) {
    score += 40;
    reasons.push("PDF");
  } else if (isImage) {
    score += 25;
    reasons.push("תמונה");
  } else {
    score -= 50;
    reasons.push("סוג קובץ לא נתמך");
  }

  const size = a.sizeBytes ?? null;
  if (size != null) {
    if (size < 20_000) {
      score -= 25;
      reasons.push("קטן מאוד");
    } else if (size < 150_000) {
      score -= 5;
    } else if (size <= 8_000_000) {
      score += 10;
      reasons.push("גודל סביר");
    } else if (size <= 15_000_000) {
      score += 2;
      reasons.push("גדול");
    } else {
      score -= 30;
      reasons.push("גדול מדי");
    }
  }

  const receiptHints = [
    "receipt",
    "invoice",
    "חשבונית",
    "קבלה",
    "tax",
    "invoice_",
    "חשבונית מס",
  ];
  const hasReceiptHint =
    receiptHints.some((h) => filename.includes(h)) ||
    receiptHints.some((h) => subject.includes(h));
  if (hasReceiptHint) {
    score += 15;
    reasons.push("נראה כמו קבלה/חשבונית");
  }

  const noiseHints = [
    "logo",
    "signature",
    "unsubscribe",
    "facebook",
    "twitter",
    "instagram",
  ];
  const hasNoise =
    noiseHints.some((h) => filename.includes(h)) ||
    noiseHints.some((h) => subject.includes(h));
  if (hasNoise) {
    score -= 25;
    reasons.push("כנראה לא מסמך פיננסי");
  }

  if (fromEmail.endsWith("@gmail.com")) {
    score += 2;
  }

  const bucket: EmailAttachmentBucket =
    score >= 45 ? "recommended" : score >= 20 ? "possible" : "hidden";

  const reason =
    bucket === "recommended"
      ? `מומלץ לייבוא (${score})`
      : bucket === "possible"
        ? `אולי רלוונטי (${score})`
        : `מוסתר (${score})`;

  return {
    score,
    bucket,
    reason: reasons.length ? `${reason} • ${reasons.join(", ")}` : reason,
  };
}

export function scoreAttachments(
  list: GmailDiscoveryAttachment[]
): ScoredAttachment[] {
  return list.map((a) => {
    const { score, bucket, reason } = scoreAttachment(a);
    return { ...a, key: attachmentKey(a), score, bucket, reason };
  });
}
