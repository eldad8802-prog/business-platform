type PlanData = {
  script?: string;
  packaging?: {
    hookText?: string;
    captionLines?: string[];
    thumbnailText?: string;
    hashtags?: string[];
  };
};

type GenerateFinalInput = {
  selectedFormat: "reel" | "video" | "image" | "post";
  plan: PlanData;
};

export async function generateFinalContent(input: GenerateFinalInput) {
  const { selectedFormat, plan } = input;

  const packaging = plan.packaging || {};
  const hook = packaging.hookText || "";
  const captionLines = packaging.captionLines || [];
  const hashtags = packaging.hashtags || [];

  if (selectedFormat === "reel" || selectedFormat === "video") {
    return {
      format: "video",
      provider: "mock",
      videoUrl:
        "https://samplelib.com/lib/preview/mp4/sample-5s.mp4",
    };
  }

  if (selectedFormat === "image") {
    return {
      format: "image",
      provider: "mock",
      imageUrl:
        "https://images.unsplash.com/photo-1522202176988-66273c2fd55f",
      headline: hook,
      captionLines,
      hashtags,
    };
  }

  if (selectedFormat === "post") {
    const bodyLines = captionLines.slice(0, 3);

    const postText = [
      hook,
      "",
      ...bodyLines,
      "",
      "שלחו הודעה עכשיו לקבלת פרטים נוספים",
      "",
      hashtags.map((h) => `#${h}`).join(" "),
    ]
      .filter(Boolean)
      .join("\n");

    return {
      format: "post",
      provider: "internal",
      postText,
      cta: "שלחו הודעה עכשיו",
      hashtags,
    };
  }

  throw new Error("Unsupported format");
}