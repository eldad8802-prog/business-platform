import type { Messages } from "./types";
import { apiEn } from "./areas/api.en";
import { insightsEn } from "./areas/insights.en";
import { systemEn } from "./areas/system.en";
import { homeEn } from "./areas/home.en";
import { inboxEn } from "./areas/inbox.en";
import { documentsEn } from "./areas/documents.en";
import { billingEn } from "./areas/billing.en";
import { moneyEn } from "./areas/money.en";
import { customersEn } from "./areas/customers.en";
import { tasksEn } from "./areas/tasks.en";
import { accountEn } from "./areas/account.en";
import { contentEn } from "./areas/content.en";

/** English. Must provide every key of the Hebrew source dictionary (the type enforces it). */
export const en: Messages = {
  meta: {
    titles: {
      home: "Home",
      documents: "Documents",
      inventory: "Inventory",
      suppliers: "Suppliers",
      billing: "Invoices",
      settings: "Settings",
      login: "Sign in",
      register: "Sign up",
      forgotPassword: "Forgot password",
      resetPassword: "Choose a new password",
      verifyEmail: "Verify your email",
      collectionThread: "Collection file",
      collectionNew: "New collection",
      collection: "Collection",
      profile: "Profile",
      identity: "Your business's digital presence",
    },
  },
  common: {
    loading: "Loading…",
    save: "Save",
    saving: "Saving…",
    saved: "Saved",
    cancel: "Cancel",
    close: "Close",
    back: "Back",
    retry: "Try again",
    errorGeneric: "Something went wrong. Please try again.",
    emptyValue: "—",
  },
  nav: {
    groups: {
      money: "Money",
      customers: "Customers & sales",
      business: "Business management",
    },
    home: "Home",
    chats: "Chats",
    docs: "Documents",
    notifications: "Notifications",
    payments: "Collection",
    billing: "Invoices",
    customers: "Customers",
    leads: "Leads",
    tasks: "Tasks",
    calendar: "Calendar",
    secretary: "My secretary",
    payables: "Commitments",
    inventory: "Inventory",
    settings: "Settings",
    a11y: {
      mainNav: "Main navigation",
      bottomNav: "Bottom navigation",
      homeLink: "Dubiz — Home",
      newAction: "New action",
      search: "Search",
      accessibility: "Accessibility",
      unreadNotifications: "You have unread notifications",
      needsAttention: "Something needs your attention",
      pendingCount: "{count} pending",
      businessProfile: "Business profile — {name}",
    },
  },
  currency: {
    ILS: "Israeli new shekel",
    USD: "US dollar",
    EUR: "Euro",
    approximatePrefix: "≈",
    convertedNote: "Converted for display only, at the {rateDate} rate",
    mixedCurrencies: "Includes amounts in several currencies",
    otherCurrenciesExcluded: "Does not include amounts in other currencies: {amounts}",
    rateMissing: "No verified exchange rate available for conversion",
  },
  settingsLocale: {
    categoryTitle: "Language, region & currency",
    categoryDescription: "Interface language, time zone, base and display currency",
    title: "Language, region & currency",
    languageSection: "Interface language",
    languageHelp:
      "Changes the interface language and layout direction. It never changes data, amounts or issued documents.",
    regionSection: "Region & time zone",
    regionLabel: "Region",
    regionValueIL: "Israel",
    timeZoneLabel: "Time zone",
    regionHelp: "The time zone does not change when you switch language.",
    baseCurrencySection: "Base currency",
    baseCurrencyHelp:
      "The currency your business reports in internally. Original amounts are always kept in the currency they were recorded in.",
    baseCurrencyLocked:
      "Changing the base currency of a business with financial activity requires a separate, controlled process and is not available yet.",
    displayCurrencySection: "Display currency",
    displayCurrencyHelp:
      "The currency used to show totals and conversions. Choosing it changes no data — converted amounts are marked.",
    displayFollowsBase: "Same as base currency",
    comingSoon: "Coming soon",
    languageSaved: "Language updated",
  },
  home: homeEn,
  inbox: inboxEn,
  documents: documentsEn,
  billing: billingEn,
  money: moneyEn,
  customers: customersEn,
  tasks: tasksEn,
  account: accountEn,
  content: contentEn,
  api: apiEn,
  insights: insightsEn,
  system: systemEn,
};
