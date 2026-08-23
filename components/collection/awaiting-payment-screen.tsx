"use client";

/**
 * Collection · the screen.
 *
 * Answers one question the owner asks and the system could not previously
 * answer: **מי חייב לי כסף.** Everything on the page serves that sentence, and
 * anything that does not is not here.
 *
 * The empty state is the real success state, not an accident — "אף אחד לא חייב
 * לך כסף" is the best thing this screen can say, so it says it plainly and
 * without an illustration begging for a click.
 *
 * Row states live in `useState` and nowhere else — no table, no localStorage.
 * They help the owner work through today's list and are gone tomorrow. That is
 * the MVP boundary on purpose: whether these states deserve real memory is a
 * question to answer from observed use, not from a guess made before launch.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { TOKEN } from "@/lib/design/tokens";
import { getAuthToken } from "@/components/payments/collection-format";
import { currencySymbol } from "@/lib/services/billing/collection/collection-display";
import type { AwaitingPaymentListApi } from "@/lib/services/billing/collection/awaiting-payment.serializer";

import { AwaitingPaymentRow, type RowState } from "./awaiting-payment-row";
import { CollectionMessageSheet } from "./collection-message-sheet";

const W = TOKEN.warm;

type Api = AwaitingPaymentListApi & { businessName: string };

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: Api };

export function AwaitingPaymentScreen() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [rowStates, setRowStates] = useState<Record<number, RowState>>({});
  const [openCustomerId, setOpenCustomerId] = useState<number | null>(null);

  const load = useCallback(async (): Promise<LoadState> => {
    try {
      const res = await fetch("/api/billing/collection/awaiting", {
        headers: { Authorization: `Bearer ${getAuthToken() ?? ""}` },
        cache: "no-store",
      });
      if (!res.ok) return { status: "error" };
      return { status: "ready", data: (await res.json()) as Api };
    } catch {
      return { status: "error" };
    }
  }, []);

  useEffect(() => {
    if (!getAuthToken()) router.replace("/login");
  }, [router]);

  useEffect(() => {
    if (!getAuthToken()) return;
    let alive = true;
    load().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const setRowState = (customerId: number, next: RowState) =>
    setRowStates((current) => ({ ...current, [customerId]: next }));

  if (state.status === "loading") {
    return <Frame>{null}</Frame>;
  }

  if (state.status === "error") {
    return (
      <Frame>
        <p style={{ fontSize: 15, color: W.muted }}>
          לא הצלחנו לטעון את הרשימה. נסו לרענן.
        </p>
      </Frame>
    );
  }

  const { data } = state;
  const openCustomer =
    openCustomerId === null
      ? null
      : data.customers.find((c) => c.customerId === openCustomerId) ?? null;

  if (data.customerCount === 0) {
    return (
      <Frame>
        <p style={{ fontSize: 17, color: W.ink, lineHeight: 1.6 }}>
          אף אחד לא חייב לך כסף כרגע.
        </p>
        {data.unassignedCount > 0 && <Unassigned count={data.unassignedCount} />}
      </Frame>
    );
  }

  const symbol = currencySymbol(data.customers[0].currency);

  return (
    <Frame>
      {/* The one number the owner came for, before any list. */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: 32,
            fontWeight: 600,
            color: W.ink,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {data.totalOutstandingFormatted} {symbol}
        </div>
        <div style={{ fontSize: 14, color: W.muted, marginTop: 4 }}>
          {data.customerCount === 1
            ? "לקוח אחד ממתין לתשלום"
            : `${data.customerCount} לקוחות ממתינים לתשלום`}
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {data.customers.map((customer) => (
          <AwaitingPaymentRow
            key={customer.customerId}
            customer={customer}
            state={rowStates[customer.customerId] ?? "idle"}
            onWriteMessage={() => setOpenCustomerId(customer.customerId)}
            onMarkAlreadyPaid={() =>
              setRowState(customer.customerId, "already-paid")
            }
            onNotNow={() => setRowState(customer.customerId, "not-now")}
          />
        ))}
      </div>

      {data.unassignedCount > 0 && <Unassigned count={data.unassignedCount} />}

      {openCustomer && (
        <CollectionMessageSheet
          customer={openCustomer}
          businessName={data.businessName}
          onOpenedWhatsApp={() => {
            setRowState(openCustomer.customerId, "opened-whatsapp");
            setOpenCustomerId(null);
          }}
          // Copying does not close the sheet — the owner may still want to open
          // WhatsApp, or read the text once more before he sends it.
          onCopied={() => setRowState(openCustomer.customerId, "copied")}
          onClose={() => setOpenCustomerId(null)}
        />
      )}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      dir="rtl"
      style={{
        background: W.canvas,
        // 100% only fills the height the shell happens to give it, which on a
        // short list leaves a bare strip below the canvas.
        minHeight: "100vh",
        padding: "24px 16px 48px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: W.ink,
            margin: "0 0 20px",
          }}
        >
          מי חייב לי כסף
        </h1>
        {children}
      </div>
    </div>
  );
}

/**
 * Debt with no customer attached cannot be collected, so it is counted rather
 * than listed — and counted rather than hidden. A list that quietly drops
 * invoices understates what the business is owed.
 */
function Unassigned({ count }: { count: number }) {
  return (
    <p style={{ marginTop: 20, fontSize: 13, color: W.muted, lineHeight: 1.6 }}>
      {count === 1
        ? "חשבונית אחת פתוחה אינה משויכת ללקוח, ולכן אינה ברשימה."
        : `${count} חשבוניות פתוחות אינן משויכות ללקוח, ולכן אינן ברשימה.`}
    </p>
  );
}
