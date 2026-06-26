// Typed Gmail integration errors so route handlers can translate failures into
// clear, actionable states for the user instead of a single opaque HTTP 500.
//
// Each code maps to a stable HTTP status and a Hebrew, user-facing message that
// tells the business owner what actually happened and what to do next.

export type GmailErrorCode =
  | "not_connected" // no active Gmail connection for this business
  | "reauth_required" // token expired / decrypt failed / refresh rejected
  | "service_unavailable" // server misconfiguration (missing env / keys)
  | "upstream_error"; // Gmail API returned an unexpected failure

const STATUS_BY_CODE: Record<GmailErrorCode, number> = {
  not_connected: 409,
  reauth_required: 401,
  service_unavailable: 503,
  upstream_error: 502,
};

const MESSAGE_BY_CODE: Record<GmailErrorCode, string> = {
  not_connected: "תיבת ה-Gmail אינה מחוברת. חבר את החשבון כדי לקלוט מסמכים מהמייל.",
  reauth_required: "החיבור ל-Gmail פג או אינו תקף. יש להתחבר מחדש כדי להמשיך.",
  service_unavailable: "שירות ה-Gmail אינו זמין כרגע. נסה שוב מאוחר יותר.",
  upstream_error: "התרחשה תקלה מול שרתי Gmail. נסה שוב בעוד מספר רגעים.",
};

export class GmailServiceError extends Error {
  readonly code: GmailErrorCode;
  readonly httpStatus: number;
  readonly userMessage: string;

  constructor(code: GmailErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GmailServiceError";
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.userMessage = MESSAGE_BY_CODE[code];
  }
}

export function isGmailServiceError(error: unknown): error is GmailServiceError {
  return error instanceof GmailServiceError;
}
