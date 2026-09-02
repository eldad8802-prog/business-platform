/**
 * Release gate for הגדרות → ייבוא וייצוא.
 *
 * # The rule this enforces
 *
 * `settings-categories.ts` already states the product law: "A category is
 * listed only when it shows real information, allows a real action, or links to
 * an owner screen that solves a real need. Not-yet-ready capabilities are not
 * shown at all." A row that opens a screen which cannot yet DO anything is dead
 * navigation, and a visibly disabled "coming soon" control is the same failure
 * wearing a nicer coat.
 *
 * So until the first real capability ships (Export, increment I-3), the whole
 * surface is closed:
 *
 *  1. {@link IMPORT_EXPORT_SETTINGS_CATEGORY} is defined here but is NOT spread
 *     into `SETTINGS_CATEGORIES`, so no Settings row exists.
 *  2. The route itself calls `notFound()` while this flag is false, so the
 *     screen is not reachable by typing the URL either. Half-built scaffolding
 *     that renders in production is still exposure.
 *
 * A plain module constant is deliberate: no env var (which someone could set in
 * production by accident), no database row, no migration, no feature-flag
 * service. Releasing is a code change that goes through review — which is
 * exactly the ceremony this decision deserves.
 *
 * # Releasing (increment I-3)
 *
 * Flip this to `true` in the SAME change that ships a working Export flow, and
 * add {@link IMPORT_EXPORT_SETTINGS_CATEGORY} to `SETTINGS_CATEGORIES`. Both
 * halves together, never one without the other — the verifier asserts they stay
 * in step. Decide at that point how Import is presented while it is still
 * unbuilt; do not pre-empt it here.
 */

import type { SettingsCategory } from "@/components/settings/settings-categories";

/** Canonical route for the Import/Export hub. */
export const IMPORT_EXPORT_ROUTE = "/settings/import-export";

/**
 * False until a real capability exists behind the screen. See the module note:
 * flipping this WITHOUT shipping a working flow re-creates dead navigation.
 */
export const IMPORT_EXPORT_RELEASED = false;

/**
 * The Settings row, ready to list. Held here rather than in
 * `settings-categories.ts` precisely so that its presence in the array is the
 * single, reviewable act of releasing the feature.
 */
export const IMPORT_EXPORT_SETTINGS_CATEGORY: SettingsCategory = {
  key: "import-export",
  href: IMPORT_EXPORT_ROUTE,
  title: "ייבוא וייצוא",
  description: "העבר מידע ממערכת אחרת, או הורד עותק של המידע שלך",
  icon: "🔄",
};
