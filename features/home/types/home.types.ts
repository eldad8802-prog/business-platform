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
};

export type HomeResponse = {
  heroAction: HeroAction;
  quickActions: QuickAction[];
  businessSnapshot: BusinessSnapshot;
};