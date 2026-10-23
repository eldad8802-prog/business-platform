/**
 * Monthly accountant workflow — pure rules (run: npx tsx lib/accountant/workflow.verify.test.ts).
 *
 * Status derivation, notices and the reminder policy (D1), when the sweep prepares, recipient validation (D4),
 * which issued PDFs may enter a package, the link secret (D3), and that the email carries no financial data.
 */

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET ?? "workflow-verify-synthetic-secret-0123456789";

import { BillingDocumentType, BillingPdfRenderStatus } from "@prisma/client";

import { renderAccountantPackageEmail } from "./email-template";
import { buildAccountantLinkUrl, deriveAccountantLinkSecret, hashAccountantLinkSecret, isLinkPublicId, isLinkSecret, linkExpiry, mintAccountantLink } from "./link";
import { noticeKindFor, reminderDue, translatePeriodNotice } from "./notify";
import { issuedPdfState } from "./period-facts";
import { normalizeRecipientEmail, normalizeRecipientName } from "./recipient.service";
import { latestPeriodNeedsPrepare } from "./sweep";
import { derivePeriodStatus, periodStatusLabelHe } from "./workflow-status";

let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (!condition) {
    console.error("FAIL:", name, detail);
    failed += 1;
    return;
  }
  console.log("OK:", name);
}

// ── status ──
const base = { readiness: "READY" as const, currentBuildFailed: false, currentPackageReady: true, latestDelivery: null, completedManually: false };
ok("ready package, nothing open → READY_FOR_REVIEW", derivePeriodStatus(base) === "READY_FOR_REVIEW");
ok("open items → NEEDS_ATTENTION (never 'ready')", derivePeriodStatus({ ...base, readiness: "NEEDS_ATTENTION" }) === "NEEDS_ATTENTION");
ok("no package yet → PREPARING", derivePeriodStatus({ ...base, currentPackageReady: false }) === "PREPARING");
ok("a failed build → PREPARATION_FAILED", derivePeriodStatus({ ...base, currentPackageReady: false, currentBuildFailed: true }) === "PREPARATION_FAILED");
ok("an approval waiting → SENDING", derivePeriodStatus({ ...base, latestDelivery: { status: "APPROVED" } }) === "SENDING");
ok("accepted by the provider → SENT", derivePeriodStatus({ ...base, latestDelivery: { status: "ACCEPTED" } }) === "SENT");
ok("delivered → SENT", derivePeriodStatus({ ...base, latestDelivery: { status: "DELIVERED" } }) === "SENT");
ok("bounced → SEND_FAILED", derivePeriodStatus({ ...base, latestDelivery: { status: "BOUNCED" } }) === "SEND_FAILED");
ok("a manual completion beats a failed send", derivePeriodStatus({ ...base, latestDelivery: { status: "FAILED" }, completedManually: true }) === "COMPLETED_MANUALLY");
ok("sent + changed → the label says a revised version waits", periodStatusLabelHe("SENT", true).includes("גרסה חדשה"));

// ── notices ──
ok("ready → READY notice", noticeKindFor({ status: "READY_FOR_REVIEW", changedSinceSent: false }) === "READY");
ok("sending → no notice", noticeKindFor({ status: "SENDING", changedSinceSent: false }) === null);
ok("sent → no notice", noticeKindFor({ status: "SENT", changedSinceSent: false }) === null);
ok("sent + changed → CHANGED notice", noticeKindFor({ status: "SENT", changedSinceSent: true }) === "CHANGED");
ok("send failed → SEND_FAILED notice", noticeKindFor({ status: "SEND_FAILED", changedSinceSent: false }) === "SEND_FAILED");
{
  const now = new Date("2026-10-01T06:00:00Z");
  const ready = translatePeriodNotice({ businessId: 1, periodId: 7, periodKey: "2026-09", status: "READY_FOR_REVIEW", changedSinceSent: false, readiness: null }, "READY", now);
  ok("the owner's wording, exactly", ready.title === "הקובץ לרואה החשבון עבור חודש ספטמבר מוכן לבדיקה ולשליחה.", ready.title);
  ok("the notice opens the exact month", ready.primaryAction.href === "/documents/accountant-pack?period=2026-09");
  ok("in-app documents domain (never push)", ready.domain === "documents" && ready.severity === "MEDIUM");
  const attention = translatePeriodNotice(
    { businessId: 1, periodId: 7, periodKey: "2026-09", status: "NEEDS_ATTENTION", changedSinceSent: false,
      readiness: { status: "NEEDS_ATTENTION", counts: { scannedExpense: 1, scannedIncome: 0, issued: 0, pending: 4 }, blockers: [{ kind: "DOCUMENTS_PENDING_REVIEW", count: 4, ids: [] }], warnings: [], issuedTotals: [] } },
    "ATTENTION", now);
  ok("missing items are never called 'ready'", !attention.title.includes("מוכן") && attention.title.includes("4 פריטים פתוחים"), attention.title);
  ok("a failed send is a FAILURE_EVENT", translatePeriodNotice({ businessId: 1, periodId: 7, periodKey: "2026-09", status: "SEND_FAILED", changedSinceSent: false, readiness: null }, "SEND_FAILED", now).semanticCategory === "FAILURE_EVENT");
}

