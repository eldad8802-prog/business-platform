/**
 * Locale-aware presentation of money, numbers and dates — the one formatter module new code uses.
 *
 * Hebrew output is byte-identical to the legacy `lib/ui/money.ts` (`₪1,500`, `₪1,500.5`, "—"),
 * because existing Hebrew screens must not change. Other locales use Intl's own currency pattern.
 *
 * Presentation only: it never converts. A converted value is formatted with `approximate: true`,
 * which prefixes "≈" — the caller got that flag from the conversion result (lib/money/fx.ts).
 */
import { DEFAULT_REGION, DEFAULT_TIME_ZONE, intlTag, type Locale } from "./config";
import { currencyExponent, currencySymbol, isSupportedCurrency } from "@/lib/money/currency";
import { toDecimalString, type Money } from "@/lib/money/money";

export type FormatContext = {
  readonly locale: Locale;
  readonly region?: string;
  readonly timeZone?: string;
};

export type MoneyFormatOptions = {
  /** Mark the value as converted / indicative ("≈"). */
  readonly approximate?: boolean;
  /** Always show the minor digits (1,500.00). Default: as the legacy formatter, no forced minimum. */
  readonly fixedFraction?: boolean;
};

function toNumberText(amount: number | string | { toString(): string }): string | null {
  if (typeof amount === "number") return Number.isFinite(amount) ? String(amount) : null;
  const text = String(amount).trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

/** Formats a decimal amount in `currency`. null / malformed → "—" (as the legacy helper). */
export function formatAmount(
  amount: number | string | { toString(): string } | null | undefined,
  currency: string,
  ctx: FormatContext,
  opts: MoneyFormatOptions = {}
): string {
  if (amount === null || amount === undefined) return "—";
  const text = toNumberText(amount);
  if (text === null) return "—";
  const digits = isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
  const minimumFractionDigits = opts.fixedFraction ? digits : 0;
  const prefix = opts.approximate ? "≈" : "";
  // Intl formats string input exactly (no float round-trip) where supported; Number otherwise.
  const value = Number(text);

  if (ctx.locale === "he") {
    const symbol = currencySymbol(currency);
    const body = value.toLocaleString(intlTag("he", ctx.region ?? DEFAULT_REGION), {
      maximumFractionDigits: digits,
      minimumFractionDigits,
    });
    return `${prefix}${symbol}${body}`;
  }

  const body = new Intl.NumberFormat(intlTag(ctx.locale, ctx.region ?? DEFAULT_REGION), {
    style: "currency",
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "XXX",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: digits,
    minimumFractionDigits,
  }).format(value);
  return `${prefix}${body}`;
}

export function formatMoney(value: Money | null | undefined, ctx: FormatContext, opts?: MoneyFormatOptions): string {
  if (!value) return "—";
  return formatAmount(toDecimalString(value), value.currency, ctx, opts);
}

export function formatNumber(value: number | null | undefined, ctx: FormatContext, maxFractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(intlTag(ctx.locale, ctx.region ?? DEFAULT_REGION), {
    maximumFractionDigits: maxFractionDigits,
  });
}

export type DateStyle = "date" | "dateTime" | "time" | "dayMonth";

const DATE_OPTIONS: Readonly<Record<DateStyle, Intl.DateTimeFormatOptions>> = {
  date: { day: "2-digit", month: "2-digit", year: "numeric" },
  dateTime: { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" },
  time: { hour: "2-digit", minute: "2-digit" },
  dayMonth: { day: "numeric", month: "long" },
};

/** Dates always render in the BUSINESS time zone (default Jerusalem), never the device's. */
export function formatDate(
  value: Date | string | number | null | undefined,
  ctx: FormatContext,
  style: DateStyle = "date"
): string {
  if (value === null || value === undefined) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(intlTag(ctx.locale, ctx.region ?? DEFAULT_REGION), {
    ...DATE_OPTIONS[style],
    timeZone: ctx.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(date);
}
