import { buildClientAuthHeaders } from "@/lib/client-session";

export type CustomerListRow = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
};

export type CreateCustomerInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  notes?: string | null;
};

export type CustomerCardCustomer = {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  legalName: string | null;
  taxId: string | null;
  taxIdType: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CustomerCardBillingDocument = {
  id: number;
  documentType: string;
  status: string;
  documentNumberFormatted: string | null;
  totalAmount: string;
  currency: string;
  issuedAt: string | null;
  createdAt: string;
};

export type CustomerCardPaymentRequest = {
  id: number;
  provider: string;
  status: string;
  amount: string;
  currency: string;
  paymentUrl: string | null;
  billingDocumentId: number | null;
  createdAt: string;
  paidAt: string | null;
};

export type CustomerCardConversation = {
  id: number;
  channel: string;
  status: string;
  startedAt: string;
  lastMessageAt: string | null;
  closedAt: string | null;
};

export type CustomerCardAppointment = {
  id: number;
  status: string;
  title: string | null;
  startsAt: string | null;
  createdAt: string;
};

/** Basic CRM fields editable from the customer card (C1). Tax identity excluded. */
export type UpdateCustomerInput = {
  name?: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  notes?: string | null;
};

export type CustomerCardSection<T> = { items: T[]; total: number };

export type CustomerCard = {
  customer: CustomerCardCustomer;
  billingDocuments: CustomerCardSection<CustomerCardBillingDocument>;
  paymentRequests: CustomerCardSection<CustomerCardPaymentRequest>;
  conversations: CustomerCardSection<CustomerCardConversation>;
  appointments: CustomerCardSection<CustomerCardAppointment>;
  activity: { lastActivityAt: string | null; hasAnyActivity: boolean };
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("הבקשה ארכה זמן רב מדי. בדקו את החיבור ונסו שוב.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getCustomers(query?: string): Promise<CustomerListRow[]> {
  const qs = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
  const res = await fetchWithTimeout(`/api/customers${qs}`, {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error("Failed to fetch customers");

  const data = await res.json();
  return data.customers || [];
}

export async function getCustomerCard(id: number): Promise<CustomerCard> {
  const res = await fetchWithTimeout(`/api/customers/${id}`, {
    method: "GET",
    headers: buildClientAuthHeaders(),
    cache: "no-store",
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error("Failed to fetch customer");

  return (await res.json()) as CustomerCard;
}

export async function updateCustomer(
  id: number,
  input: UpdateCustomerInput
): Promise<CustomerCardCustomer> {
  const res = await fetchWithTimeout(`/api/customers/${id}`, {
    method: "PATCH",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify(input),
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) {
    let message = "לא הצלחנו לשמור את הלקוח";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const data = await res.json();
  return data.customer as CustomerCardCustomer;
}

export async function createCustomer(
  input: CreateCustomerInput
): Promise<CustomerListRow> {
  const res = await fetchWithTimeout("/api/customers", {
    method: "POST",
    headers: buildClientAuthHeaders(),
    body: JSON.stringify(input),
  });

  if (res.status === 401) throw new Error("UNAUTHORIZED");
  if (!res.ok) {
    let message = "Failed to create customer";
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const data = await res.json();
  return data.customer as CustomerListRow;
}
