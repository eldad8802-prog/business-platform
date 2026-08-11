"use client";

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
  return (
    <div style={{ padding: 20, background: "#fff" }}>
      <h2>לפני פרסום</h2>

      <p>{content?.hook}</p>

      <button onClick={onConfirm}>פרסם</button>
      <button onClick={onClose}>חזור</button>
    </div>
  );
}
