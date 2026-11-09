/**
 * The ready-made contact form an owner pastes into their own site (Wix / WordPress "HTML embed").
 *
 * It carries NO secret: it posts from the browser, so the endpoint accepts it only from the site
 * address the owner gave, behind the honeypot and the rate limits.
 *
 * Its one script runs once per page load and:
 *   - gives the form ONE submission id (crypto.randomUUID) — a double-click or a browser retry of the
 *     same page sends the same id, so it stays ONE receipt; a new page load (a new enquiry — the
 *     thank-you page navigates away) gets a new id, even for identical text. A value the browser
 *     restored is kept, never replaced;
 *   - records the page the visitor was on (campaign tags included) for attribution;
 *   - makes "back + resubmit" behave the same in every browser. Chromium re-loads the page on "back" and
 *     restores the visible fields only — after this script already minted a NEW id — so an unchanged
 *     resubmit became a second enquiry; WebKit keeps the page, id included, so a resubmit after EDITING
 *     the enquiry reused the old id and was dropped as a replay. On submit the script remembers, per form,
 *     the id it sent and a hash of the fields (never their values) in sessionStorage; coming back to the
 *     same, unchanged form gives that id again, and sending a changed form under an id already sent gives
 *     it a new one. Without sessionStorage / the Navigation Timing API it behaves exactly as before.
 * Without the script (blocked JS, a custom form) the endpoint falls back to content + UTC day.
 */
export const WEB_FORM_SCRIPT =
  "document.querySelectorAll('form[data-dubiz-form]').forEach(function(f){" +
  "var s=f.querySelector('input[name=\"submission_id\"]');" +
  "function g(){return(self.crypto&&crypto.randomUUID)?crypto.randomUUID():" +
  "(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12))}" +
  "if(s&&!s.value){s.value=g()}" +
  "var p=f.querySelector('input[name=\"page_url\"]');if(p){p.value=location.href}" +
  "if(!s||!f.addEventListener)return;" +
  "var K='dubiz-form:'+(f.getAttribute('action')||'');" +
  // FNV-1a over the visitor's answers (every named field but the id, the page and the honeypot): a hash, never a value.
  "function h(){var t='',e=f.elements,i,x,v=2166136261;for(i=0;i<e.length;i++){x=e[i];" +
  "if(x.name&&x.name!=='submission_id'&&x.name!=='page_url'&&x.name!=='_hp'){t+=x.name+'='+x.value+'\\u0001'}}" +
  "for(i=0;i<t.length;i++){v^=t.charCodeAt(i);v=Math.imul(v,16777619)>>>0}return String(v)}" +
  "function r(){try{return JSON.parse(sessionStorage.getItem(K)||'null')}catch(_){return null}}" +
  "f.addEventListener('submit',function(){try{var c=h(),l=r();" +
  "if(l&&l.i===s.value&&l.h!==c){s.value=g()}" +
  "sessionStorage.setItem(K,JSON.stringify({i:s.value,h:c}))}catch(_){}});" +
  "if(self.addEventListener)self.addEventListener('pageshow',function(){try{var n=performance.getEntriesByType('navigation')[0],l;" +
  "if(!n||n.type!=='back_forward')return;l=r();if(l&&l.i&&l.h===h()){s.value=l.i}}catch(_){}})});";

/** 1×1, clipped, transparent, not clickable — present in the form and its submission, never laid out wider than it. */
export const HONEYPOT_STYLE =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;opacity:0;pointer-events:none";

export function webFormSnippet(url: string): string {
  return [
    `<form data-dubiz-form action="${url}" method="post" accept-charset="UTF-8" dir="rtl" style="display:grid;gap:8px;max-width:420px">`,
    `  <input name="name" placeholder="שם" autocomplete="name">`,
    `  <input name="phone" type="tel" placeholder="טלפון" autocomplete="tel" required>`,
    `  <input name="email" type="email" placeholder="אימייל (לא חובה)" autocomplete="email">`,
    `  <textarea name="message" rows="4" placeholder="במה נוכל לעזור?"></textarea>`,
    // The honeypot stays a real, named, submitted field (bots fill it; the endpoint drops such posts). Hidden IN PLACE —
    // an off-screen offset (left:-5000px) widened a right-to-left page to ~5,400px and Android zoomed the form away.
    `  <input name="_hp" tabindex="-1" autocomplete="off" aria-hidden="true" style="${HONEYPOT_STYLE}">`,
    `  <input type="hidden" name="submission_id">`,
    `  <input type="hidden" name="page_url">`,
    `  <button type="submit">שליחה</button>`,
    `</form>`,
    `<script>${WEB_FORM_SCRIPT}</script>`,
  ].join("\n");
}
