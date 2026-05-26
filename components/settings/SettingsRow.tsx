import Link from "next/link";

type Props = {
  href: string;
  icon: string;
  title: string;
  description?: string;
};

export function SettingsRow({ href, icon, title, description }: Props) {
  return (
    <Link
      href={href}
      className="flex w-full items-start gap-3 rounded-2xl border border-transparent px-2 py-3 text-right transition active:scale-[0.99] hover:border-gray-100 hover:bg-gray-50/80"
    >
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#f8f6f1] text-lg">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-gray-900">{title}</span>
        {description ? (
          <span className="mt-1 block text-xs leading-5 text-gray-500">
            {description}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 self-center text-lg text-gray-400" aria-hidden>
        ←
      </span>
    </Link>
  );
}
