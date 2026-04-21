type Context = {
  customerType: string;
  serviceLevel: string;
  tone: string;
};

type Params = {
  goal?: string;
  valueType?: string;
  category?: string;
};

export function resolveAutoContext(params: Params): Context {
  const { goal, valueType } = params;

  // 🎯 לידים + הצעה
  if (goal === "leads" && valueType === "offer") {
    return {
      customerType: "לחוץ",
      serviceLevel: "מקצועי",
      tone: "ישיר",
    };
  }

  // 🎯 אמון
  if (goal === "trust") {
    return {
      customerType: "מחפש איכות",
      serviceLevel: "פרימיום",
      tone: "רגשי",
    };
  }

  // 🎯 ברירת מחדל
  return {
    customerType: "משווה מחירים",
    serviceLevel: "בסיסי",
    tone: "ישיר",
  };
}