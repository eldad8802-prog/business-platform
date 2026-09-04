/**
 * A hub row for a capability that EXISTS in the product's plan but cannot be
 * used yet.
 *
 * # Why this is not a disabled link
 *
 * A greyed-out control that still looks pressable reads as a bug: the owner
 * clicks, nothing happens, and they conclude the app is broken. A control that
 * navigates to a placeholder is worse — now they are on a dead screen. So this
 * row is not interactive at all. It is a plain `div`: no href, no button, not
 * in the tab order, nothing to press.
 *
 * What it does instead is TELL them. The row keeps the same icon, title and
 * description as a real action, and carries a small "בקרוב" pill. That is the
 * honest message — the Center will move information in as well as out, and
 * today the available direction is out.
 *
 * Deliberately mirrors `SettingsRow`'s markup and token usage rather than
 * modifying that shared primitive, which is used by every other Settings
 * screen and has no reason to grow a "pending" mode for one caller.
 */

type Props = {
  icon: string;
  title: string;
  description: string;
  /** Short status word. Kept a prop so the wording is not baked into layout. */
  status?: string;
};

export function ImportExportPendingRow({
  icon,
  title,
  description,
  status = "בקרוב",
}: Props) {
  return (
    <div className="flex w-full items-start gap-3 rounded-2xl px-2 py-3 text-right">
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--dz-background)] text-lg">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-bold text-[var(--dz-text-primary)]">
            {title}
          </span>
          <span className="rounded-full bg-[var(--dz-surface-muted)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dz-text-muted)]">
            {status}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--dz-text-muted)]">
          {description}
        </span>
      </span>
      {/* Occupies the chevron's slot so the two rows stay optically aligned,
          without implying that this one goes anywhere. */}
      <span className="shrink-0 self-center text-lg" aria-hidden>
        {" "}
      </span>
    </div>
  );
}
