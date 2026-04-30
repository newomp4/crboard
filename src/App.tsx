// Top-level app shell. Wires the store, the canvas, the toolbar, and the
// global paste/drop handlers (so you can drag-drop an image file or paste a
// URL anywhere).

import { useEffect, useState } from "react";
import { Canvas } from "./Canvas";
import { Toolbar } from "./Toolbar";
import { useToolShortcuts } from "./shortcuts";
import { useStore } from "./store";
import { detectEmbed, looksLikeImageUrl, looksLikeUrl } from "./embeds";
import { fileToDataUrl } from "./io";
import type { Item, ItemDraft } from "./types";

// Magic number used to identify clipboard payloads written by crboard, so a
// crboard paste isn't confused with arbitrary JSON the user might copy from
// elsewhere.
const CR_CLIPBOARD_TAG = "crboard/v1";

const App = () => {
  const { state, dispatch } = useStore();
  useToolShortcuts(dispatch);

  // Compute world coordinates near the visible center for new items.
  const worldCenter = () => ({
    x: (window.innerWidth / 2 - state.board.view.x) / state.board.view.zoom,
    y: (window.innerHeight / 2 - state.board.view.y) / state.board.view.zoom,
  });

  // Copy / cut: serialize selected items as a tagged JSON blob and write to the
  // system clipboard. We store the items keeping their absolute positions so
  // paste can re-center them on the current viewport.
  useEffect(() => {
    const inEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return Boolean(
        el?.isContentEditable ||
          el?.tagName === "INPUT" ||
          el?.tagName === "TEXTAREA",
      );
    };

    const onCopy = (e: ClipboardEvent) => {
      if (inEditable(e.target)) return;
      if (state.selection.size === 0) return;
      const items = state.board.items.filter((it) =>
        state.selection.has(it.id),
      );
      e.clipboardData?.setData(
        "text/plain",
        JSON.stringify({ tag: CR_CLIPBOARD_TAG, items }),
      );
      e.preventDefault();
    };

    const onCut = (e: ClipboardEvent) => {
      if (inEditable(e.target)) return;
      if (state.selection.size === 0) return;
      const items = state.board.items.filter((it) =>
        state.selection.has(it.id),
      );
      e.clipboardData?.setData(
        "text/plain",
        JSON.stringify({ tag: CR_CLIPBOARD_TAG, items }),
      );
      e.preventDefault();
      dispatch({ type: "removeItems", ids: [...state.selection] });
    };

    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
    };
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

      // 0. crboard items? Detect the tagged JSON payload and add copies
      //    centered on the current viewport. Stripped of id/z so the reducer
      //    assigns fresh ones.
      const text0 = cd.getData("text/plain");
      if (text0) {
        try {
          const parsed = JSON.parse(text0);
          if (
            parsed &&
            parsed.tag === CR_CLIPBOARD_TAG &&
            Array.isArray(parsed.items) &&
            parsed.items.length > 0
          ) {
            e.preventDefault();
            const items = parsed.items as Item[];
            // Translate the bbox of pasted items so it lands centered on the viewport.
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const it of items) {
              if (it.x < minX) minX = it.x;
              if (it.y < minY) minY = it.y;
              if (it.x + it.w > maxX) maxX = it.x + it.w;
              if (it.y + it.h > maxY) maxY = it.y + it.h;
            }
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const c = worldCenter();
            const dx = c.x - cx;
            const dy = c.y - cy;
            const drafts: ItemDraft[] = items.map((it) => {
              // Strip id/z; reducer regenerates them on add.
              const stripped: Record<string, unknown> = { ...it };
              delete stripped.id;
              delete stripped.z;
              return {
                ...(stripped as ItemDraft),
                x: it.x + dx,
                y: it.y + dy,
              } as ItemDraft;
            });
            dispatch({ type: "addItems", items: drafts });
            return;
          }
        } catch {
          // Not JSON — fall through to the regular paste paths below.
        }
      }

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

  // Drag/drop image files onto the canvas + show a "drop here" overlay while
  // files are dragged from the OS.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // dragover fires repeatedly during a drag; use a small counter to track
    // whether we're inside a file-drag at all (browsers send dragenter/leave
    // pairs that flicker as you cross child elements, so we count them).
    let depth = 0;
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer && e.dataTransfer.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      depth = 0;
      setDragging(false);
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

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas state={state} dispatch={dispatch} />
      <Toolbar state={state} dispatch={dispatch} />
      {state.board.items.length === 0 && <EmptyHint />}
      {dragging && (
        <div className="drop-overlay">
          <span>Drop image to add to board</span>
        </div>
      )}
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
      color: "var(--text-faint)",
      fontSize: 13,
      letterSpacing: "0.02em",
      gap: 6,
    }}
  >
    <div style={{ fontWeight: 600, color: "var(--text-3)" }}>Empty board</div>
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
