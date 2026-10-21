import type { he } from "./he";

/** Same tree as the Hebrew source dictionary, every leaf widened to `string`. */
export type Widen<T> = { readonly [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export type Messages = Widen<typeof he>;
