type Props = {
  appVersion: string;
};

export function SettingsSystemFooter({ appVersion }: Props) {
  return (
    <footer className="mt-8 border-t border-gray-200/80 pt-5">
      <p className="text-center text-xs text-gray-500">
        גרסת מערכת:{" "}
        <span className="font-mono font-medium text-gray-700">{appVersion}</span>
      </p>
    </footer>
  );
}
