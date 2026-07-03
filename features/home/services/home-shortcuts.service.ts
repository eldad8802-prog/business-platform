import { QuickAction } from "../types/home.types";

export function getHomeQuickActions(): QuickAction[] {
  return [
    {
      key: "conversations",
      title: "שיחות עם לקוחות",
      icon: "chat",
      href: "/inbox",
      status: "active",
    },
    {
      key: "attention",
      title: "דורש תשומת לב",
      icon: "spark",
      href: "/attention",
      status: "active",
    },
    {
      key: "content",
      title: "יצירת תוכן",
      icon: "video",
      href: "/content",
      status: "active",
    },
    {
      key: "pricing",
      title: "תמחור",
      icon: "percent",
      href: "/pricing",
      status: "active",
    },
    {
      key: "documents",
      title: "מסמכים",
      icon: "file",
      href: "/documents",
      status: "active",
    },
    {
      key: "secretary",
      title: "המזכירה שלך",
      icon: "secretary",
      href: "/secretary",
      status: "active",
    },
  ];
}
