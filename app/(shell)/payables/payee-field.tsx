"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  createPayee,
  searchPayees,
  type PayeeApi,
} from "@/lib/payables/payables-client";
import styles from "./payables.module.css";

/**
 * Choose a payee — or simply name one.
 *
 * Free text is a first-class answer, not a fallback. The ledger stores a Tier-1
 * `payeeNameSnapshot` on every commitment, so a business can record what it owes
 * the municipality without first being made to create a "Payee" record. Turning
 * that name into an entity is an owner-driven act, offered here and never
 * performed silently.
 *
 * Accessibility: a real `combobox` — `aria-expanded`, `aria-controls`,
 * `aria-activedescendant`, arrow/enter/escape keys, and options that are
 * `role="option"` with `aria-selected`. The list is not a div soup that only
 * works with a mouse.
 */
export function PayeeField({
  payeeId,
  payeeName,
  onChange,
  disabled,
}: {
  payeeId: number | null;
  payeeName: string;
  onChange: (next: { payeeId: number | null; payeeName: string }) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PayeeApi[]>([]);
  const [active, setActive] = useState(-1);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const inputId = useId();

  // Debounced, and every in-flight response is discarded if a newer keystroke
  // has already been typed — otherwise a slow early request can land last and
  // repopulate the list with results for text the owner has moved past.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      searchPayees(payeeName)
        .then((rows) => {
          if (!cancelled) setOptions(rows);
        })
        .catch(() => {
          if (!cancelled) setOptions([]);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [payeeName, open]);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  const exactMatch = options.some(
    (o) => o.displayName.trim() === payeeName.trim(),
  );
  const canQuickCreate = payeeName.trim().length > 1 && !exactMatch;

  async function quickCreate() {
    setCreating(true);
    setError(null);
    try {
      const payee = await createPayee({ displayName: payeeName.trim() });
      onChange({ payeeId: payee.id, payeeName: payee.displayName });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "יצירת המוטב נכשלה");
    } finally {
      setCreating(false);
    }
  }

  function choose(option: PayeeApi) {
    onChange({ payeeId: option.id, payeeName: option.displayName });
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, options.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" && open && active >= 0 && options[active]) {
      e.preventDefault();
      choose(options[active]);
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className={styles.field} ref={boxRef}>
      <label className={styles.label} htmlFor={inputId}>
        מוטב
      </label>
      <input
        id={inputId}
        className={styles.input}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && active >= 0 && options[active]
            ? `${listId}-opt-${options[active].id}`
            : undefined
        }
        value={payeeName}
        disabled={disabled}
        placeholder="שם המוטב — אפשר גם טקסט חופשי"
        onChange={(e) => {
          // Typing detaches the entity link: the name no longer describes the
          // payee that was chosen, and silently keeping the id would attach the
          // commitment to something the owner is no longer naming.
          onChange({ payeeId: null, payeeName: e.target.value });
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open && (options.length > 0 || canQuickCreate) && (
        <ul className={styles.preview} id={listId} role="listbox">
          {options.map((option, i) => (
            <li
              key={option.id}
              id={`${listId}-opt-${option.id}`}
              role="option"
              aria-selected={i === active}
              className={styles.previewRow}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(option);
              }}
              style={{ cursor: "pointer" }}
            >
              <span style={{ unicodeBidi: "isolate" }}>{option.displayName}</span>
            </li>
          ))}
          {canQuickCreate && (
            <li role="presentation" className={styles.previewRow}>
              <button
                type="button"
                className={styles.buttonQuiet}
                onClick={quickCreate}
                disabled={creating}
              >
                {creating ? "יוצר…" : `צור מוטב חדש: ${payeeName.trim()}`}
              </button>
            </li>
          )}
        </ul>
      )}

      {payeeId == null && payeeName.trim() !== "" && (
        <p className={styles.subtitle}>
          יישמר כשם בלבד. אפשר להפוך אותו למוטב שמור בכל שלב.
        </p>
      )}
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
