type VariantId = "desire" | "trust" | "result";

export type AIConcept = {
  id: string;
  label: string;
  idea: string;
  visual: string;
  hook: string;
};

type Input = {
  concepts: AIConcept[];
  businessName: string;
  effectiveServiceLabel: string;
  audienceDescription: string;
};

type ContentStructure = {
  hook: string;
  problem: string;
  value: string;
  proof: string;
  cta: string;
};

export type ContentVariant = {
  id: VariantId;
  label: string;
  contentStructure: ContentStructure;
};

// -------------------------
// CTA BUILDER
// -------------------------

function buildCTA(id: VariantId) {
  if (id === "desire") return "תמשיכו לראות";
  if (id === "trust") return "עקבו לעוד";
  return "שלחו הודעה עכשיו";
}

// -------------------------
// SAFE ID MAPPER
// -------------------------

function mapToVariantId(id: string): VariantId {
  if (id === "desire") return "desire";
  if (id === "trust") return "trust";
  if (id === "result") return "result";

  // fallback בטוח
  return "desire";
}

// -------------------------
// MAIN
// -------------------------

export function buildContentVariants(
  input: Input
): ContentVariant[] {
  return input.concepts.map((c): ContentVariant => {
    const safeId = mapToVariantId(c.id);

    return {
      id: safeId,
      label: c.label,

      contentStructure: {
        hook: c.hook,

        problem:
          input.audienceDescription ||
          `אנשים שמחפשים ${input.effectiveServiceLabel} לא תמיד מקבלים תוצאה טובה`,

        value: c.idea,

        proof:
          safeId === "trust"
            ? `${input.businessName} עם ניסיון אמיתי בתחום`
            : "זה מבוסס על מה שעובד בפועל",

        cta: buildCTA(safeId),
      },
    };
  });
}