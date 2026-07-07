import type { ReactNode } from "react";
import { ShellChrome } from "@/components/navigation/shell-chrome";

/**
 * Preboot no-flash script for the brand intro. Runs before first paint on a full
 * /app document load: if the user is authenticated and the intro hasn't shown
 * this session, it paints a full-screen cream backdrop immediately — so the very
 * first paint is the intro's cream ground, never a white flash or the old
 * skeleton. The React <DubizIntroOverlay> then takes over and removes it.
 * Purely visual; reads no state it doesn't already own (token existence only).
 */
const INTRO_PREBOOT = `(function(){try{
if(location.pathname!=='/app')return;
if(sessionStorage.getItem('dubiz.intro.v1'))return;
if(!localStorage.getItem('token'))return;
var r=document.documentElement;
r.setAttribute('data-dubiz-intro','1');
var st=document.createElement('style');
st.textContent='html[data-dubiz-intro] [data-shell-root]{visibility:hidden!important}';
(document.head||r).appendChild(st);
var d=document.createElement('div');
d.id='dubiz-intro-preboot';d.setAttribute('aria-hidden','true');
d.style.cssText='position:fixed;inset:0;z-index:2147483600;background:radial-gradient(circle at 50% 38%,#FDFBF6 0%,#F5EFE2 58%,#EDE4D3 100%)';
(document.body||r).appendChild(d);
setTimeout(function(){try{r.removeAttribute('data-dubiz-intro');var x=document.getElementById('dubiz-intro-preboot');if(x)x.remove();}catch(e){}},22000);
}catch(e){}})();`;

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: INTRO_PREBOOT }} />
      <ShellChrome>{children}</ShellChrome>
    </>
  );
}
