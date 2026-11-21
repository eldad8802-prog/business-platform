/**
 * Loads the activity-pack ordering engine on demand. Called ONLY for a business whose capabilities carry a pack
 * selection (activity_packs ON and the owner chose) — so a business without packs (every business today) never
 * downloads the tables and ordering code (i18n en-chunk proof: Hebrew client JS budget on every page).
 *
 * A failed load resolves to null: the caller keeps the pre-packs order. Never a wrong capability.
 */
import type { PackEngine } from "./home-access";

let pending: Promise<PackEngine | null> | null = null;

export function loadPackEngine(): Promise<PackEngine | null> {
  if (!pending) {
    pending = import("./activity-packs-home")
      .then((m) => m.PACK_ENGINE)
      .catch(() => {
        pending = null; // a later attempt may succeed (e.g. after a network blip)
        return null;
      });
  }
  return pending;
}
