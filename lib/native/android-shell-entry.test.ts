/**
 * Unit test — Android app opens on sign-in, not on the marketing page (issue 3).
 * Run: npx tsx lib/native/android-shell-entry.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  ANDROID_SHELL_ENTRY_SCRIPT,
  ANDROID_SHELL_MARKETING_PATHS,
  ANDROID_SHELL_ROOT_PATHS,
  leaveMarketingInAndroidShell,
} from "@/lib/native/android-shell-entry";

function run(pathname: string, androidShell: boolean) {
  const attrs: Record<string, string> = {};
  const style: Record<string, string> = {};
  const replaced: string[] = [];
  const window: Record<string, unknown> = {};
  if (androidShell) window.CapacitorSystemBarsAndroidInterface = { onDOMReady() {} };
  const document = { documentElement: { style, setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
  const location = { pathname, replace: (u: string) => replaced.push(u) };
  runInNewContext(ANDROID_SHELL_ENTRY_SCRIPT, { window, document, location });
  return { attrs, style, replaced };
}

function main() {
  // Android app, apex root (rewritten to /home on the server) and /home: hidden, replaced by /login.
  for (const p of ["/", "/home"]) {
    const r = run(p, true);
    assert.deepEqual(r.replaced, ["/login"], `${p} → /login`);
    assert.equal(r.style.visibility, "hidden", "the marketing page is never painted");
    assert.equal(r.attrs["data-shell"], "android");
  }
  // Android app, any other page: marked for app-only CSS, never redirected (so /login cannot loop).
  for (const p of ["/login", "/app", "/register", "/forgot-password", "/reset-password", "/privacy", "/homework", "/home/x"]) {
    const r = run(p, true);
    assert.deepEqual(r.replaced, [], `${p} is not redirected`);
    assert.equal(r.style.visibility, undefined);
    assert.equal(r.attrs["data-shell"], "android");
  }
  // Browsers / iPhone / iOS shell: nothing at all.
  for (const p of ["/", "/home", "/login"]) {
    const r = run(p, false);
    assert.deepEqual(r, { attrs: {}, style: {}, replaced: [] }, `${p} untouched outside the Android shell`);
  }
  // A throwing environment never breaks the page.
  assert.doesNotThrow(() =>
    runInNewContext(ANDROID_SHELL_ENTRY_SCRIPT, {
      window: { CapacitorSystemBarsAndroidInterface: {} },
      document: { get documentElement() { throw new Error("boom"); } },
      location: { pathname: "/" },
    })
  );

  // Client backstop for in-app navigation (the <head> script does not run again).
  const nav = (androidShell: boolean) => {
    const replaced: string[] = [];
    const win = { ...(androidShell ? { CapacitorSystemBarsAndroidInterface: {} } : {}), location: { replace: (u: string) => replaced.push(u) } };
    return { win, replaced };
  };
  {
    const { win, replaced } = nav(true);
    assert.equal(leaveMarketingInAndroidShell("/home", win), true);
    assert.equal(leaveMarketingInAndroidShell("/", win), true);
    assert.equal(leaveMarketingInAndroidShell("/privacy", win), false);
    assert.equal(leaveMarketingInAndroidShell("/login", win), false);
    assert.equal(leaveMarketingInAndroidShell(null, win), false);
    assert.deepEqual(replaced, ["/login", "/login"]);
  }
  {
    const { win, replaced } = nav(false);
    assert.equal(leaveMarketingInAndroidShell("/home", win), false);
    assert.deepEqual(replaced, []);
  }
  assert.deepEqual([...ANDROID_SHELL_MARKETING_PATHS], ["/", "/home"]);
  assert.deepEqual([...ANDROID_SHELL_ROOT_PATHS], ["/login", "/app"]);

  const root = process.cwd();
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  // Wiring: the script is in <head> (before any paint) and <html> tolerates the attribute it sets.
  const layout = read("app/layout.tsx");
  assert.match(layout, /<head>[\s\S]*__html:\s*ANDROID_SHELL_ENTRY_SCRIPT[\s\S]*<\/head>/, "entry script ships in <head>");
  assert.match(layout, /<html[\s\S]*?suppressHydrationWarning[\s\S]*?>/, "<html> accepts data-shell set before hydration");
  assert.match(layout, /viewportFit:\s*"cover"/, "issue 2 viewport contract unchanged");
  // The server still sends `/` to the marketing page — the public site is unchanged.
  assert.match(read("next.config.ts"), /source: "\/",\s*has: \[\{ type: "host", value: "promaxgroup\.co\.il" \}\],\s*destination: "\/home"/);
  // Android back on a root screen minimizes before any history.back(): the launch URL stays in the
  // WebView's history after the entry redirect, so going back would bounce straight back.
  const shell = read("lib/native/native-shell.ts");
  assert.match(
    shell,
    /if \(ANDROID_SHELL_ROOT_PATHS\.includes\(window\.location\.pathname\)\) \{\s*void App\.minimizeApp\(\);\s*\} else if \(canGoBack \|\| window\.history\.length > 1\) \{/
  );
  // In-app navigation backstop is mounted.
  assert.match(read("components/native/NativeShellInit.tsx"), /leaveMarketingInAndroidShell\(pathname\)/);
  // /login never sends anyone to a marketing route (no loop): it only goes to /app or /register.
  const login = read("app/login/login-form.tsx");
  assert.doesNotMatch(login, /location\.(replace|assign|href)\s*[=(]\s*[`"'](\$\{window\.location\.origin\})?\/(home)?[`"']/);
  // The compact sign-in screen (owner-approved elements) is decided in the form from the app marker,
  // so a browser renders exactly the same DOM as before (no attributes, no CSS, no extra nodes).
  assert.match(login, /\{inAndroidApp \? null : \(\s*<div style=\{badgeStyle\}>/, "badge left out in the app");
  assert.match(login, /\{inAndroidApp \? null : <p style=\{subtitleStyle\}>/, "long subtitle left out in the app");
  assert.match(login, /<h1 style=\{titleStyle\}>\{t\(inAndroidApp \? "account\.auth\.login\.appTitle" : "account\.auth\.login\.title"\)\}<\/h1>/, "app title");
  assert.match(login, /\{inAndroidApp \? null : \(\s*<div style=\{dividerStyle\}>/, "divider left out in the app");
  assert.doesNotMatch(login, /data-shell-(hide|only|mute)/, "no app-only attributes in the browser DOM");
  // Field help is muted, not removed: the error that replaces it in place must not shift the
  // links below it mid-tap (the emulator caught taps on "register" / "forgot" missing that way).
  // In a browser the style object is the same helperTextStyle as before.
  assert.match(login, /const fieldHelpStyle: React\.CSSProperties = inAndroidApp \? \{ \.\.\.helperTextStyle, visibility: "hidden" \} : helperTextStyle;/);
  assert.match(login, /id="login-email-msg" style=\{fieldHelpStyle\}/, "email helper muted");
  assert.match(login, /id="login-password-msg" style=\{fieldHelpStyle\}/, "password helper muted");
  // The public stylesheet is untouched.
  assert.doesNotMatch(read("app/globals.css"), /data-shell/);
  // Errors stay visible in the app (only the idle helper text is hidden).
  assert.match(login, /<p id="login-email-msg" role="alert" style=\{fieldErrorStyle\}>/);
  assert.match(login, /<p id="login-password-msg" role="alert" style=\{fieldErrorStyle\}>/);
  // No autofocus in the app (the keyboard would cover the screen on launch and eat the first back);
  // read only after the boot screen, which is all the server renders.
  assert.match(login, /autoFocus=\{!inAndroidApp\}/);
  assert.ok(
    login.indexOf("if (bootLoading) {") < login.indexOf('const inAndroidApp = document.documentElement.getAttribute("data-shell") === "android";'),
    "the app marker is read after the boot screen (client-only form)"
  );
  // Forgot password and register stay in the app.
  assert.match(login, /data-testid="forgot-password-link"/);
  assert.match(read("lib/i18n/messages/areas/account.ts"), /appTitle: "כניסה לדוביז"/);

  // Detection premise: the installed Capacitor still exposes the SystemBars Android interface.
  const sb = read("node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java");
  assert.ok(sb.includes('addJavascriptInterface(this, "CapacitorSystemBarsAndroidInterface")'));

  console.log("android-shell-entry: all assertions passed");
}

main();
