/**
 * "דילוג, אבחר אחר כך" on the activity screens after signup: remembered for this browser session only, so the
 * setup flow does not send the owner back to the screens they just skipped. Nothing is stored on the server — a
 * skipped choice is simply no choice (the Home stays as it is), and Settings → תחומי הפעילות is always there.
 */
const KEY = "dz.activityPacks.skipped";

export function activitySkipped(): boolean {
  try {
    return window.sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markActivitySkipped(): void {
  try {
    window.sessionStorage.setItem(KEY, "1");
  } catch {
    /* private mode: the owner may simply see the screens again in this session */
  }
}
