import { redirect } from "next/navigation";
import {
  ACTIVE_BOT_SETTINGS_AREAS,
  type BotSettingsArea,
} from "../_components/bot-settings-areas";
import { BotSettingsEditor } from "../_components/bot-settings-editor";

type PageProps = {
  params: Promise<{ area: string }>;
};

export default async function BusinessBotSettingsAreaPage({ params }: PageProps) {
  const { area } = await params;
  if (!ACTIVE_BOT_SETTINGS_AREAS.includes(area as BotSettingsArea)) {
    redirect("/business/bot");
  }
  return <BotSettingsEditor area={area as BotSettingsArea} />;
}
