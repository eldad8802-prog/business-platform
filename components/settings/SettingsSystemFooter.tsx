type Props = {
  appVersion: string;
};

export function SettingsSystemFooter({ appVersion }: Props) {
  return (
    <footer className="mt-8 border-t border-[var(--dz-border-subtle)] pt-5">
      <p className="text-center text-xs text-[var(--dz-text-muted)]">
        גרסת מערכת:{" "}
        <span className="font-mono font-medium text-[var(--dz-text-secondary)]">{appVersion}</span>
      </p>
    </footer>
  );
}
