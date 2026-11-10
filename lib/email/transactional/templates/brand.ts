/**
 * The Dubiz logo at the top of every transactional email.
 *
 * `public/email/dubiz-logo-v1.png` is the official lockup (`public/dubiz-logo.png`, 827×266) scaled to
 * 336×108 — twice the 168×54 it is shown at, so it stays sharp on high-density screens, and ~30 KB so it
 * loads fast. The `-v1` is part of the name on purpose: mail clients and Gmail's image proxy cache by URL,
 * so a changed logo ships under a new name instead of overwriting this one.
 *
 * The URL is absolute (APP_BASE_URL — the same origin as every link in the email) and public: a recipient's
 * mail client fetches it with no session. `alt="Dubiz"` keeps the brand when images are blocked, and the
 * explicit width/height stop the layout from jumping while it loads.
 *
 * This is the logo INSIDE the message. The round avatar Gmail shows next to the sender is a different
 * mechanism (BIMI on the sending domain, or the sending account's own profile picture) and is not set here.
 */
export const EMAIL_LOGO_PATH = "/email/dubiz-logo-v1.png";
export const EMAIL_LOGO_WIDTH = 168;
export const EMAIL_LOGO_HEIGHT = 54;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The header row of the email frame: the logo on the reading-start side (right in Hebrew, left in English). */
export function emailLogoRow(appBaseUrl: string, align: "right" | "left"): string {
  const src = escapeAttr(`${appBaseUrl}${EMAIL_LOGO_PATH}`);
  return `<tr><td align="${align}" style="padding:0 4px 20px 4px;text-align:${align};line-height:0;">`
    + `<img src="${src}" width="${EMAIL_LOGO_WIDTH}" height="${EMAIL_LOGO_HEIGHT}" alt="Dubiz" `
    + `style="display:inline-block;width:${EMAIL_LOGO_WIDTH}px;height:${EMAIL_LOGO_HEIGHT}px;border:0;outline:none;text-decoration:none;">`
    + `</td></tr>`;
}
