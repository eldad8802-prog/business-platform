/**
 * DUBIZ INSIGHTS — the surface where what Dubiz has learned about the business
 * will appear.
 *
 * It is the third thing Home says, and it is deliberately not the other two:
 *   Home       what the business IS right now.
 *   Secretary  what NEEDS the owner.
 *   Insights   what Dubiz has NOTICED — patterns, outliers, conclusions.
 *
 * Today it can only be in one state: `learning`. That is not a placeholder in
 * the decorative sense — it is the honest report that no engine has concluded
 * anything yet. A fabricated insight here would be the worst lie the product
 * could tell, because the whole value of this surface is that the owner can
 * believe what it says. So there is no example, no sample pattern, and no call
 * to action promising something that does not exist.
 *
 * WHEN A REAL INSIGHT EXISTS, the same component renders it: the caller passes
 * `{ state: "ready", title, body }` and the card changes its eyebrow, its
 * headline and its text. Nothing else about it moves. There is no engine, no
 * endpoint, no model and no data behind it yet, and this file deliberately
 * does not invent any.
 */

export type HomeInsightView =
  | { state: "learning" }
  /** The shape a derived insight will arrive in. Nothing produces this yet. */
  | { state: "ready"; title: string; body: string };

const COPY = {
  learning: {
    eyebrow: "התובנות של Dubiz",
    title: "כאן Dubiz תלמד את העסק שלך",
    body: "ככל שתשתמש בדוביז, יופיעו כאן דפוסים ותובנות שיכולים לעזור לך להבין את העסק טוב יותר.",
  },
  ready: { eyebrow: "תובנה של Dubiz" },
};

/**
 * PROTOTYPE: the two treatments under review — "a" a quiet sage surface, "b" an
 * editorial paper surface with a teal band and badge. Same copy, same contract;
 * the loser is deleted once one is approved.
 */
export type InsightVariant = "a" | "b";

export function InsightCard({ view, variant = "a" }: { view: HomeInsightView; variant?: InsightVariant }) {
  const learning = view.state === "learning";
  return (
    <section
      className={`ins ${variant === "b" ? "ins-b-v" : "ins-a"}${learning ? " ins-learning" : ""}`}
      aria-labelledby="ins-h"
    >
      <p className="ins-eyebrow">
        {variant === "b" ? (
          <span className="ins-badge" aria-hidden>
            <SparkGlyph color="#fffdf8" size={13} />
          </span>
        ) : (
          <SparkGlyph color="#1f6f6b" size={13} />
        )}
        {learning ? COPY.learning.eyebrow : COPY.ready.eyebrow}
      </p>
      <h2 className="ins-t" id="ins-h">
        {learning ? COPY.learning.title : view.title}
      </h2>
      <p className="ins-b">{learning ? COPY.learning.body : view.body}</p>
    </section>
  );
}

/** The Dubiz mark for something noticed. One shape, one colour, no sparkle storm. */
function SparkGlyph({ color, size }: { color: string; size: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden style={{ display: "block", flex: "0 0 auto" }}>
      <path
        d="M8 .8l1.5 4.2 4.2 1.5-4.2 1.5L8 12.2 6.5 8 2.3 6.5 6.5 5z"
        fill={color}
      />
      <path d="M13.2 10.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill={color} opacity=".55" />
    </svg>
  );
}