// ── reminders (D1) ──
{
  const notifiedAt = new Date("2026-10-01T06:00:00Z");
  const at = (iso: string, remindersSent = 0, lastReminderAt: Date | null = null, periodKey = "2026-09", status: "READY_FOR_REVIEW" | "SENT" = "READY_FOR_REVIEW") =>
    reminderDue({ periodKey, status, notifiedStatus: "READY_FOR_REVIEW", notifiedAt, lastReminderAt, remindersSent, now: new Date(iso) });
  ok("no reminder on the 3rd", !at("2026-10-03T06:00:00Z").remind);
  ok("first reminder from the 5th", at("2026-10-05T06:00:00Z").remind);
  ok("second reminder not before the 10th", !at("2026-10-08T06:00:00Z", 1, new Date("2026-10-05T06:00:00Z")).remind);
  ok("second reminder on the 10th", at("2026-10-10T06:00:00Z", 1, new Date("2026-10-05T06:00:00Z")).remind);
  ok("never a third", !at("2026-10-20T06:00:00Z", 2, new Date("2026-10-10T06:00:00Z")).remind);
  ok("never for an older month", !at("2026-11-05T06:00:00Z", 0, null, "2026-09").remind);
  ok("never once the month is sent", !at("2026-10-05T06:00:00Z", 0, null, "2026-09", "SENT").remind);
  ok("never within 72h of the last notice", !reminderDue({ periodKey: "2026-09", status: "READY_FOR_REVIEW", notifiedStatus: "READY_FOR_REVIEW", notifiedAt: new Date("2026-10-04T06:00:00Z"), lastReminderAt: null, remindersSent: 0, now: new Date("2026-10-05T06:00:00Z") }).remind);
}

// ── when the sweep prepares ──
{
  const now = new Date("2026-10-02T06:00:00Z");
  const h = (n: number) => new Date(now.getTime() - n * 3600_000);
  ok("a month never seen is prepared", latestPeriodNeedsPrepare(null, now));
  ok("a dirty month is prepared", latestPeriodNeedsPrepare({ status: "SENT", dirtyAt: h(1), evaluatedAt: h(2), leaseUntil: null }, now));
  ok("a month under a live lease is left alone", !latestPeriodNeedsPrepare({ status: "PREPARING", dirtyAt: h(1), evaluatedAt: null, leaseUntil: new Date(now.getTime() + 60_000) }, now));
  ok("a failed preparation is retried after an hour", latestPeriodNeedsPrepare({ status: "PREPARATION_FAILED", dirtyAt: null, evaluatedAt: h(2), leaseUntil: null }, now));
  ok("…not sooner", !latestPeriodNeedsPrepare({ status: "PREPARATION_FAILED", dirtyAt: null, evaluatedAt: h(0.5), leaseUntil: null }, now));
  ok("an owner-action month is re-checked daily", latestPeriodNeedsPrepare({ status: "READY_FOR_REVIEW", dirtyAt: null, evaluatedAt: h(21), leaseUntil: null }, now));
  ok("a sent month is not re-checked without a change", !latestPeriodNeedsPrepare({ status: "SENT", dirtyAt: null, evaluatedAt: h(200), leaseUntil: null }, now));
}

