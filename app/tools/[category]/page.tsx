import { notFound } from "next/navigation";

import { TOOL_GROUPS, groupBySlug } from "@/lib/navigation/home-routes";
import { CategoryScreen } from "@/features/tools/category-screen";

/**
 * /tools/money · /tools/customers · /tools/operations — one screen per Home
 * card. Only the three slugs declared in `TOOL_GROUPS` exist; anything else is
 * a 404 rather than an empty category.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return TOOL_GROUPS.map((group) => ({ category: group.slug }));
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ category: string }>;
}) {
  const { category } = await params;
  const group = groupBySlug(category);
  if (!group) notFound();
  return <CategoryScreen groupKey={group.key} />;
}
