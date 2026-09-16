"use client";

/**
 * The supplier field for an inventory item — one component shared by Create and
 * Edit.
 *
 * WHAT IT REPLACES. Both screens used a bare `<input>`; Create backed it with a
 * `<datalist>` built from the DISTINCT `supplierName` strings already written on
 * other inventory items. So the picker could only ever offer suppliers that were
 * already typed somewhere, and a supplier that existed in the Suppliers CRM but
 * had never been used on an item was invisible. This searches the canonical
 * Supplier entities instead, and lets the owner create one without leaving the
 * item form.
 *
 * WHAT IT DOES NOT CHANGE — the persisted value. `InventoryItem.supplierName`
 * stays a Tier-1 snapshot string (docs/dubiz-party-identity-strategy-v1.md §1),
 * and this field still writes a NAME. Choosing a canonical supplier copies its
 * name; it does not create a relation, because §6.5 forbids adding an Entity-FK
 * before an entity-centric read path exists and a picker is representation, not
 * aggregation. A later supplier rename therefore does NOT propagate to items —
 * that is the ratified trade-off, deliberately not simulated here.
 *
 * Free typing stays legal. A name with no matching entity is a valid supplier
 * value, exactly as before; the entity is an option, never a requirement.
 *
 * The ordering follows the purchase-order wizard's established pattern: real
 * entities first, then any orphan snapshot name that has no entity behind it, so
 * values already on existing items never become unreachable.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "@/app/(shell)/customers/crm.css";
import { CRM_THEME_CSS } from "@/lib/design/crm-theme";
import { SupplierForm } from "@/components/suppliers/SupplierForm";
import { SupplierDuplicateBody } from "@/components/suppliers/SupplierDuplicateNotice";
import {
  EMPTY_SUPPLIER_FORM,
  supplierFormToPayload,
  validateSupplierForm,
  type SupplierFormState,
} from "@/components/suppliers/supplier-form-model";
import {
  createSupplier,
  getSuppliers,
  type PossibleSupplierMatch,
  type SupplierListRow,
} from "@/lib/api/suppliers";
import { normalizeInventoryText } from "@/lib/inventory/normalize";
import {
  buildSupplierChoices,
  type SupplierChoice,
} from "@/components/inventory/supplier-choices";
import { isUnauthorizedError, redirectToLogin } from "@/lib/client-session";

/** Long enough that typing a name is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

export function SupplierField({
  value,
  onChange,
  orphanNames = [],
  idPrefix,
  placeholder = "חפשו ספק קיים או הקלידו שם חדש",
  disabled = false,
}: {
  /** The Tier-1 snapshot the item will persist. */
  value: string;
  onChange: (name: string) => void;
  /** `supplierName` values already on inventory items (secondary choices). */
  orphanNames?: string[];
  /** Prefix for the generated element ids (must be unique per rendered field). */
  idPrefix: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const listId = `${idPrefix}-${reactId}-list`;
  const inputId = `${idPrefix}-${reactId}-input`;

  const [open, setOpen] = useState(false);
  const [activeIndexRaw, setActiveIndex] = useState(-1);
  const [entities, setEntities] = useState<SupplierListRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [quickCreateName, setQuickCreateName] = useState<string | null>(null);
  /**
   * Opened, but the owner has not typed yet — so the field is BROWSING rather
   * than filtering.
   *
   * This is what makes the field usable on Edit. There the input arrives already
   * holding the item's stored supplier, so filtering by its own value would
   * search for the one name already in the box: the owner would see only what
   * they already had, and would have to clear the field before they could look
   * at any other supplier. Opening browses the full active list; the first
   * keystroke switches to filtering. On Create the value starts empty, so the
   * two modes look identical there — which is why this only showed up when the
   * QA run reached the Edit screen.
   */
  const [browsing, setBrowsing] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Set just before focus is moved back programmatically, so returning focus
   * does not look like the owner asking for the list again. It matters after the
   * quick-create dialog closes: focus genuinely left the input, so refocusing it
   * fires a real focus event, and without this the list would spring open on top
   * of the supplier that was just chosen.
   */
  const refocusingRef = useRef(false);

  const refocusInput = useCallback(() => {
    refocusingRef.current = true;
    inputRef.current?.focus();
    // Cleared on the next tick: by then the focus event has been handled.
    window.setTimeout(() => {
      refocusingRef.current = false;
    }, 0);
  }, []);

  // While browsing, the typed value is NOT a filter — and an empty query also
  // means no "create" action, which is right: the owner has not asked for
  // anything new merely by focusing a field that already had a value in it.
  const effectiveQuery = browsing ? "" : value;

  const choices = useMemo(
    () => buildSupplierChoices({ entities, orphanNames, query: effectiveQuery }),
    [entities, orphanNames, effectiveQuery],
  );

  /**
   * Canonical search, debounced. Runs whenever the field is open so the list
   * reflects what the owner has typed — including the empty query, which lists
   * the active suppliers and is exactly the case the old datalist could not do.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const rows = await getSuppliers({
          query: normalizeInventoryText(effectiveQuery),
          status: "active",
        });
        if (cancelled) return;
        setEntities(Array.isArray(rows) ? rows : []);
        setSearchFailed(false);
      } catch (err: unknown) {
        if (isUnauthorizedError(err)) {
          redirectToLogin();
          return;
        }
        if (cancelled) return;
        // A failed lookup must never block the field: the owner can still type a
        // name, which is the Tier-1 value the item actually stores.
        setEntities([]);
        setSearchFailed(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, effectiveQuery]);

  /**
   * The active option, clamped to the list as it stands NOW.
   *
   * Derived rather than corrected in an effect: the list changes under the
   * cursor every time the debounced search answers, and an effect that wrote the
   * index back would be a second render pass chasing the first — the exact
   * cascade `react-hooks/set-state-in-effect` exists to stop.
   */
  const activeIndex = activeIndexRaw >= choices.length ? choices.length - 1 : activeIndexRaw;

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setBrowsing(false);
  }, []);

  // Pointer-down outside closes. Deliberately not "blur": a click on an option
  // blurs the input before the option's click handler runs.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current) return;
      if (e.target instanceof Node && wrapRef.current.contains(e.target)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  const commit = useCallback(
    (name: string) => {
      onChange(normalizeInventoryText(name));
      close();
      refocusInput();
    },
    [onChange, close, refocusInput],
  );

  const choose = useCallback(
    (choice: SupplierChoice) => {
      if (choice.kind === "create") {
        // The list closes first: the quick-create dialog is the only thing that
        // should own focus while it is open.
        close();
        setQuickCreateName(choice.name);
        return;
      }
      commit(choice.name);
    },
    [close, commit],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setBrowsing(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex(choices.length === 0 ? -1 : Math.min(activeIndex + 1, choices.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return;
      setActiveIndex(Math.max(activeIndex - 1, 0));
      return;
    }
    if (e.key === "Home" && open) {
      e.preventDefault();
      setActiveIndex(choices.length ? 0 : -1);
      return;
    }
    if (e.key === "End" && open) {
      e.preventDefault();
      setActiveIndex(choices.length - 1);
      return;
    }
    if (e.key === "Enter") {
      // Always swallowed while the list is open so Enter cannot submit the item
      // form from inside the picker.
      if (open && activeIndex >= 0 && activeIndex < choices.length) {
        e.preventDefault();
        choose(choices[activeIndex]);
        return;
      }
      if (open) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        // Stop here: the surrounding page may also treat Escape as "go back",
        // and closing the list is the whole of what the owner asked for.
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    if (e.key === "Tab") {
      if (open) close();
    }
  };

  const activeId = activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined;

  return (
    <div className="inv-sup" ref={wrapRef}>
      <input
        id={inputId}
        ref={inputRef}
        className="inv-input"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-haspopup="listbox"
        autoComplete="off"
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          // The first keystroke turns browsing into filtering.
          setBrowsing(false);
          if (!open) setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => {
          if (refocusingRef.current) return;
          setOpen(true);
          setBrowsing(true);
        }}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <ul className="inv-sup__list" id={listId} role="listbox" aria-label="ספקים">
          {searching && choices.length === 0 ? (
            <li className="inv-sup__note" role="presentation">
              מחפש…
            </li>
          ) : null}

          {!searching && choices.length === 0 ? (
            <li className="inv-sup__note" role="presentation">
              התחילו להקליד שם ספק
            </li>
          ) : null}

          {choices.map((choice, i) => {
            const active = i === activeIndex;
            if (choice.kind === "create") {
              return (
                <li
                  key="__create"
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={active}
                  className={`inv-sup__opt inv-sup__opt--create${active ? " is-active" : ""}`}
                  // Keeps focus in the input so the combobox never loses it.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(choice)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className="inv-sup__plus" aria-hidden>
                    +
                  </span>
                  <span className="inv-sup__opt-main">
                    יצירת ספק חדש <bdi>&quot;{choice.name}&quot;</bdi>
                  </span>
                </li>
              );
            }
            return (
              <li
                key={choice.kind === "entity" ? `e${choice.id}` : `o${choice.name}`}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={active}
                className={`inv-sup__opt${active ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(choice)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="inv-sup__opt-main">
                  <bdi>{choice.name}</bdi>
                </span>
                {choice.kind === "orphan" ? (
                  // Named on items but never registered as a supplier. Said out
                  // loud so the owner can see which of their suppliers are real
                  // records and which are only text.
                  <span className="inv-sup__tag">לא רשום כספק</span>
                ) : null}
              </li>
            );
          })}

          {searchFailed ? (
            <li className="inv-sup__note inv-sup__note--warn" role="presentation">
              לא הצלחנו לטעון ספקים. אפשר להקליד שם ידנית.
            </li>
          ) : null}
        </ul>
      ) : null}

      {quickCreateName !== null ? (
        <SupplierQuickCreate
          initialName={quickCreateName}
          onCancel={() => {
            setQuickCreateName(null);
            refocusInput();
          }}
          onSelected={(name) => {
            setQuickCreateName(null);
            commit(name);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Quick-create, rendered as a dialog over the item form.
 *
 * It reuses the supplier stack whole: `SupplierForm` for the fields,
 * `validateSupplierForm` / `supplierFormToPayload` for the contract, and
 * `POST /api/inventory/suppliers` for the write — so a supplier born here is
 * indistinguishable from one created at /suppliers, and there is no second
 * schema, endpoint or validation to keep in step. It brings its own `.crm-scope`
 * + theme because those components read `var(--crm-*)` and inventory does not
 * define them.
 *
 * The item form is never touched: this is a sibling component with its own
 * state, so cancelling or failing here cannot reset a single item field.
 */
function SupplierQuickCreate({
  initialName,
  onCancel,
  onSelected,
}: {
  initialName: string;
  onCancel: () => void;
  /** The supplier NAME to put in the field — the Tier-1 value the item stores. */
  onSelected: (name: string) => void;
}) {
  const [form, setForm] = useState<SupplierFormState>(() => ({
    ...EMPTY_SUPPLIER_FORM,
    name: initialName,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the server has created the supplier AND flagged possible matches. */
  const [duplicates, setDuplicates] = useState<{
    matches: PossibleSupplierMatch[];
    created: { id: number; name: string };
  } | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);

  const set = useCallback<
    <K extends keyof SupplierFormState>(k: K, v: SupplierFormState[K]) => void
  >((key, val) => {
    setForm((prev) => ({ ...prev, [key]: val }));
  }, []);

  // Focus the first field on open; Escape closes. Tab is kept inside the dialog
  // so focus cannot wander into the item form behind it.
  useEffect(() => {
    const root = dialogRef.current;
    if (!root) return;
    const focusables = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);

    focusables()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!saving) onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [onCancel, saving, duplicates]);

  async function handleSubmit() {
    if (saving) return;
    const invalid = validateSupplierForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const { supplier, possibleMatches } = await createSupplier(
        supplierFormToPayload(form),
      );
      if (possibleMatches.length > 0) {
        // Replace this dialog's CONTENT with the advisory rather than opening a
        // second dialog on top of it.
        setSaving(false);
        setDuplicates({
          matches: possibleMatches,
          created: { id: supplier.id, name: supplier.name },
        });
        return;
      }
      onSelected(supplier.name);
    } catch (err: unknown) {
      if (isUnauthorizedError(err)) {
        redirectToLogin();
        return;
      }
      // The item form is untouched — only this dialog reports the failure.
      setError(err instanceof Error ? err.message : "לא הצלחנו ליצור ספק");
      setSaving(false);
    }
  }

  return (
    <div className="crm-scope" dir="rtl">
      <style dangerouslySetInnerHTML={{ __html: CRM_THEME_CSS }} />
      <div
        className="crm-modal__backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget && !saving) onCancel();
        }}
      >
        <div
          className="crm-modal"
          role="dialog"
          aria-modal="true"
          aria-label={duplicates ? "ייתכן שהספק כבר קיים" : "ספק חדש"}
          // On the Edit screen this dialog opens inside the edit SHEET, which is
          // itself a role="dialog". The attribute gives anything that needs to
          // tell the two apart — tests, and a human reading the DOM — something
          // unambiguous to hold on to.
          data-supplier-quick-create={duplicates ? "duplicates" : "form"}
          ref={dialogRef}
        >
          {duplicates ? (
            <SupplierDuplicateBody
              matches={duplicates.matches}
              createdName={duplicates.created.name}
              // Picking an existing supplier selects it for THIS item. The
              // supplier just created is not deleted or merged — the ratified
              // policy never auto-merges, and undoing the create here would be
              // inventing a new one.
              onOpenExisting={(id) => {
                const match = duplicates.matches.find((m) => m.id === id);
                onSelected(match ? match.name : duplicates.created.name);
              }}
              onKeepNew={() => onSelected(duplicates.created.name)}
              keepNewLabel="להמשיך עם הספק החדש"
            />
          ) : (
            <>
              <h2 className="crm-modal__title">ספק חדש</h2>
              <p className="crm-panel__body" style={{ marginTop: -4 }}>
                שם בלבד מספיק. אפשר להשלים את שאר הפרטים בכל שלב, והפריט עצמו
                יישמר רק כשתשמרו אותו.
              </p>

              <SupplierForm form={form} set={set} idPrefix="inv-sup-new" />

              {error ? <div className="crm-modal__error">{error}</div> : null}

              <div className="crm-modal__actions">
                <button
                  type="button"
                  className="crm-btn crm-btn--primary crm-btn--full"
                  onClick={() => void handleSubmit()}
                  disabled={saving}
                >
                  {saving ? "שומר…" : "יצירת ספק"}
                </button>
                <button
                  type="button"
                  className="crm-btn crm-btn--ghost"
                  onClick={onCancel}
                  disabled={saving}
                >
                  ביטול
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
