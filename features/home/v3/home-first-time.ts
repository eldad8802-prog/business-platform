import { showsFirstTime } from "@/lib/services/home/home-history-model";

import type { HomeView } from "./home-v3";

/**
 * The money card's first-time state: no income and no expense ever (history),
 * and nothing in today's series either. Never inferred from today's 0 alone.
 */
export function moneyFirstTime(view: HomeView): boolean {
  const day = view.day.state === "ready" ? view.day.value : null;
  const hasMoneyToday = !!day && (day.income > 0 || (day.expense !== null && day.expense > 0));
  return showsFirstTime(view.history, "income", hasMoneyToday) && showsFirstTime(view.history, "expenses", hasMoneyToday);
}

/** The "tell us about the business" item — only while history says no description exists. */
export function identityPromptDue(view: HomeView): boolean {
  return view.history !== null && view.history.identityDescription === false;
}