// ── recipient (D4) ──
ok("an address is normalised", normalizeRecipientEmail("  Dana@Example.COM ") === "dana@example.com");
for (const bad of ["", "dana", "dana@", "@example.com", "dana@example", "da..na@example.com", "dana@exa mple.com", "dana@example.c", "<dana@example.com>", "dana@example.123", "a,b@example.com"]) {
  ok(`"${bad}" is refused`, normalizeRecipientEmail(bad) === null);
}
ok("a name is trimmed", normalizeRecipientName("  רו\"ח   דנה ") === "רו\"ח דנה");
ok("control characters in a name are refused", normalizeRecipientName("a\u0007b") === null);

// ── issued PDFs ──
{
  const doc = {
    documentType: BillingDocumentType.RECEIPT,
    pdfRenderStatus: BillingPdfRenderStatus.RENDERED,
    pdfStorageKey: "biz/1/billing/2/" + "a".repeat(64) + ".pdf",
    pdfHash: "a".repeat(64),
    signedPdfStorageKey: null,
    signedPdfHash: null,
    allocationNumber: null,
    authoritySubmission: null,
  };
  ok("a rendered receipt is available", issuedPdfState(doc, false).available);
  ok("a pending render is not", !issuedPdfState({ ...doc, pdfRenderStatus: BillingPdfRenderStatus.PENDING }, false).available);
  ok("a failed render is RENDER_FAILED", (issuedPdfState({ ...doc, pdfRenderStatus: BillingPdfRenderStatus.FAILED }, false) as { reason?: string }).reason === "RENDER_FAILED");
  ok("with signing active, only the signed copy counts", (issuedPdfState(doc, true) as { reason?: string }).reason === "NOT_SIGNED");
  const signed = issuedPdfState({ ...doc, signedPdfStorageKey: "biz/1/billing/2/" + "b".repeat(64) + ".pdf", signedPdfHash: "b".repeat(64) }, true);
  ok("…and is served when it exists", signed.available && signed.sha256 === "b".repeat(64));
}

// ── link (D3) ──
{
  const m = mintAccountantLink();
  ok("a public id is 32 url-safe characters", isLinkPublicId(m.publicId));
  const secret = deriveAccountantLinkSecret(m.publicId);
  ok("the secret is 43 url-safe characters", isLinkSecret(secret));
  ok("only the hash is kept", m.tokenHash === hashAccountantLinkSecret(secret) && !m.tokenHash.includes(secret));
  ok("two links never share a secret", deriveAccountantLinkSecret(mintAccountantLink().publicId) !== secret);
  const url = buildAccountantLinkUrl("https://app.example.com", m.publicId);
  ok("the secret travels in the fragment only", url === `https://app.example.com/a/${m.publicId}#t=${secret}`);
  const approvedAt = new Date("2026-10-02T06:00:00Z");
  ok("the link lives 14 days", linkExpiry(approvedAt).getTime() - approvedAt.getTime() === 14 * 86400_000);
  const other = process.env.AUTH_TOKEN_SECRET;
  process.env.AUTH_TOKEN_SECRET = "a-different-synthetic-secret-0123456789abcd";
  ok("rotating AUTH_TOKEN_SECRET invalidates the link", deriveAccountantLinkSecret(m.publicId) !== secret);
  process.env.AUTH_TOKEN_SECRET = other;
}

// ── email ──
{
  const e = renderAccountantPackageEmail({
    businessName: "מאפיית הלב",
    recipientName: "דנה",
    periodLabel: "ספטמבר 2026",
    link: "https://app.example.com/a/x#t=y",
    expiresOn: "16.10.2026",
    incomplete: true,
  });
  ok("the subject names the business and the month", e.subject === "חבילת רואה החשבון של מאפיית הלב — ספטמבר 2026");
  ok("text and html carry the same link", e.text.includes("https://app.example.com/a/x#t=y") && e.html.includes("https://app.example.com/a/x#t=y"));
  ok("an incomplete package says so", e.text.includes("עדיין פתוחים"));
  ok("names are escaped in html", renderAccountantPackageEmail({ businessName: "<b>x</b>", recipientName: "", periodLabel: "p", link: "https://a/b", expiresOn: "d", incomplete: false }).html.includes("&lt;b&gt;"));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nworkflow: all checks passed");
process.exit(0);
