"use client";

import { TOKEN } from "@/lib/design/tokens";
import { useI18n } from "@/components/i18n/I18nProvider";
import { currencySymbol, type CurrencyCode } from "@/lib/money/currency";

const W = TOKEN.warm;

/**
 * The compact currency choice on the details step of a standalone request.
 *
 * Renders NOTHING unless `shown` — an ILS-only business sees the screen exactly
 * as it was. The caller decides `shown` with `showCurrencyChoice`.
 */
export function CollectionCurrencyChoice(props: {
  shown: boolean;
  offerable: readonly CurrencyCode[];
  value: string;
  onChange: (currency: CurrencyCode) => void;
}) {
  const { t: tr } = useI18n();
  if (!props.shown) return null;
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
      <legend style={{ fontWeight: 700, color: W.ink, marginBottom: 6 }}>{tr("money.collection.create.currencyLegend")}</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {props.offerable.map((c) => {
          const active = props.value === c;
          return (
            <label
              key={c}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6, minHeight: 40, padding: "6px 12px", borderRadius: 999, cursor: "pointer",
                border: `1px solid ${active ? W.tealDeep : W.line}`, background: active ? W.surface2 : W.surface, color: W.ink, fontSize: 15,
              }}
            >
              <input type="radio" name="currency" value={c} checked={active} onChange={() => props.onChange(c)} />
              <span>{currencySymbol(c)} {tr(`currency.${c}`)}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
