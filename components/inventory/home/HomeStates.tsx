import { IconAlertTriangle, IconBoxStack, IconPlus, IconRetry } from "@/components/inventory/home/home-icons";

/**
 * Empty-state body (business with zero products). Rendered BELOW the hero +
 * quick actions by the page, under a "המלאי שלך" heading. Distinct from the
 * error state — this means "nothing added yet", never "load failed".
 */
export function HomeEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="inv-hm-state">
      <span className="ei" aria-hidden><IconBoxStack /></span>
      <h3>אין עדיין מוצרים במלאי</h3>
      <p>הוסיפו את המוצר הראשון וניצור מעקב מלאי, התראות וספירות.</p>
      <button type="button" className="cta" onClick={onCreate}>
        <IconPlus />
        הוספת מוצר ראשון
      </button>
    </div>
  );
}

/**
 * Error state — a genuine "load failed" surface, fully separate from the empty
 * state. It reassures that data is intact (nothing was deleted) and offers a
 * retry. Fixes the previous bug where a failed fetch fell back to `setItems([])`
 * and impersonated a brand-new business.
 */
export function HomeError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="inv-hm-state err">
      <span className="ei" aria-hidden><IconAlertTriangle /></span>
      <h3>לא הצלחנו לטעון את המלאי</h3>
      <p>ייתכן שיש בעיית רשת. המוצרים שלך שמורים ולא נמחקו.</p>
      <button type="button" className="retry" onClick={onRetry}>
        <IconRetry />
        נסה שוב
      </button>
    </div>
  );
}

/** Loading skeleton in the new language: Hero → Health → Actions → Attention. */
export function HomeLoading() {
  return (
    <>
      <div className="inv-hm-sk" style={{ height: 140, borderRadius: 20 }} />
      <div className="inv-hm-sk" style={{ height: 110, borderRadius: 20, marginTop: 12 }} />
      <div className="inv-hm-sk" style={{ height: 16, width: 120, borderRadius: 8, margin: "26px 2px 13px" }} />
      <div className="inv-hm-qa">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="inv-hm-sk" style={{ height: 80, borderRadius: 20 }} />
        ))}
      </div>
      <div className="inv-hm-sk" style={{ height: 16, width: 100, borderRadius: 8, margin: "26px 2px 13px" }} />
      <div className="inv-hm-rows">
        {[0, 1].map((i) => (
          <div key={i} className="inv-hm-sk" style={{ height: 74, borderRadius: 20 }} />
        ))}
      </div>
    </>
  );
}
