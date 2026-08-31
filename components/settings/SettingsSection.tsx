type Props = {
  title?: string;
  description?: string;
  children: React.ReactNode;
};

export function SettingsSection({ title, description, children }: Props) {
  return (
    <section className="rounded-[24px] dz-mist p-4 shadow-sm">
      {title ? (
        <h2 className="text-sm font-bold text-[var(--dz-text-primary)]">{title}</h2>
      ) : null}
      {description ? (
        <p className="mt-1 text-xs leading-5 text-[var(--dz-text-muted)]">{description}</p>
      ) : null}
      {(title || description) && <div className="mt-3" />}
      {children}
    </section>
  );
}
