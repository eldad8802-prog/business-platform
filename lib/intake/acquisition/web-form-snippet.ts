/**
 * The ready-made contact form an owner pastes into their own site (Wix / WordPress "HTML embed").
 *
 * It carries NO secret: it posts from the browser, so the endpoint accepts it only from the site
 * address the owner gave, behind the honeypot and the rate limits.
 *
 * Its one script runs once per page load and:
 *   - gives the form ONE submission id (crypto.randomUUID) — a double-click, a browser retry or a
 *     back + resubmit sends the same id, so it stays ONE receipt; a new page load (a new enquiry —
 *     the thank-you page navigates away) gets a new id, even for identical text. A value the browser
 *     restored (back / bfcache) is kept, never replaced;
 *   - records the page the visitor was on (campaign tags included) for attribution.
 * Without the script (blocked JS, a custom form) the endpoint falls back to content + UTC day.
 */
export const WEB_FORM_SCRIPT =
  "document.querySelectorAll('form[data-dubiz-form]').forEach(function(f){" +
  "var s=f.querySelector('input[name=\"submission_id\"]');" +
  "if(s&&!s.value){s.value=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():" +
  "(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12))}" +
  "var p=f.querySelector('input[name=\"page_url\"]');if(p){p.value=location.href}});";

export function webFormSnippet(url: string): string {
  return [
    `<form data-dubiz-form action="${url}" method="post" accept-charset="UTF-8" dir="rtl" style="display:grid;gap:8px;max-width:420px">`,
    `  <input name="name" placeholder="שם" autocomplete="name">`,
    `  <input name="phone" type="tel" placeholder="טלפון" autocomplete="tel" required>`,
    `  <input name="email" type="email" placeholder="אימייל (לא חובה)" autocomplete="email">`,
    `  <textarea name="message" rows="4" placeholder="במה נוכל לעזור?"></textarea>`,
    `  <input name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-5000px">`,
    `  <input type="hidden" name="submission_id">`,
    `  <input type="hidden" name="page_url">`,
    `  <button type="submit">שליחה</button>`,
    `</form>`,
    `<script>${WEB_FORM_SCRIPT}</script>`,
  ].join("\n");
}
