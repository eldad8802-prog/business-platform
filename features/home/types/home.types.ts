export type HeroAction = {
  actionKey: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  reason?: string;
};

export type QuickAction = {
  key: string;
  title: string;
  icon: string;
  href: string;
  status?: "active" | "soon";
};

export type BusinessSnapshot = {
  businessName: string;
  greeting?: string;
  /**
   * The signed-in owner's display name (User.name). Powers the personal home
   * greeting ("בוקר טוב, {ownerName}"). Optional: users may have no name set,
   * in which case the home falls back to the business name.
   */
  ownerName?: string;
};

/**
 * The one Leads signal Home carries: how many open leads are asking for the
 * owner right now, and where to see exactly those. Deliberately a count and a
 * link — Home stays a starting point, not a CRM dashboard.
 */
export type LeadsAttention = {
  count: number;
  href: string;
};

export type HomeResponse = {
  heroAction: HeroAction;
  quickActions: QuickAction[];
  businessSnapshot: BusinessSnapshot;
  leadsAttention: LeadsAttention;
};