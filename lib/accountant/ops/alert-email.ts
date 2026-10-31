/**
 * The operator's alert email — one digest per monitor run, to ONE configured address (ACCOUNTANT_OPS_ALERT_EMAIL),
 * through the existing provider layer (Resend) with a provider idempotency key derived from exactly what was claimed:
 * a retry of the same claims (after a failed send) is the same key, so the provider sends it at most once.
 *
 * WHAT IT CARRIES: the finding (Hebrew title), its scope ("עסק #9 · חודש 2026-09" / "שליחה #12" / "פלטפורמה"),
 * since when, and whether it is new, a reminder or resolved; a link to the admin console's monitoring page.
 * NEVER: a recipient address, a link of the accountant, a token, a business name, a document or an amount.
 *
 * Flooding: one message per run, at most MAX_ITEMS lines (the rest counted, and visible in the console); a finding
 * is announced once, reminded at most once a day, and announced once when it resolves (lib/accountant/ops/alert-store.ts).
 */

import { createHash } from "node:crypto";

import { isValidAddress, readTransactionalEmailConfig, type TransactionalEmailEnv } from "@/lib/email/transactional/config";
import type { EmailProvider, SendResult } from "@/lib/email/transactional/provider";
import { createResendProvider } from "@/lib/email/transactional/resend";
import type { Claim } from "./alert-store";
import { FINDING_SPECS, isFindingCode, subjectLabelHe } from "./findings";

export const MAX_ITEMS = 25;
export const OPS_PAGE_PATH = "/admin/accountant-ops";

export type AlertChannel =
  | { ok: true; to: string; from: string; replyTo: string | null; appBaseUrl: string; apiKey: string }
  | { ok: false; reason: "alert_email_missing" | "email_not_configured" };

/** The alert channel: the operator's address plus the existing transactional email configuration. */
export function readAlertChannel(env: TransactionalEmailEnv = process.env): AlertChannel {
  const to = env.ACCOUNTANT_OPS_ALERT_EMAIL?.trim().toLowerCase() ?? "";
  if (!to || !isValidAddress(to)) return { ok: false, reason: "alert_email_missing" };
  const cfg = readTransactionalEmailConfig(env);
  if (!cfg.enabled || !("ok" in cfg) || !cfg.ok) return { ok: false, reason: "email_not_configured" };
  return { ok: true, to, from: cfg.config.from, replyTo: cfg.config.replyTo, appBaseUrl: cfg.config.appBaseUrl, apiKey: cfg.config.apiKey };
}

const SEVERITY_HE: Record<string, string> = { CRITICAL: "קריטי", HIGH: "גבוה", MEDIUM: "בינוני" };
const RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
const KIND_HE: Record<Claim["kind"], string> = { open: "חדש", reminder: "תזכורת", resolved: "נפתר" };
const timeHe = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short" });

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function titleOf(code: string): string {
  return code === "SIMULATION" ? "בדיקת ערוץ ההתראות — אין תקלה אמיתית" : isFindingCode(code) ? FINDING_SPECS[code].titleHe : code;
}

export function scopeLabelHe(c: Pick<Claim, "scope" | "subjectKey">): string {
  const subject = subjectLabelHe(c.subjectKey);
  if (c.scope.kind === "platform") return subject ? `פלטפורמה · ${subject}` : "פלטפורמה";
  return subject ? `עסק #${c.scope.businessId} · ${subject}` : `עסק #${c.scope.businessId}`;
}

/** The provider idempotency key of a digest: the same claims always make the same key. */
export function digestKey(claims: Claim[], prefix = "acctops"): string {
  const tokens = claims
    .map((c) => `${c.scope.kind === "platform" ? "p" : `b${c.scope.businessId}`}:${c.alertId}:${c.kind === "resolved" ? "r" : c.notifyCount}`)
    .sort();
  return `${prefix}:${createHash("sha256").update(tokens.join(",")).digest("hex").slice(0, 40)}`;
}

