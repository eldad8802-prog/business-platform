import { redirect } from "next/navigation";

// The authenticated app home now lives at `/app` (see app/(shell)/app/page.tsx).
// On the primary domain (promaxgroup.co.il) `/` is rewritten to the public
// Corporate home via the beforeFiles rewrite in next.config.ts, so this file is
// never reached there. On other hosts (e.g. *.vercel.app, localhost) `/` simply
// forwards into the app at `/app`, which itself gates to `/login` when there is
// no session.
export default function ShellRootRedirect() {
  redirect("/app");
}
