// Infinite canvas. The world is a single absolutely-positioned div with a
// CSS transform applied. Items live inside it at world coordinates.
//
// Why CSS transforms instead of a real <canvas>: we need to host iframes
// (Instagram, YouTube, TikTok). A <canvas> can only paint pixels — it can't
// embed live web content. CSS transforms give us pan/zoom for free while
// keeping items as real DOM elements.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Action, State } from "./store";
import type { Item, ItemDraft, Stroke } from "./types";
import { ItemView } from "./Item";
import { clampZoom, fitToBounds, screenToWorld, zoomAt } from "./coords";
import { smoothPathD, thinPoints } from "./smooth";

type Props = {
  state: State;
  dispatch: React.Dispatch<Action>;
};

// Screen-space rectangle for the rubber-band selection overlay.
type Rect = { x: number; y: number; w: number; h: number };

export const Canvas = ({ state, dispatch }: Props) => {
  const { board, selection, tool, editId, pen } = state;
  const containerRef = useRef<HTMLDivElement>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  // Right-click context menu, anchored at screen coords.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    itemId: string;
  } | null>(null);

  // In-progress drawing stroke. Stored separately from the board so we don't
  // reduce on every mousemove — only when the stroke ends.
  const [activeStroke, setActiveStroke] = useState<{
    points: { x: number; y: number }[];
    color: string;
    width: number;
  } | null>(null);

  // Snapshot the current selection ids as a stable array for ItemView so the
  // multi-drag handler in Item.tsx knows what else needs to move with it.
  const selectedIds = useMemo(() => [...selection], [selection]);

  // Track space key — held for pan-anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent, down: boolean) => {
      if (e.code === "Space") {
        if (
          (e.target as HTMLElement | null)?.isContentEditable ||
          (e.target as HTMLElement | null)?.tagName === "INPUT" ||
          (e.target as HTMLElement | null)?.tagName === "TEXTAREA"
        ) {
          return;
        }
        setSpaceDown(down);
        if (down) e.preventDefault();
      }
    };
    const onDown = (e: KeyboardEvent) => onKey(e, true);
    const onUp = (e: KeyboardEvent) => onKey(e, false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  // Editing keyboard shortcuts: delete, escape, undo/redo, duplicate, nudge,
  // select-all, z-order, zoom-reset, fit-content.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable || t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;

      const mod = e.metaKey || e.ctrlKey;

      // Undo / redo. Cmd+Z, Shift+Cmd+Z or Cmd+Y.
      if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if (
        (mod && e.shiftKey && (e.key === "z" || e.key === "Z")) ||
        (mod && (e.key === "y" || e.key === "Y"))
      ) {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }

      // Select all.
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        dispatch({
          type: "selectOnly",
          ids: state.board.items.map((it) => it.id),
        });
        return;
      }

      // Duplicate selection.
      if (mod && (e.key === "d" || e.key === "D") && selection.size > 0) {
        e.preventDefault();
        dispatch({ type: "duplicateItems", ids: [...selection] });
        return;
      }

      // Z-order: Cmd+] forward, Cmd+[ backward. Applies to all selected.
      if (mod && e.key === "]" && selection.size > 0) {
        e.preventDefault();
        for (const id of selection) dispatch({ type: "bringToFront", id });
        return;
      }
      if (mod && e.key === "[" && selection.size > 0) {
        e.preventDefault();
        for (const id of selection) dispatch({ type: "sendToBack", id });
        return;
      }

      // Reset / fit zoom.
      if (mod && e.key === "0") {
        e.preventDefault();
        dispatch({ type: "setView", view: { x: 0, y: 0, zoom: 1 } });
        return;
      }
      if (mod && e.key === "1") {
        e.preventDefault();
        const el = containerRef.current;
        if (!el || state.board.items.length === 0) return;
        const r = el.getBoundingClientRect();
        dispatch({
          type: "setView",
          view: fitToBounds(state.board.items, r.width, r.height),
        });
        return;
      }

      // Cmd+J: zoom-to-selection. Same math as fit-content, but only the
      // selected items.
      if (mod && (e.key === "j" || e.key === "J") && selection.size > 0) {
        e.preventDefault();
        const el = containerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const sel = state.board.items.filter((it) => selection.has(it.id));
        if (sel.length === 0) return;
        dispatch({
          type: "setView",
          view: fitToBounds(sel, r.width, r.height),
        });
        return;
      }

      // Delete.
      if ((e.key === "Backspace" || e.key === "Delete") && selection.size > 0) {
        e.preventDefault();
        dispatch({ type: "removeItems", ids: [...selection] });
        return;
      }

      // Arrow-key nudge: 1px, or 10px with shift.
      if (
        selection.size > 0 &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        dispatch({ type: "commitHistory" });
        dispatch({ type: "nudgeItems", ids: [...selection], dx, dy });
        return;
      }

      // Enter on a single selected text item drops into edit mode.
      if (e.key === "Enter" && !e.shiftKey && !mod && selection.size === 1) {
        const id = [...selection][0];
        const it = state.board.items.find((i) => i.id === id);
        if (it && it.type === "text") {
          e.preventDefault();
          dispatch({ type: "setEditId", id });
          return;
        }
      }

      if (e.key === "Escape") {
        dispatch({ type: "clearSelection" });
        dispatch({ type: "setTool", tool: "select" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, state.board.items, dispatch]);

  // Wheel handler — needs preventDefault so we attach via ref with passive:false.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        const next = clampZoom(board.view.zoom * factor);
        dispatch({ type: "setView", view: zoomAt(board.view, cursor, next) });
      } else {
        dispatch({
          type: "setView",
          view: {
            ...board.view,
            x: board.view.x - e.deltaX,
            y: board.view.y - e.deltaY,
          },
        });
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [board.view, dispatch]);

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Pan: space held, or middle mouse, or right mouse.
    if (spaceDown || e.button === 1 || e.button === 2) {
      e.preventDefault();
      setPanning(true);
      const start = { x: e.clientX, y: e.clientY };
      const orig = { x: board.view.x, y: board.view.y };
      const onMove = (ev: PointerEvent) => {
        dispatch({
          type: "setView",
          view: {
            ...board.view,
            x: orig.x + (ev.clientX - start.x),
            y: orig.y + (ev.clientY - start.y),
          },
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setPanning(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    if (e.button !== 0) return;

    const world = screenToWorld(screen, board.view);

    if (tool === "text") {
      dispatch({
        type: "addItem",
        edit: true,
        item: {
          type: "text",
          x: world.x,
          y: world.y,
          w: 220,
          h: 80,
          text: "",
          fontSize: 16,
        },
      });
      dispatch({ type: "setTool", tool: "select" });
      return;
    }

    if (tool === "pen") {
      // Start a new stroke. We collect points in world coordinates; on release
      // we thin + smooth them and commit as a drawing item.
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const points = [world];
      const color = pen.color;
      const width = pen.width;
      setActiveStroke({ points, color, width });

      const onMove = (ev: PointerEvent) => {
        const r = containerRef.current!.getBoundingClientRect();
        const w = screenToWorld(
          { x: ev.clientX - r.left, y: ev.clientY - r.top },
          board.view,
        );
        points.push(w);
        setActiveStroke({ points: [...points], color, width });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        commitStroke(points, color, width);
        setActiveStroke(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    // Tool = select. Empty-canvas drag = rubber-band marquee.
    e.preventDefault();
    const startScreen = { ...screen };
    const additive = e.shiftKey;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const r = containerRef.current!.getBoundingClientRect();
      const cur = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const dx = cur.x - startScreen.x;
      const dy = cur.y - startScreen.y;
      if (!moved && dx * dx + dy * dy < 9) return; // 3px deadzone
      moved = true;
      setMarquee({
        x: Math.min(startScreen.x, cur.x),
        y: Math.min(startScreen.y, cur.y),
        w: Math.abs(dx),
        h: Math.abs(dy),
      });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMarquee(null);
      if (!moved) {
        // Click without drag → clear selection.
        if (!additive) dispatch({ type: "clearSelection" });
        return;
      }
      const r = containerRef.current!.getBoundingClientRect();
      const end = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const a = screenToWorld(startScreen, board.view);
      const b = screenToWorld(end, board.view);
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxX = Math.max(a.x, b.x);
      const maxY = Math.max(a.y, b.y);
      const hits = state.board.items
        .filter((it) =>
          rectsIntersect(
            { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
            { x: it.x, y: it.y, w: it.w, h: it.h },
          ),
        )
        .map((it) => it.id);
      if (additive) dispatch({ type: "selectAdd", ids: hits });
      else dispatch({ type: "selectOnly", ids: hits });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const commitStroke = (
    points: { x: number; y: number }[],
    color: string,
    width: number,
  ) => {
    if (points.length < 1) return;
    const thinned = thinPoints(points);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of thinned) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Pad bbox by half-stroke-width plus a hair so the stroke isn't clipped
    // by the item's bounds at high zoom.
    const pad = width / 2 + 2;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;

    const local = thinned.map((p) => ({ x: p.x - minX, y: p.y - minY }));
    const d = smoothPathD(local);

    const stroke: Stroke = { d, strokeWidth: width, color };
    const drawing: ItemDraft = {
      type: "drawing",
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      strokes: [stroke],
    };
    dispatch({ type: "addItem", item: drawing });
  };

  // Cursor reflects the active mode.
  let cursor = "default";
  if (panning) cursor = "grabbing";
  else if (spaceDown) cursor = "grab";
  else if (tool === "pen") cursor = "crosshair";
  else if (tool === "text") cursor = "text";

  return (
    <div
      ref={containerRef}
      onPointerDown={onCanvasPointerDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--bg)",
        cursor,
        touchAction: "none",
      }}
    >
      {/* Dotted grid: a tiled background that we shift with pan and scale with zoom. */}
      <div
        className="dot-grid"
        style={{
          position: "absolute",
          inset: 0,
          backgroundSize: `${24 * board.view.zoom}px ${24 * board.view.zoom}px`,
          backgroundPosition: `${board.view.x}px ${board.view.y}px`,
          opacity: 0.6,
          pointerEvents: "none",
        }}
      />

      {/* The world: one transformed div containing all items. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transformOrigin: "0 0",
          transform: `translate(${board.view.x}px, ${board.view.y}px) scale(${board.view.zoom})`,
          width: 0,
          height: 0,
        }}
      >
        {board.items.map((it) => (
          <ItemView
            key={it.id}
            item={it}
            selected={selection.has(it.id)}
            // Hide the per-item selection chrome while a multi-select is
            // active — the group bounding box draws its own.
            suppressIndividualHandles={selection.size > 1}
            autoEdit={editId === it.id}
            view={board.view}
            tool={tool}
            allItems={board.items}
            selectedIds={selectedIds}
            onContextMenu={(itemId, x, y) => setCtxMenu({ itemId, x, y })}
            dispatch={dispatch}
          />
        ))}

        {/* Group bounding box + 8 handles when 2+ items are selected. */}
        {selection.size > 1 && (
          <MultiSelection
            items={board.items.filter((it) => selection.has(it.id))}
            view={board.view}
            dispatch={dispatch}
          />
        )}

        {activeStroke && activeStroke.points.length > 0 && (
          <svg
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              overflow: "visible",
              pointerEvents: "none",
            }}
          >
            <path
              d={smoothPathD(activeStroke.points)}
              stroke={activeStroke.color}
              strokeWidth={activeStroke.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      {/* Rubber-band marquee — drawn in screen coords above the world. */}
      {marquee && (
        <div
          style={{
            position: "absolute",
            left: marquee.x,
            top: marquee.y,
            width: marquee.w,
            height: marquee.h,
            border: "1px solid var(--selection)",
            background: "var(--overlay-tint)",
            pointerEvents: "none",
          }}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          item={state.board.items.find((it) => it.id === ctxMenu.itemId)}
          dispatch={dispatch}
          close={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
};

// ---------- group transform ----------

// Renders a single bounding box around all selected items with 8 resize
// handles. Each handle scales every selected item proportionally relative to
// the bounding box. The math:
//   - capture each item's origin (x, y, w, h, fontSize?) at gesture start
//   - each frame, compute new bbox dims based on which handle and dx/dy
//   - sx = newW/origBboxW, sy = newH/origBboxH
//   - newItem.x = newBbox.x + (origItem.x - origBbox.x) * sx
//   - etc.
// Text font size scales by min(sx, sy) so headings shrink smoothly with the
// group rather than overflowing.
const MultiSelection = ({
  items,
  view,
  dispatch,
}: {
  items: Item[];
  view: { x: number; y: number; zoom: number };
  dispatch: React.Dispatch<Action>;
}) => {
  if (items.length === 0) return null;

  // Bbox in world coords.
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
  const bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

  const startResize = (handle: HandlePosLong) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const left = handle.includes("l");
    const right = handle.includes("r");
    const top = handle.includes("t");
    const bottom = handle.includes("b");

    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...bbox };
    const aspect = orig.w / orig.h;
    // Origins for every selected item.
    const origins = items.map((it) => ({
      id: it.id,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      fontSize: it.type === "text" ? it.fontSize : undefined,
    }));

    let committed = false;

    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / view.zoom;
      const dy = (ev.clientY - startY) / view.zoom;
      if (dx === 0 && dy === 0) return;
      if (!committed) {
        dispatch({ type: "commitHistory" });
        committed = true;
      }

      // Default for groups is proportional (locked); shift frees it up.
      const locked = !ev.shiftKey;

      // Unconstrained candidate dims, clamped to a sane minimum.
      let nw = orig.w;
      let nh = orig.h;
      if (left) nw = orig.w - dx;
      else if (right) nw = orig.w + dx;
      if (top) nh = orig.h - dy;
      else if (bottom) nh = orig.h + dy;
      nw = Math.max(20, nw);
      nh = Math.max(20, nh);

      if (locked) {
        const cornerHandle = (left || right) && (top || bottom);
        if (cornerHandle) {
          const rW = nw / orig.w;
          const rH = nh / orig.h;
          if (Math.abs(rW - 1) >= Math.abs(rH - 1)) nh = nw / aspect;
          else nw = nh * aspect;
        } else if (left || right) {
          nh = nw / aspect;
        } else {
          nw = nh * aspect;
        }
      }

      let nx = orig.x;
      let ny = orig.y;
      if (left) nx = orig.x + (orig.w - nw);
      if (top) ny = orig.y + (orig.h - nh);

      const sx = nw / orig.w;
      const sy = nh / orig.h;
      const fScale = Math.min(sx, sy);

      const transforms = origins.map((o) => {
        const newX = nx + (o.x - orig.x) * sx;
        const newY = ny + (o.y - orig.y) * sy;
        const newW = Math.max(8, o.w * sx);
        const newH = Math.max(8, o.h * sy);
        const next: {
          id: string;
          x: number;
          y: number;
          w: number;
          h: number;
          fontSize?: number;
        } = { id: o.id, x: newX, y: newY, w: newW, h: newH };
        if (o.fontSize !== undefined) {
          next.fontSize = Math.max(8, Math.round(o.fontSize * fScale));
        }
        return next;
      });
      dispatch({ type: "transformItems", transforms });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      style={{
        position: "absolute",
        left: bbox.x,
        top: bbox.y,
        width: bbox.w,
        height: bbox.h,
        outline: "2px solid var(--selection)",
        outlineOffset: 2,
        // The frame itself shouldn't intercept clicks — let them reach items
        // underneath. Only the handles below get pointer events.
        pointerEvents: "none",
      }}
    >
      {(["tl", "tr", "bl", "br", "t", "b", "l", "r"] as HandlePosLong[]).map(
        (p) => (
          <GroupHandle key={p} pos={p} onPointerDown={startResize(p)} />
        ),
      )}
    </div>
  );
};

type HandlePosLong = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

// Independent copy of the resize handle visuals — kept separate so it can
// re-enable pointerEvents on top of the parent's pointer-events:none.
const GroupHandle = ({
  pos,
  onPointerDown,
}: {
  pos: HandlePosLong;
  onPointerDown: (e: React.PointerEvent) => void;
}) => {
  const cursors = {
    tl: "nwse-resize",
    br: "nwse-resize",
    tr: "nesw-resize",
    bl: "nesw-resize",
    t: "ns-resize",
    b: "ns-resize",
    l: "ew-resize",
    r: "ew-resize",
  } as const;
  const SIZE = 10;
  const offset = -SIZE / 2 - 2;
  const isCorner = pos.length === 2;

  const style: React.CSSProperties = {
    position: "absolute",
    width: SIZE,
    height: SIZE,
    background: "var(--surface-2)",
    border: "1.5px solid var(--selection)",
    cursor: cursors[pos],
    pointerEvents: "auto",
    touchAction: "none",
  };

  if (isCorner) {
    if (pos.includes("t")) style.top = offset;
    else style.bottom = offset;
    if (pos.includes("l")) style.left = offset;
    else style.right = offset;
  } else {
    if (pos === "t" || pos === "b") {
      style.left = "50%";
      style.transform = "translateX(-50%)";
      if (pos === "t") style.top = offset;
      else style.bottom = offset;
    } else {
      style.top = "50%";
      style.transform = "translateY(-50%)";
      if (pos === "l") style.left = offset;
      else style.right = offset;
    }
  }
  return <div style={style} onPointerDown={onPointerDown} />;
};

// ---------- context menu ----------

const ContextMenu = ({
  x,
  y,
  item,
  dispatch,
  close,
}: {
  x: number;
  y: number;
  item: Item | undefined;
  dispatch: React.Dispatch<Action>;
  close: () => void;
}) => {
  // Close on outside click or escape.
  useEffect(() => {
    const onDown = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Defer attaching the click listener so the right-click that opened the
    // menu doesn't immediately close it.
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  if (!item) return null;

  const linky =
    item.type === "embed" || item.type === "link" ? item.url : null;

  const run = (fn: () => void) => () => {
    fn();
    close();
  };

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: 180,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        boxShadow: "var(--shadow)",
        padding: 4,
        zIndex: 2000,
        fontSize: 13,
      }}
    >
      <CtxItem onClick={run(() => dispatch({ type: "bringToFront", id: item.id }))} kbd="⌘]">
        Bring to front
      </CtxItem>
      <CtxItem onClick={run(() => dispatch({ type: "sendToBack", id: item.id }))} kbd="⌘[">
        Send to back
      </CtxItem>
      <CtxSep />
      <CtxItem
        onClick={run(() => dispatch({ type: "duplicateItems", ids: [item.id] }))}
        kbd="⌘D"
      >
        Duplicate
      </CtxItem>
      {linky && (
        <>
          <CtxSep />
          <CtxItem
            onClick={run(() => {
              window.open(linky, "_blank", "noreferrer");
            })}
          >
            Open original
          </CtxItem>
          <CtxItem
            onClick={run(() => {
              void navigator.clipboard?.writeText(linky);
            })}
          >
            Copy URL
          </CtxItem>
        </>
      )}
      <CtxSep />
      <CtxItem
        onClick={run(() => dispatch({ type: "removeItems", ids: [item.id] }))}
        kbd="⌫"
      >
        Delete
      </CtxItem>
    </div>
  );
};

const CtxItem = ({
  children,
  onClick,
  kbd,
}: {
  children: React.ReactNode;
  onClick: () => void;
  kbd?: string;
}) => (
  <button
    onClick={onClick}
    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    style={{
      display: "flex",
      alignItems: "center",
      width: "100%",
      padding: "6px 10px",
      textAlign: "left",
      gap: 16,
    }}
  >
    <span style={{ flex: 1 }}>{children}</span>
    {kbd && (
      <span style={{ color: "var(--text-3)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        {kbd}
      </span>
    )}
  </button>
);

const CtxSep = () => (
  <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
);

const rectsIntersect = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) =>
  !(
    a.x + a.w < b.x ||
    b.x + b.w < a.x ||
    a.y + a.h < b.y ||
    b.y + b.h < a.y
  );
