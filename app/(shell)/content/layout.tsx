import type { ReactNode } from "react";
import { StudioBrief } from "@/components/content/StudioBrief";
import "./content-desktop.css";

/**
 * Content studio frame. Below 1200 it adds nothing: every step keeps its own
 * phone composition. From 1200 the step sits in a working column beside a
 * sticky brief of what has been chosen so far (see content-desktop.css).
 */
export default function ContentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="studio-frame">
      <div className="studio-work">{children}</div>
      <StudioBrief />
    </div>
  );
}