export function renderDigest(claims: Claim[], appBaseUrl: string, opts: { simulation?: boolean } = {}) {
  const sorted = [...claims].sort(
    (a, b) => (a.kind === "resolved" ? 1 : 0) - (b.kind === "resolved" ? 1 : 0) || (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.alertId - b.alertId
  );
  const shown = sorted.slice(0, MAX_ITEMS);
  const more = sorted.length - shown.length;
  const fresh = claims.filter((c) => c.kind === "open").length;
  const reminders = claims.filter((c) => c.kind === "reminder").length;
  const resolved = claims.filter((c) => c.kind === "resolved").length;
  const parts = [fresh ? `${fresh} חדשות` : "", reminders ? `${reminders} תזכורות` : "", resolved ? `${resolved} נפתרו` : ""].filter(Boolean);
  const subject = opts.simulation
    ? "Dubiz · ניטור חבילת רואה החשבון: בדיקת ערוץ (סימולציה)"
    : `Dubiz · ניטור חבילת רואה החשבון: ${parts.join(", ")}`;
  const href = `${appBaseUrl}${OPS_PAGE_PATH}`;
  const line = (c: Claim) =>
    `${KIND_HE[c.kind]} · ${SEVERITY_HE[c.severity] ?? c.severity} · ${titleOf(c.code)} · ${scopeLabelHe(c)} · מאז ${timeHe.format(c.openedAt)}` +
    (c.kind === "reminder" ? ` · הודעה ${c.notifyCount}` : "");
  const footer =
    "כל תקלה נשלחת פעם אחת, עם תזכורת אחת ביום כל עוד היא פתוחה, והודעה אחת כשהיא נפתרת. אין בהודעה כתובות, קישורים של רואה החשבון או מסמכים.";
  const text = [
    opts.simulation ? "זו הודעת בדיקה של ערוץ ההתראות. לא נמצאה תקלה, ולא נקרא ולא שונה דבר במערכת." : "",
    ...shown.map(line),
    more > 0 ? `ועוד ${more} — בפאנל הניהול.` : "",
    "",
    `לפרטים: ${href}`,
    footer,
  ]
    .filter((s, i) => s !== "" || i > 0)
    .join("\n");
  const html = `<!doctype html><html lang="he" dir="rtl"><body style="font-family:Arial,sans-serif;direction:rtl;text-align:right">
${opts.simulation ? `<p><strong>זו הודעת בדיקה של ערוץ ההתראות.</strong> לא נמצאה תקלה, ולא נקרא ולא שונה דבר במערכת.</p>` : ""}
<ul>${shown.map((c) => `<li>${escapeHtml(line(c))}</li>`).join("")}</ul>
${more > 0 ? `<p>ועוד ${more} — בפאנל הניהול.</p>` : ""}
<p><a href="${escapeHtml(href)}">לפאנל הניטור</a></p>
<p style="color:#666;font-size:12px">${escapeHtml(footer)}</p>
</body></html>`;
  return { subject, text, html };
}

export type DigestOutcome = { status: "none" } | { status: "sent"; providerMessageId: string | null } | { status: "failed"; code: string };

/** Sends one digest. Never throws: a failure is an outcome. */
export async function sendDigest(
  claims: Claim[],
  channel: Extract<AlertChannel, { ok: true }>,
  opts: { provider?: EmailProvider; simulation?: boolean; idempotencyKey?: string } = {}
): Promise<DigestOutcome> {
  if (claims.length === 0) return { status: "none" };
  try {
    const provider = opts.provider ?? createResendProvider({ apiKey: channel.apiKey });
    const rendered = renderDigest(claims, channel.appBaseUrl, { simulation: opts.simulation });
    const result: SendResult = await provider.send({
      idempotencyKey: opts.idempotencyKey ?? digestKey(claims),
      from: channel.from,
      replyTo: channel.replyTo,
      to: channel.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (result.outcome === "sent") return { status: "sent", providerMessageId: result.providerMessageId };
    return { status: "failed", code: result.code };
  } catch (e) {
    return { status: "failed", code: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "send_error" };
  }
}
