"use client";

type Props = {
  content: any;
  media: string[];

  goal?: string;
  valueType?: string;
  category?: string;

  customerType?: string;
  serviceLevel?: string;
  tone?: string;

  onConfirm: () => void;
  onClose: () => void;
};

export default function PrePublishModal({
  content,
  media,
  goal,
  valueType,
  category,
  customerType,
  serviceLevel,
  tone,
  onConfirm,
  onClose,
}: Props) {
  async function handleFeedback(success: boolean) {
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          success,
          content,
          goal,
          valueType,
          category,
          customerType,
          serviceLevel,
          tone,
        }),
      });

      alert("נשמר!");
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div style={{ padding: 20, background: "#fff" }}>
      <h2>לפני פרסום</h2>

      <p>{content?.hook}</p>

      <button onClick={onConfirm}>פרסם</button>
      <button onClick={onClose}>חזור</button>

      <hr />

      <button onClick={() => handleFeedback(true)}>
        👍 הביא פניות
      </button>

      <button onClick={() => handleFeedback(false)}>
        👎 לא עבד
      </button>
    </div>
  );
}