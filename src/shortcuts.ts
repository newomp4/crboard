// Tool-mode keyboard shortcuts (V / T / P).
// Lives outside Toolbar.tsx so React Fast Refresh stays happy — files that
// export both components and hooks fall out of the HMR fast path.

import { useEffect } from "react";
import type { Action } from "./store";

export const useToolShortcuts = (dispatch: React.Dispatch<Action>) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t?.isContentEditable ||
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA"
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "v" || e.key === "V")
        dispatch({ type: "setTool", tool: "select" });
      if (e.key === "t" || e.key === "T")
        dispatch({ type: "setTool", tool: "text" });
      if (e.key === "p" || e.key === "P")
        dispatch({ type: "setTool", tool: "pen" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);
};
