export type ContextMemory = {
  customerType: string;
  serviceLevel: string;
  tone: string;
};

const STORAGE_KEY = "business_context_memory";

export function saveContext(context: ContextMemory) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(context));
  } catch (e) {
    console.error("Failed to save context", e);
  }
}

export function getContext(): ContextMemory | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}