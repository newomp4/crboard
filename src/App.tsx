// Top-level app shell. Wires the store, the canvas, the toolbar, and the
// global paste/drop handlers (so you can drag-drop an image file or paste a
// URL anywhere).

import { useEffect } from "react";
import { Canvas } from "./Canvas";
import { Toolbar, useToolShortcuts } from "./Toolbar";
import { useStore } from "./store";
import { detectEmbed, looksLikeImageUrl, looksLikeUrl } from "./embeds";
import { fileToDataUrl } from "./io";
import type { ItemDraft } from "./types";

const App = () => {
  const { state, dispatch } = useStore();
  useToolShortcuts(dispatch);

  // Compute world coordinates near the visible center for new items.
  const worldCenter = () => ({
    x: (window.innerWidth / 2 - state.board.view.x) / state.board.view.zoom,
    y: (window.innerHeight / 2 - state.board.view.y) / state.board.view.zoom,
  });

  // Paste handler: image data → image item, URL → embed/link/image, plain text → text.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") {
        return; // let the input handle it
      }

      const cd = e.clipboardData;
      if (!cd) return;

      // 1. Image file in clipboard?
      for (const item of Array.from(cd.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            const src = await fileToDataUrl(file);
            const dims = await imgSize(src);
            const max = 480;
            const scale = Math.min(1, max / Math.max(dims.w, dims.h));
            const c = worldCenter();
            dispatch({
              type: "addItem",
              item: {
                type: "image",
                src,
                x: c.x - (dims.w * scale) / 2,
                y: c.y - (dims.h * scale) / 2,
                w: dims.w * scale,
                h: dims.h * scale,
              },
            });
            return;
          }
        }
      }

      // 2. Text — could be a URL or just text.
      const text = cd.getData("text/plain");
      if (!text) return;

      if (looksLikeUrl(text)) {
        e.preventDefault();
        const c = worldCenter();
        if (looksLikeImageUrl(text)) {
          dispatch({
            type: "addItem",
            item: {
              type: "image",
              src: text,
              x: c.x - 200,
              y: c.y - 150,
              w: 400,
              h: 300,
            },
          });
          return;
        }
        const info = detectEmbed(text);
        if (info && info.provider !== "generic") {
          dispatch({
            type: "addItem",
            item: {
              type: "embed",
              url: text,
              provider: info.provider,
              x: c.x - info.defaultSize.w / 2,
              y: c.y - info.defaultSize.h / 2,
              w: info.defaultSize.w,
              h: info.defaultSize.h,
            },
          });
          return;
        }
        dispatch({
          type: "addItem",
          item: {
            type: "link",
            url: text,
            x: c.x - 160,
            y: c.y - 50,
            w: 320,
            h: 100,
          },
        });
        return;
      }

      // 3. Plain text → text item.
      e.preventDefault();
      const c = worldCenter();
      dispatch({
        type: "addItem",
        item: {
          type: "text",
          text,
          fontSize: 16,
          x: c.x - 110,
          y: c.y - 40,
          w: 220,
          h: 80,
        },
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // Drag/drop image files onto the canvas.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
      }
    };
    const onDrop = async (e: DragEvent) => {
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;
      e.preventDefault();
      const c = worldCenterAt(e.clientX, e.clientY);
      const items: ItemDraft[] = [];
      let i = 0;
      for (const f of Array.from(files)) {
        if (!f.type.startsWith("image/")) continue;
        const src = await fileToDataUrl(f);
        const dims = await imgSize(src);
        const max = 480;
        const scale = Math.min(1, max / Math.max(dims.w, dims.h));
        items.push({
          type: "image",
          src,
          alt: f.name,
          x: c.x - (dims.w * scale) / 2 + i * 24,
          y: c.y - (dims.h * scale) / 2 + i * 24,
          w: dims.w * scale,
          h: dims.h * scale,
        });
        i++;
      }
      if (items.length) dispatch({ type: "addItems", items });
    };

    const worldCenterAt = (sx: number, sy: number) => ({
      x: (sx - state.board.view.x) / state.board.view.zoom,
      y: (sy - state.board.view.y) / state.board.view.zoom,
    });

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas state={state} dispatch={dispatch} />
      <Toolbar state={state} dispatch={dispatch} />
      {state.board.items.length === 0 && <EmptyHint />}
    </div>
  );
};

const EmptyHint = () => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",
      color: "#a3a3a3",
      fontSize: 13,
      letterSpacing: "0.02em",
      gap: 6,
    }}
  >
    <div style={{ fontWeight: 600, color: "#737373" }}>Empty board</div>
    <div>Paste a URL · drop an image · click a tool below</div>
  </div>
);

const imgSize = (src: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = src;
  });

export default App;
