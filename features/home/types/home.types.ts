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

export type HomeResponse = {
  heroAction: HeroAction;
  quickActions: QuickAction[];
  businessSnapshot: BusinessSnapshot;
};