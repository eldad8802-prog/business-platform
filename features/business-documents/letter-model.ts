/**
 * ר2 — the letter form's state in the browser. Pure.
 *
 * The draft lives only on this device (localStorage) until saving letters in the
 * system is approved (schema proposal). The server validates everything again.
 */

export type LetterForm = {
  recipientKind: "customer" | "supplier" | "free";
  customerId: string;
  supplierId: string;
  recipientName: string;
  recipientAddress: string;
  subject: string;
  body: string;
  date: string;
  reference: string;
  signerName: string;
  signerTitle: string;
  includeSignatureImage: boolean;
};

export const DRAFT_STORAGE_KEY = "dubiz.business-documents.letter-draft.v1";

export function emptyLetter(today: string): LetterForm {
  return {
    recipientKind: "free",
    customerId: "",
    supplierId: "",
    recipientName: "",
    recipientAddress: "",
    subject: "",
    body: "",
    date: today,
    reference: "",
    signerName: "",
    signerTitle: "",
    includeSignatureImage: false,
  };
}

/** The request body for the preview / PDF routes. */
export function toRequestBody(f: LetterForm): Record<string, unknown> {
  return {
    recipientKind: f.recipientKind,
    customerId: f.recipientKind === "customer" && f.customerId ? Number(f.customerId) : null,
    supplierId: f.recipientKind === "supplier" && f.supplierId ? Number(f.supplierId) : null,
    recipientName: f.recipientName,
    recipientAddress: f.recipientAddress,
    subject: f.subject,
    body: f.body,
    date: f.date,
    reference: f.reference,
    signerName: f.signerName,
    signerTitle: f.signerTitle,
    includeSignatureImage: f.includeSignatureImage,
  };
}

/** Restores a saved draft; anything malformed falls back to an empty letter (never throws). */
export function restoreDraft(raw: string | null, today: string): LetterForm {
  const base = emptyLetter(today);
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof LetterForm, unknown>>;
    const str = (k: keyof LetterForm) => (typeof v[k] === "string" ? (v[k] as string) : (base[k] as string));
    const kind = v.recipientKind === "customer" || v.recipientKind === "supplier" || v.recipientKind === "free" ? v.recipientKind : base.recipientKind;
    return {
      recipientKind: kind,
      customerId: str("customerId"),
      supplierId: str("supplierId"),
      recipientName: str("recipientName"),
      recipientAddress: str("recipientAddress"),
      subject: str("subject"),
      body: str("body"),
      date: /^\d{4}-\d{2}-\d{2}$/.test(str("date")) ? str("date") : today,
      reference: str("reference"),
      signerName: str("signerName"),
      signerTitle: str("signerTitle"),
      includeSignatureImage: v.includeSignatureImage === true,
    };
  } catch {
    return base;
  }
}

/** Client-side hints only (the server is the authority): what is missing before a preview makes sense. */
export function missingFields(f: LetterForm): Array<keyof LetterForm> {
  const out: Array<keyof LetterForm> = [];
  if (f.recipientKind === "customer" && !f.customerId) out.push("customerId");
  if (f.recipientKind === "supplier" && !f.supplierId) out.push("supplierId");
  if (f.recipientKind === "free" && !f.recipientName.trim()) out.push("recipientName");
  if (!f.subject.trim()) out.push("subject");
  if (!f.body.trim()) out.push("body");
  return out;
}

export const FIELD_LABEL: Record<keyof LetterForm, string> = {
  recipientKind: "נמען",
  customerId: "לקוח",
  supplierId: "ספק",
  recipientName: "שם הנמען",
  recipientAddress: "כתובת",
  subject: "הנדון",
  body: "תוכן המכתב",
  date: "תאריך",
  reference: "סימוכין",
  signerName: "שם החותם",
  signerTitle: "תפקיד",
  includeSignatureImage: "חתימה",
};

export function letterErrorText(status: number | null): string {
  if (status === 400) return "יש שדות שצריך לתקן.";
  if (status === 401) return "צריך להתחבר מחדש.";
  if (status === 404) return "הנמען לא נמצא, או שהמסך עדיין לא פתוח לעסק.";
  if (status === null) return "אין חיבור. אפשר לנסות שוב.";
  return "לא הצלחנו להכין את המכתב. אפשר לנסות שוב.";
}
