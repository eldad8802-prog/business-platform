"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import ProgressBar from "@/components/ProgressBar";
import { baseStyles } from "@/lib/styles/baseStyles";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n/translate";

type ContentFlowData = {
  goal: string;
  goalDescription: string;
  intent: string;
  mode: string;
  audienceDescription: string;
  ageRange: string;
  selectedFormat: "reel" | "video" | "image" | "post";
};

type PlanResult = {
  videoType: {
    type: string;
    label: string;
    description: string;
  };
  decision: {
    strategy: string;
    angle: string;
    tone: string;
  };
  script: string;
  instructions: string[];
  packaging: {
    hookText: string;
    captionLines: string[];
    thumbnailText: string;
    musicType: string;
    hashtags: string[];
  };
  assetsPlan: {
    requiredAssets: string[];
    optionalAssets: string[];
    guidance: string;
  };
};

export default function Page() {
  const router = useRouter();
  const { t } = useI18n();

  const [flowData, setFlowData] = useState<ContentFlowData | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(true);
  // Holds an error code; the message is resolved at render.
  const [error, setError] = useState("");

  useEffect(() => {
    const raw = localStorage.getItem("content_flow");

    if (!raw) {
      router.replace("/content");
      return;
    }

    try {
      const parsed = JSON.parse(raw) as ContentFlowData;

      if (
        !parsed.goal ||
        !parsed.goalDescription ||
        !parsed.intent ||
        !parsed.mode ||
        !parsed.audienceDescription ||
        !parsed.ageRange ||
        !parsed.selectedFormat
      ) {
        router.replace("/content");
        return;
      }

      setFlowData(parsed);
    } catch {
      router.replace("/content");
    }
  }, [router]);

  useEffect(() => {
    if (!flowData) return;

    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        setError("");

        const token =
          typeof window !== "undefined"
            ? localStorage.getItem("token") || ""
            : "";

        const res = await fetch("/api/video/plan", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(flowData),
        });

        const json = await res.json();

        if (!res.ok) {
          if (json?.error === "brief_required") {
            if (!cancelled) router.replace("/content/setup");
            return;
          }
          throw new Error(json?.error || "Failed to build plan");
        }

        if (!cancelled) {
          setPlan(json);

          localStorage.setItem(
            "content_flow",
            JSON.stringify({
              ...flowData,
              ...json,
            })
          );
        }
      } catch {
        if (!cancelled) {
          setError("build_failed");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [flowData]);

  function handleContinue() {
    router.push("/content/assets");
  }

  if (loading) {
    return (
      <div style={baseStyles.page}>
        <Header title={t("content.studioFlow.create.headerBuilding")} />
        <ProgressBar progress={95} />

        <div style={loadingWrap}>
          <h1>{t("content.studioFlow.create.loadingTitle")}</h1>
          <p style={{ color: "var(--dz-text-secondary)" }}>
            {t("content.studioFlow.create.loadingText")}
          </p>
        </div>
      </div>
    );
  }

  if (error || !plan || !flowData) {
    return (
      <div style={baseStyles.page}>
        <Header title={t("content.studioFlow.create.headerBuilding")} />
        <ProgressBar progress={95} />

        <div style={baseStyles.container}>
          <div style={errorCard}>{error ? t("content.studioFlow.create.buildFailed") : t("content.studioFlow.create.loadFailed")}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={baseStyles.page}>
      <Header title={t("content.studioFlow.create.headerReady")} />
      <ProgressBar progress={95} />

      <div style={baseStyles.container}>
        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.format")}</h2>
          <div style={value}>{mapFormat(t, flowData.selectedFormat)}</div>
        </div>

        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.videoType")}</h2>
          <div style={value}>{plan.videoType?.label}</div>
        </div>

        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.script")}</h2>
          <pre style={script}>{plan.script}</pre>
        </div>

        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.instructions")}</h2>
          {plan.instructions.map((item, idx) => (
            <div key={idx} style={instruction}>
              • {item}
            </div>
          ))}
        </div>

        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.packaging")}</h2>

          <div style={section}>
            <div style={label}>{t("content.studioFlow.create.hook")}</div>
            <div style={value}>{plan.packaging.hookText}</div>
          </div>

          <div style={section}>
            <div style={label}>{t("content.studioFlow.create.captions")}</div>
            {plan.packaging.captionLines.map((line, idx) => (
              <div key={idx} style={caption}>
                {line}
              </div>
            ))}
          </div>

          <div style={section}>
            <div style={label}>{t("content.studioFlow.create.thumbnail")}</div>
            <div style={value}>{plan.packaging.thumbnailText}</div>
          </div>

          <div style={section}>
            <div style={label}>{t("content.studioFlow.create.music")}</div>
            <div style={value}>{plan.packaging.musicType}</div>
          </div>
        </div>

        <div style={card}>
          <h2 style={h2}>{t("content.studioFlow.create.assets")}</h2>

          {plan.assetsPlan.requiredAssets.map((item, idx) => (
            <div key={idx} style={instruction}>
              • {item}
            </div>
          ))}

          {plan.assetsPlan.optionalAssets.length > 0 && (
            <>
              <div style={subLabel}>{t("content.studioFlow.create.optional")}</div>
              {plan.assetsPlan.optionalAssets.map((item, idx) => (
                <div key={idx} style={instruction}>
                  • {item}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div style={baseStyles.footer}>
        <button style={baseStyles.cta} onClick={handleContinue}>
          {t("content.studioFlow.create.cta")}
        </button>
      </div>
    </div>
  );
}

function mapFormat(t: Translator, value: string) {
  if (value === "reel") return t("content.studioFlow.options.format.reel");
  if (value === "video") return t("content.studioFlow.options.format.video");
  if (value === "image") return t("content.studioFlow.options.format.image");
  return t("content.studioFlow.options.format.post");
}

const loadingWrap = {
  minHeight: "70vh",
  display: "flex",
  flexDirection: "column" as const,
  justifyContent: "center",
  alignItems: "center",
  textAlign: "center" as const,
};

const card = {
  background: "var(--dz-surface)",
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  border: "1px solid var(--dz-border-subtle)",
};

const h2 = {
  marginBottom: 8,
};

const value = {
  fontSize: 16,
  fontWeight: 600,
};

const script = {
  whiteSpace: "pre-wrap" as const,
};

const instruction = {
  marginBottom: 6,
};

const section = {
  marginTop: 12,
};

const label = {
  fontWeight: 600,
  marginBottom: 4,
};

const caption = {
  background: "var(--dz-surface-muted)",
  padding: 8,
  borderRadius: 8,
  marginBottom: 4,
};

const subLabel = {
  marginTop: 10,
  fontWeight: 600,
};

const errorCard = {
  background: "var(--dz-danger-bg)",
  padding: 16,
  borderRadius: 12,
  color: "var(--dz-danger)",
};