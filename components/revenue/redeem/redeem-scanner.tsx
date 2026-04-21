"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  onDetected: (token: string) => void;
  isActive: boolean;
};

export default function RedeemScanner({ onDetected, isActive }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState("מאתחל מצלמה...");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      if (!isActive) return;

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setErrorMessage("הדפדפן לא תומך בפתיחת מצלמה");
          setStatus("");
          return;
        }

        setStatus("מבקש הרשאת מצלמה...");

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setStatus("המצלמה נפתחה בהצלחה");
        setErrorMessage("");
      } catch (error: any) {
        console.error("getUserMedia error:", error);

        const message =
          error?.name === "NotAllowedError"
            ? "הגישה למצלמה נחסמה. אשר הרשאה למצלמה בדפדפן."
            : error?.name === "NotFoundError"
            ? "לא נמצאה מצלמה זמינה במכשיר."
            : error?.name === "NotReadableError"
            ? "המצלמה תפוסה על ידי אפליקציה אחרת או לא זמינה."
            : error?.name === "SecurityError"
            ? "המצלמה זמינה רק ב־localhost או ב־HTTPS."
            : "לא ניתן לפתוח את המצלמה.";

        setErrorMessage(message);
        setStatus("");
      }
    };

    startCamera();

    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [isActive]);

  if (!isActive) return null;

  return (
    <div
      style={{
        width: "100%",
        borderRadius: 20,
        overflow: "hidden",
        border: "1px solid #e5e7eb",
        marginBottom: 12,
        background: "#ffffff",
      }}
    >
      <div
        style={{
          minHeight: 320,
          background: "#000000",
          position: "relative",
        }}
      >
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          style={{
            width: "100%",
            height: 320,
            objectFit: "cover",
            display: "block",
          }}
        />
      </div>

      <div
        style={{
          padding: 12,
          textAlign: "right",
          fontSize: 14,
          lineHeight: 1.5,
          color: errorMessage ? "#b91c1c" : "#374151",
          background: errorMessage ? "#fef2f2" : "#ffffff",
          borderTop: "1px solid #e5e7eb",
        }}
      >
        {errorMessage || status}
      </div>
    </div>
  );
}