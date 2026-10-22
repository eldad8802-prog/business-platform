"use client";

import { useI18n } from "@/components/i18n/I18nProvider";

type Props = {
  content: any;
  media: string[];

  onConfirm: () => void;
  onClose: () => void;
};

export default function PrePublishModal({
  content,
  media,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useI18n();
  return (
    <div style={{ padding: 20, background: "var(--dz-surface)" }}>
      <h2>{t("content.studioFlow.prePublish.title")}</h2>

      <p>{content?.hook}</p>

      <button onClick={onConfirm}>{t("content.studioFlow.prePublish.publish")}</button>
      <button onClick={onClose}>{t("content.studioFlow.prePublish.back")}</button>
    </div>
  );
}
