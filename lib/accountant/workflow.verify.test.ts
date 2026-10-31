/**
 * Monthly accountant workflow — pure rules (run: npx tsx lib/accountant/workflow.verify.test.ts).
 *
 * Status derivation, notices and the reminder policy (D1), when the sweep prepares, recipient validation (D4),
 * which issued PDFs may enter a package, the link secret (D3), and that the email carries no financial data.
 */

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET ?? "workflow-verify-synthetic-secret-0123456789";

import { readFileSync } from "node:fs";

import { BillingDocumentType, BillingPdfRenderStatus } from "@prisma/client";

import { MAX_ATTEMPTS, RETRY_DELAYS_MS } from "@/lib/email/transactional/delivery";

import { SEND_WINDOW_MS } from "./delivery.service";
import { renderAccountantPackageEmail } from "./email-template";
import { buildAccountantLinkUrl, deriveAccountantLinkSecret, hashAccountantLinkSecret, isLinkPublicId, isLinkSecret, linkExpiry, mintAccountantLink } from "./link";
import { noticeKindFor, reminderDue, translatePeriodNotice } from "./notify";
import { issuedPdfState } from "./period-facts";
import { normalizeRecipientEmail, normalizeRecipientName } from "./recipient.service";
import { latestPeriodNeedsPrepare } from "./sweep";
import { derivePeriodStatus, isRetryAfterNoAnswer, isUncertainOutcome, linkStateOf, periodStatusLabelHe } from "./workflow-status";

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
  ok("the email says what the link gives: every document, the ZIP and both reports", e.text.includes("כל מסמך מקור") && e.text.includes("ZIP") && e.text.includes("Excel") && e.text.includes("PDF") && e.text.includes("פתיחת החבילה"));
}

// ── the scheduler: Vercel Cron, hourly, the existing route only ──
{
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons?: { path: string; schedule: string }[] };
  const mine = (vercel.crons ?? []).filter((c) => c.path === "/api/accountant/sweep");
  ok("cron: vercel.json runs the accountant sweep hourly at :30 — exactly one entry", mine.length === 1 && mine[0].schedule === "30 * * * *", JSON.stringify(mine));
  // G5 milestone 1: the monitor is the only other accountant entry — it reads and alerts, it never prepares or sends.
  const monitor = (vercel.crons ?? []).filter((c) => c.path === "/api/accountant/monitor");
  ok("cron: the accountant monitor runs hourly at :50 — exactly one entry", monitor.length === 1 && monitor[0].schedule === "50 * * * *", JSON.stringify(monitor));
  ok("cron: no other accountant path is scheduled (no parallel mechanism)", (vercel.crons ?? []).filter((c) => c.path.startsWith("/api/accountant/")).length === 2);
  // Retries under an hourly cadence: the spacing becomes max(delay, 1 h); all 7 attempts fit the 24 h window.
  let t = 0;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) t += Math.max(RETRY_DELAYS_MS[attempt - 1], 60 * 60_000);
  ok("cron: hourly retries place all 7 attempts inside the 24 h send window", t < SEND_WINDOW_MS - 60 * 60_000, `${t / 3600_000} h`);
}

// ── G4: an unanswered send, the link's state ──
{
  ok("a FAILED send after a timeout is uncertain", isUncertainOutcome("FAILED", "timeout"));
  ok("…after a network failure on the last retry, too", isUncertainOutcome("FAILED", "network_max_attempts") && isUncertainOutcome("FAILED", "timeout_ttl"));
  ok("a refused send is not uncertain (the provider answered)", !isUncertainOutcome("FAILED", "rejected_422") && !isUncertainOutcome("FAILED", "provider_500_max_attempts"));
  ok("a bounce is not uncertain", !isUncertainOutcome("BOUNCED", "bounced"));
  ok("an accepted send is not uncertain", !isUncertainOutcome("ACCEPTED", null));
  ok("a retry scheduled after a timeout is flagged", isRetryAfterNoAnswer("APPROVED", "timeout") && !isRetryAfterNoAnswer("APPROVED", "rate_limited") && !isRetryAfterNoAnswer("APPROVED", null));
  const at = new Date("2026-10-10T00:00:00Z");
  const exp = new Date("2026-10-20T00:00:00Z");
  ok("link: an accepted send before expiry is live", linkStateOf({ status: "ACCEPTED", linkRevokedAt: null, linkExpiresAt: exp }, at) === "live");
  ok("link: after expiry it is expired", linkStateOf({ status: "DELIVERED", linkRevokedAt: null, linkExpiresAt: exp }, new Date("2026-10-21T00:00:00Z")) === "expired");
  ok("link: revoked wins", linkStateOf({ status: "ACCEPTED", linkRevokedAt: at, linkExpiresAt: exp }, at) === "revoked");
  ok("link: a send that never went out handed no link", linkStateOf({ status: "FAILED", linkRevokedAt: null, linkExpiresAt: exp }, at) === "not_sent" && linkStateOf({ status: "APPROVED", linkRevokedAt: null, linkExpiresAt: exp }, at) === "not_sent");
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nworkflow: all checks passed");
process.exit(0);
