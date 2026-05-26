type Props = {
  title?: string;
  description?: string;
  children: React.ReactNode;
};

export function SettingsSection({ title, description, children }: Props) {
  return (
    <section className="rounded-[24px] bg-white p-4 shadow-sm">
      {title ? (
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
      ) : null}
      {description ? (
        <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
      ) : null}
      {(title || description) && <div className="mt-3" />}
      {children}
    </section>
  );
}
