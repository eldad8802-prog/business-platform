import { he } from "@/lib/i18n/messages/he";
import { createTranslator, type Translator } from "@/lib/i18n/translate";
import { QuickAction } from "../types/home.types";

const HE_T: Translator = createTranslator(he);

export function getHomeQuickActions(t: Translator = HE_T): QuickAction[] {
  return [
    {
      key: "conversations",
      title: t("insights.home.quick.conversations"),
      icon: "chat",
      href: "/inbox",
      status: "active",
    },
    {
      key: "attention",
      title: t("insights.home.quick.attention"),
      icon: "spark",
      href: "/attention",
      status: "active",
    },
    {
      key: "content",
      title: t("insights.home.quick.content"),
      icon: "video",
      href: "/content",
      status: "active",
    },
    {
      key: "pricing",
      title: t("insights.home.quick.pricing"),
      icon: "percent",
      href: "/pricing",
      status: "active",
    },
    {
      key: "documents",
      title: t("insights.home.quick.documents"),
      icon: "file",
      href: "/documents",
      status: "active",
    },
    {
      key: "secretary",
      title: t("insights.home.quick.secretary"),
      icon: "secretary",
      href: "/secretary",
      status: "active",
    },
  ];
}
