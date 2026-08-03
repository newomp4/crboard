// Infinite canvas. The world is a single absolutely-positioned div with a
// CSS transform applied. Items live inside it at world coordinates.
//
// Why CSS transforms instead of a real <canvas>: we need to host iframes
// (Instagram, YouTube, TikTok). A <canvas> can only paint pixels — it can't
// embed live web content. CSS transforms give us pan/zoom for free while
// keeping items as real DOM elements.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Action, State } from "./store";
import { noteTextColor } from "./store";
import type { Item, ItemDraft, Stroke } from "./types";
import { ItemView } from "./Item";
import { clampZoom, fitToBounds, screenToWorld, zoomAt } from "./coords";
import { animateView, cancelViewAnim } from "./viewAnim";
import { smoothPathD, thinPoints } from "./smooth";
import type { Guide } from "./snap";

type Props = {
  state: State;
  dispatch: React.Dispatch<Action>;
};

// Screen-space rectangle for the rubber-band selection overlay.
type Rect = { x: number; y: number; w: number; h: number };

export const Canvas = ({ state, dispatch }: Props) => {
  const { board, selection, tool, editId, pen } = state;
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest committed view, read by keyboard-triggered camera tweens (their
  // effect isn't re-subscribed on every pan, so board.view would be stale).
  const viewRef = useRef(board.view);
  viewRef.current = board.view;

  // Smooth wheel/trackpad zoom. Each wheel tick nudges a target zoom; a rAF loop
  // eases the actual zoom toward it (cursor-anchored), so zooming glides instead
  // of snapping tick-to-tick. cancelZoom stops it when the user pans or a camera
  // tween takes over.
  const zoomAnimRef = useRef<{
    target: number;
    cursor: { x: number; y: number };
    raf: number | null;
  }>({ target: board.view.zoom, cursor: { x: 0, y: 0 }, raf: null });
  const cancelZoom = () => {
    const za = zoomAnimRef.current;
    if (za.raf != null) {
      cancelAnimationFrame(za.raf);
      za.raf = null;
    }
  };
  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  // Right-click context menu, anchored at screen coords.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    itemId: string;
  } | null>(null);
  // Connector tool drag-in-progress.
  const [connectorDrag, setConnectorDrag] = useState<{
    sourceId: string;
    cursorScreen: { x: number; y: number };
    hoverTargetId: string | null;
  } | null>(null);
  // Active alignment guides during a drag (set by Item.tsx via callback).
  const [snapGuides, setSnapGuides] = useState<{
    x: Guide | null;
    y: Guide | null;
  } | null>(null);

  // In-progress drawing stroke. Stored separately from the board so we don't
  // reduce on every mousemove — only when the stroke ends.
  const [activeStroke, setActiveStroke] = useState<{
    points: { x: number; y: number }[];
    color: string;
    width: number;
  } | null>(null);

  // Rubber-band preview while drawing a shape with the shape tool (world coords).
  const [shapeDraft, setShapeDraft] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
    kind: "rect" | "ellipse" | "note";
  } | null>(null);

  // Live "W × H" / position readout that follows the cursor during a
  // resize/move. Set by Item.tsx (and MultiSelection) via callback; cleared on
  // pointer-up. Rendered as a small HUD chip near the cursor.
  const [measure, setMeasure] = useState<{
    label: string;
    x: number;
    y: number;
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

      // Reset / fit zoom. Glide the camera rather than snapping.
      if (mod && e.key === "0") {
        e.preventDefault();
        animateView(viewRef.current, { x: 0, y: 0, zoom: 1 }, (v) =>
          dispatch({ type: "setView", view: v }),
        );
        return;
      }
      if (mod && e.key === "1") {
        e.preventDefault();
        const el = containerRef.current;
        if (!el || state.board.items.length === 0) return;
        const r = el.getBoundingClientRect();
        animateView(
          viewRef.current,
          fitToBounds(state.board.items, r.width, r.height),
          (v) => dispatch({ type: "setView", view: v }),
        );
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
        animateView(viewRef.current, fitToBounds(sel, r.width, r.height), (v) =>
          dispatch({ type: "setView", view: v }),
        );
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
      // Direct input wins over any in-flight camera tween.
      cancelViewAnim();
      const rect = el.getBoundingClientRect();
      const cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      if (e.ctrlKey || e.metaKey) {
        // Accumulate onto the running target (so fast ticks add up), then ease.
        const za = zoomAnimRef.current;
        const base = za.raf != null ? za.target : viewRef.current.zoom;
        za.target = clampZoom(base * Math.exp(-e.deltaY * 0.01));
        za.cursor = cursor;
        if (za.raf == null) {
          const step = () => {
            const cur = viewRef.current;
            const diff = za.target - cur.zoom;
            if (Math.abs(diff) < 0.001) {
              dispatch({ type: "setView", view: zoomAt(cur, za.cursor, za.target) });
              za.raf = null;
              return;
            }
            dispatch({
              type: "setView",
              view: zoomAt(cur, za.cursor, cur.zoom + diff * 0.35),
            });
            za.raf = requestAnimationFrame(step);
          };
          za.raf = requestAnimationFrame(step);
        }
      } else {
        cancelZoom();
        const v = viewRef.current;
        dispatch({
          type: "setView",
          view: { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY },
        });
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      cancelZoom();
    };
    // viewRef.current keeps this handler reading the live view, so it never
    // needs re-subscribing on pan/zoom — attach once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Pan: space held, or middle mouse, or right mouse.
    if (spaceDown || e.button === 1 || e.button === 2) {
      e.preventDefault();
      cancelViewAnim();
      cancelZoom();
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

    // Connector tool: pointerdown on an item starts a connector drag.
    if (tool === "connector") {
      const el = e.target as HTMLElement;
      const sourceEl = el?.closest?.("[data-item-id]") as HTMLElement | null;
      const sourceId = sourceEl?.getAttribute("data-item-id");
      if (!sourceId) return; // empty-canvas click in connector mode = noop
      e.preventDefault();
      setConnectorDrag({
        sourceId,
        cursorScreen: { x: screen.x, y: screen.y },
        hoverTargetId: null,
      });
      const onMove = (ev: PointerEvent) => {
        const r = containerRef.current!.getBoundingClientRect();
        const cs = { x: ev.clientX - r.left, y: ev.clientY - r.top };
        const overEl = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest?.("[data-item-id]") as HTMLElement | null;
        const overId = overEl?.getAttribute("data-item-id") ?? null;
        setConnectorDrag({
          sourceId,
          cursorScreen: cs,
          hoverTargetId: overId && overId !== sourceId ? overId : null,
        });
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const overEl = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest?.("[data-item-id]") as HTMLElement | null;
        const targetId = overEl?.getAttribute("data-item-id");
        setConnectorDrag(null);
        if (targetId && targetId !== sourceId) {
          // Reducer will compute the real bbox via reconcileConnectors.
          dispatch({
            type: "addItem",
            item: {
              type: "connector",
              from: sourceId,
              to: targetId,
              color: state.connector.color,
              strokeWidth: state.connector.width,
              shape: state.connector.shape,
              ends: state.connector.ends,
              x: 0,
              y: 0,
              w: 0,
              h: 0,
            },
          });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    if (tool === "shape") {
      // Drag to draw a rectangle/ellipse/sticky note. A tiny drag (basically a
      // click) drops one at a comfortable default size centered on the cursor.
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const startWorld = world;
      let curWorld = world;
      const s = state.shape;
      const box = () => ({
        x: Math.min(startWorld.x, curWorld.x),
        y: Math.min(startWorld.y, curWorld.y),
        w: Math.abs(curWorld.x - startWorld.x),
        h: Math.abs(curWorld.y - startWorld.y),
      });
      setShapeDraft({ ...box(), kind: s.kind });
      const onMove = (ev: PointerEvent) => {
        const r = containerRef.current!.getBoundingClientRect();
        curWorld = screenToWorld(
          { x: ev.clientX - r.left, y: ev.clientY - r.top },
          board.view,
        );
        setShapeDraft({ ...box(), kind: s.kind });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setShapeDraft(null);
        let b = box();
        if (b.w < 8 && b.h < 8) {
          const dw = s.kind === "note" ? 180 : 160;
          const dh = s.kind === "note" ? 130 : 110;
          b = { x: startWorld.x - dw / 2, y: startWorld.y - dh / 2, w: dw, h: dh };
        } else {
          b = { ...b, w: Math.max(24, b.w), h: Math.max(24, b.h) };
        }
        const common = {
          fill: s.fill,
          stroke: s.stroke,
          strokeWidth: s.strokeWidth,
          x: b.x,
          y: b.y,
          w: b.w,
          h: b.h,
        };
        if (s.kind === "note") {
          dispatch({
            type: "addItem",
            edit: true,
            item: {
              type: "shape",
              shape: "note",
              ...common,
              text: "",
              textColor: noteTextColor(s.fill),
              fontSize: 16,
            },
          });
        } else {
          dispatch({
            type: "addItem",
            item: { type: "shape", shape: s.kind, ...common },
          });
        }
        if (!state.toolLocked) dispatch({ type: "setTool", tool: "select" });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

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
      // Only revert to select tool when the user hasn't locked the text tool
      // (locked = double-clicked the toolbar button to "stay in tool" mode).
      if (!state.toolLocked) {
        dispatch({ type: "setTool", tool: "select" });
      }
      return;
    }

    if (tool === "pen") {
      // Alt + pen = eraser: drag through drawings to delete them. Hit-tests
      // each drawing's bbox against the cursor's world position; intersecting
      // drawing items get removed in one undoable batch.
      if (e.altKey) {
        e.preventDefault();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        let committed = false;
        const erase = (sx: number, sy: number) => {
          const r = containerRef.current!.getBoundingClientRect();
          const w = screenToWorld(
            { x: sx - r.left, y: sy - r.top },
            board.view,
          );
          const ids: string[] = [];
          for (const it of state.board.items) {
            if (it.type !== "drawing") continue;
            if (
              w.x >= it.x &&
              w.x <= it.x + it.w &&
              w.y >= it.y &&
              w.y <= it.y + it.h
            ) {
              ids.push(it.id);
            }
          }
          if (ids.length === 0) return;
          if (!committed) {
            dispatch({ type: "commitHistory" });
            committed = true;
          }
          dispatch({ type: "removeItems", ids });
        };
        erase(e.clientX, e.clientY);
        const onMove = (ev: PointerEvent) => erase(ev.clientX, ev.clientY);
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }

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
    const w = maxX - minX;
    const h = maxY - minY;
    const drawing: ItemDraft = {
      type: "drawing",
      x: minX,
      y: minY,
      w,
      h,
      // Pin the authoring size so resizing scales the strokes to fill the box.
      vw: w,
      vh: h,
      strokes: [stroke],
    };
    dispatch({ type: "addItem", item: drawing });
  };

  // Cursor reflects the active mode.
  let cursor = "default";
  if (panning) cursor = "grabbing";
  else if (spaceDown) cursor = "grab";
  else if (tool === "pen") cursor = "crosshair";
  else if (tool === "connector") cursor = "crosshair";
  else if (tool === "shape") cursor = "crosshair";
  else if (tool === "text") cursor = "text";

  return (
    <div
      ref={containerRef}
      onPointerDown={onCanvasPointerDown}
      onDoubleClick={(e) => {
        // Double-click empty canvas (select tool) drops a new text note right
        // where you clicked, ready to type. Ignore double-clicks that land on
        // an item — those have their own behaviour (edit text / engage embed).
        if (tool !== "select") return;
        if ((e.target as HTMLElement).closest("[data-item-id]")) return;
        if (!containerRef.current) return;
        const r = containerRef.current.getBoundingClientRect();
        const w = screenToWorld(
          { x: e.clientX - r.left, y: e.clientY - r.top },
          board.view,
        );
        dispatch({
          type: "addItem",
          edit: true,
          item: {
            type: "text",
            x: w.x - 110,
            y: w.y - 24,
            w: 220,
            h: 80,
            text: "",
            fontSize: 16,
          },
        });
      }}
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
        {board.items
          .filter((it) => it.type !== "connector")
          .map((it) => (
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
              onSnapGuides={setSnapGuides}
              onMeasure={setMeasure}
              dispatch={dispatch}
            />
          ))}

        {/* Group bounding box + 8 handles when 2+ items are selected. */}
        {selection.size > 1 && (
          <MultiSelection
            items={board.items.filter(
              (it) => selection.has(it.id) && it.type !== "connector",
            )}
            view={board.view}
            onMeasure={setMeasure}
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

        {/* Shape-draw preview: dashed outline of the shape being dragged out. */}
        {shapeDraft && (shapeDraft.w > 0 || shapeDraft.h > 0) && (
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
            {shapeDraft.kind === "ellipse" ? (
              <ellipse
                cx={shapeDraft.x + shapeDraft.w / 2}
                cy={shapeDraft.y + shapeDraft.h / 2}
                rx={shapeDraft.w / 2}
                ry={shapeDraft.h / 2}
                fill="var(--overlay-tint)"
                stroke="var(--selection)"
                strokeWidth={1}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <rect
                x={shapeDraft.x}
                y={shapeDraft.y}
                width={shapeDraft.w}
                height={shapeDraft.h}
                rx={shapeDraft.kind === "note" ? 4 : 0}
                fill="var(--overlay-tint)"
                stroke="var(--selection)"
                strokeWidth={1}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        )}

        {/* Alignment guides (in world coords). non-scaling-stroke keeps
            line width pixel-constant regardless of zoom. */}
        {snapGuides && (snapGuides.x || snapGuides.y) && (
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
            {snapGuides.x && (
              <line
                x1={snapGuides.x.pos}
                x2={snapGuides.x.pos}
                y1={
                  Math.min(...snapGuides.x.spans.map((b) => b.y)) - 50
                }
                y2={
                  Math.max(...snapGuides.x.spans.map((b) => b.y + b.h)) + 50
                }
                stroke="var(--selection)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="4 3"
              />
            )}
            {snapGuides.y && (
              <line
                y1={snapGuides.y.pos}
                y2={snapGuides.y.pos}
                x1={
                  Math.min(...snapGuides.y.spans.map((b) => b.x)) - 50
                }
                x2={
                  Math.max(...snapGuides.y.spans.map((b) => b.x + b.w)) + 50
                }
                stroke="var(--selection)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray="4 3"
              />
            )}
          </svg>
        )}
      </div>

      {/* Connector layer — SVG rendered in SCREEN coords above the world.
          Drawing in screen coords keeps stroke widths and arrowhead sizes
          constant regardless of zoom. */}
      <ConnectorLayer
        items={board.items}
        selection={selection}
        view={board.view}
        connectorDrag={connectorDrag}
        tool={tool}
        dispatch={dispatch}
      />

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

      {/* Live dimension / position readout that trails the cursor mid-gesture. */}
      {measure && (
        <div
          className="cr-measure"
          style={{ left: measure.x + 16, top: measure.y + 18 }}
        >
          {measure.label}
        </div>
      )}
    </div>
  );
};

// ---------- connectors ----------

// Draws all connectors as SVG lines + arrowheads, plus the in-progress
// preview line while the user is mid-connector-drag.
//
// We render in SCREEN coords (a viewport-sized SVG sitting above the world
// transform) and project endpoints with the current view. Two reasons:
//   - stroke width and arrowhead size stay constant regardless of zoom
//   - hit testing is straightforward because positions are real pixels
const ConnectorLayer = ({
  items,
  selection,
  view,
  connectorDrag,
  tool,
  dispatch,
}: {
  items: Item[];
  selection: Set<string>;
  view: { x: number; y: number; zoom: number };
  connectorDrag: {
    sourceId: string;
    cursorScreen: { x: number; y: number };
    hoverTargetId: string | null;
  } | null;
  tool: string;
  dispatch: React.Dispatch<Action>;
}) => {
  const byId = new Map(items.map((it) => [it.id, it]));
  const connectors = items.filter(
    (it): it is Extract<Item, { type: "connector" }> =>
      it.type === "connector",
  );

  const svgRef = useRef<SVGSVGElement>(null);
  // Re-routing a connector by dragging one of its endpoint handles onto another
  // item. Only offered when a single connector is selected in the select tool.
  const [rerouting, setRerouting] = useState<{
    id: string;
    end: "from" | "to";
    cursor: { x: number; y: number }; // svg-space
    hoverId: string | null;
  } | null>(null);

  // Project a world point to screen pixels.
  const proj = (wx: number, wy: number) => ({
    x: wx * view.zoom + view.x,
    y: wy * view.zoom + view.y,
  });

  // Endpoints clipped at each item's bbox edge.
  const clippedScreen = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => {
    const fc = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const tc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const exit = rayBoxExit(fc, { x: tc.x - fc.x, y: tc.y - fc.y }, a);
    const entry = rayBoxExit(tc, { x: fc.x - tc.x, y: fc.y - tc.y }, b);
    const e1 = proj(exit.x, exit.y);
    const e2 = proj(entry.x, entry.y);
    return { x1: e1.x, y1: e1.y, x2: e2.x, y2: e2.y };
  };

  // Source center for the in-progress preview.
  const previewLine = (() => {
    if (!connectorDrag) return null;
    const src = byId.get(connectorDrag.sourceId);
    if (!src) return null;
    const sc = proj(src.x + src.w / 2, src.y + src.h / 2);
    return {
      x1: sc.x,
      y1: sc.y,
      x2: connectorDrag.cursorScreen.x,
      y2: connectorDrag.cursorScreen.y,
    };
  })();

  // The single selected connector, if any — gets draggable endpoint handles.
  const selId = selection.size === 1 ? [...selection][0] : null;
  const selectedConnector =
    tool === "select"
      ? connectors.find((c) => c.id === selId) ?? null
      : null;

  // Start dragging one end of a connector to re-attach it to another item.
  // Reuses elementFromPoint hit-testing (same as drawing a new connector).
  const startReroute = (
    c: Extract<Item, { type: "connector" }>,
    end: "from" | "to",
    e: React.PointerEvent,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const toSvg = (cx: number, cy: number) => {
      const r = svg.getBoundingClientRect();
      return { x: cx - r.left, y: cy - r.top };
    };
    // The opposite end's item — attaching both ends to it would be a self-loop
    // the reducer discards, so we never highlight or accept it as a target.
    const otherId = end === "from" ? c.to : c.from;
    const hitAt = (cx: number, cy: number) => {
      const el = document
        .elementFromPoint(cx, cy)
        ?.closest?.("[data-item-id]") as HTMLElement | null;
      const id = el?.getAttribute("data-item-id") ?? null;
      return id && id !== otherId ? id : null;
    };
    setRerouting({ id: c.id, end, cursor: toSvg(e.clientX, e.clientY), hoverId: null });
    const onMove = (ev: PointerEvent) => {
      setRerouting({
        id: c.id,
        end,
        cursor: toSvg(ev.clientX, ev.clientY),
        hoverId: hitAt(ev.clientX, ev.clientY),
      });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const targetId = hitAt(ev.clientX, ev.clientY);
      setRerouting(null);
      const currentId = end === "from" ? c.from : c.to;
      if (targetId && targetId !== currentId) {
        dispatch({ type: "commitHistory" });
        dispatch({
          type: "updateItem",
          id: c.id,
          patch: { [end]: targetId } as Partial<Item>,
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        inset: 0,
        // Lines themselves accept clicks (for selection) but the SVG element
        // shouldn't block clicks where there's no line.
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <defs>
        {/* auto-start-reverse lets one marker serve both ends: it flips at the
            start so a "both ends" connector gets arrowheads pointing outward. */}
        <marker
          id="cr-arrow"
          markerUnits="userSpaceOnUse"
          markerWidth="14"
          markerHeight="14"
          refX="12"
          refY="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 12 7 L 0 13 Z" fill="currentColor" />
        </marker>
        <marker
          id="cr-arrow-active"
          markerUnits="userSpaceOnUse"
          markerWidth="14"
          markerHeight="14"
          refX="12"
          refY="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 12 7 L 0 13 Z" fill="var(--selection)" />
        </marker>
      </defs>

      {/* Hover-target highlight while drawing a connector. */}
      {connectorDrag?.hoverTargetId &&
        (() => {
          const t = byId.get(connectorDrag.hoverTargetId);
          if (!t) return null;
          const tl = proj(t.x, t.y);
          return (
            <rect
              x={tl.x - 2}
              y={tl.y - 2}
              width={t.w * view.zoom + 4}
              height={t.h * view.zoom + 4}
              fill="none"
              stroke="var(--selection)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          );
        })()}

      {connectors.map((c) => {
        const a = byId.get(c.from);
        const b = byId.get(c.to);
        if (!a || !b) return null;
        const { x1, y1, x2, y2 } = clippedScreen(a, b);
        const isSelected = selection.has(c.id);
        const cw = c.strokeWidth ?? 1.75;
        const d = connectorPath(c.shape ?? "straight", x1, y1, x2, y2);
        const ends = c.ends ?? "one";
        const marker = isSelected ? "url(#cr-arrow-active)" : "url(#cr-arrow)";
        return (
          <g
            key={c.id}
            style={{
              color: isSelected
                ? "var(--selection)"
                : c.color ?? "var(--text-2)",
              // Fade the line while its endpoint is being dragged; the dashed
              // preview + handle show where it's headed.
              opacity: rerouting?.id === c.id ? 0.4 : 1,
            }}
          >
            {/* Wide invisible "hit" path for easier clicking — only in select mode. */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              style={{
                // Suppressed during a reroute drag so the connector's own
                // hit-path doesn't shadow the item under the cursor.
                pointerEvents: tool === "select" && !rerouting ? "stroke" : "none",
                cursor: "pointer",
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                dispatch(
                  e.shiftKey
                    ? { type: "selectToggle", id: c.id }
                    : { type: "selectOnly", ids: [c.id] },
                );
              }}
            />
            <path
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={isSelected ? cw + 0.9 : cw}
              strokeLinejoin="round"
              strokeLinecap="round"
              markerEnd={ends === "none" ? undefined : marker}
              markerStart={ends === "both" ? marker : undefined}
              style={{ pointerEvents: "none" }}
            />
          </g>
        );
      })}

      {/* Endpoint handles for the selected connector — drag to re-attach. */}
      {selectedConnector &&
        (() => {
          const a = byId.get(selectedConnector.from);
          const b = byId.get(selectedConnector.to);
          if (!a || !b) return null;
          const { x1, y1, x2, y2 } = clippedScreen(a, b);
          const isR = rerouting?.id === selectedConnector.id;
          const fromPt =
            isR && rerouting!.end === "from" ? rerouting!.cursor : { x: x1, y: y1 };
          const toPt =
            isR && rerouting!.end === "to" ? rerouting!.cursor : { x: x2, y: y2 };
          // While dragging, preview a dashed line from the anchored item's
          // centre to the cursor, and outline the item it would attach to.
          const anchor = isR ? (rerouting!.end === "from" ? b : a) : null;
          const anchorC = anchor
            ? proj(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2)
            : null;
          const hoverT = rerouting?.hoverId ? byId.get(rerouting.hoverId) : null;
          return (
            <>
              {isR && anchorC && (
                <line
                  x1={anchorC.x}
                  y1={anchorC.y}
                  x2={rerouting!.cursor.x}
                  y2={rerouting!.cursor.y}
                  stroke="var(--selection)"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  style={{ pointerEvents: "none" }}
                />
              )}
              {hoverT && (
                <rect
                  x={proj(hoverT.x, hoverT.y).x - 2}
                  y={proj(hoverT.x, hoverT.y).y - 2}
                  width={hoverT.w * view.zoom + 4}
                  height={hoverT.h * view.zoom + 4}
                  fill="none"
                  stroke="var(--selection)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  style={{ pointerEvents: "none" }}
                />
              )}
              {([["from", fromPt], ["to", toPt]] as const).map(([end, pt]) => (
                <circle
                  key={end}
                  cx={pt.x}
                  cy={pt.y}
                  r={5}
                  fill="var(--bg)"
                  stroke="var(--selection)"
                  strokeWidth={1.5}
                  // While dragging, the handle sits under the cursor — make it
                  // click-through so elementFromPoint can see the item beneath.
                  style={{ pointerEvents: isR ? "none" : "all", cursor: "grab" }}
                  onPointerDown={(e) => startReroute(selectedConnector, end, e)}
                />
              ))}
            </>
          );
        })()}

      {/* In-progress preview line (dashed). */}
      {previewLine && (
        <line
          x1={previewLine.x1}
          y1={previewLine.y1}
          x2={previewLine.x2}
          y2={previewLine.y2}
          stroke="var(--text-2)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
};

// Build the SVG path "d" for a connector between two screen points, per shape:
//   straight — a direct line
//   curved   — a cubic bezier whose tangents leave each end along the dominant
//              axis, so it bows smoothly (horizontal-ish links curve sideways)
//   elbow    — a right-angle route that steps across the midpoint
const connectorPath = (
  shape: "straight" | "curved" | "elbow",
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (shape === "curved") {
    if (Math.abs(dx) >= Math.abs(dy)) {
      const cx1 = x1 + dx * 0.5;
      const cx2 = x2 - dx * 0.5;
      return `M ${x1} ${y1} C ${cx1} ${y1} ${cx2} ${y2} ${x2} ${y2}`;
    }
    const cy1 = y1 + dy * 0.5;
    const cy2 = y2 - dy * 0.5;
    return `M ${x1} ${y1} C ${x1} ${cy1} ${x2} ${cy2} ${x2} ${y2}`;
  }
  if (shape === "elbow") {
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = (x1 + x2) / 2;
      return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
    }
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} L ${x2} ${y2}`;
};

// Cast a ray from a point inside an axis-aligned bbox toward a direction;
// return the point at which the ray exits the bbox. Used to clip a connector
// line so its tip emerges from the item's edge instead of its centre.
const rayBoxExit = (
  start: { x: number; y: number },
  dir: { x: number; y: number },
  box: { x: number; y: number; w: number; h: number },
) => {
  const tx =
    dir.x > 0
      ? (box.x + box.w - start.x) / dir.x
      : dir.x < 0
        ? (box.x - start.x) / dir.x
        : Infinity;
  const ty =
    dir.y > 0
      ? (box.y + box.h - start.y) / dir.y
      : dir.y < 0
        ? (box.y - start.y) / dir.y
        : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  return { x: start.x + dir.x * t, y: start.y + dir.y * t };
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
  onMeasure,
  dispatch,
}: {
  items: Item[];
  view: { x: number; y: number; zoom: number };
  onMeasure: (m: { label: string; x: number; y: number } | null) => void;
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

    // Pin the resize cursor for the whole gesture (see Item.tsx for rationale).
    const groupCursors: Record<HandlePosLong, string> = {
      tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize",
      t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize",
    };
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = groupCursors[handle];
    document.body.style.userSelect = "none";

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
      onMeasure({
        label: `${Math.round(nw)} × ${Math.round(nh)}`,
        x: ev.clientX,
        y: ev.clientY,
      });
    };
    const onUp = () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      onMeasure(null);
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
  const DOT = 10;
  const HIT = 18; // large transparent hit area → stable cursor, no flicker
  const RING = 3; // align dots onto the selection ring (outline-offset 2 + 1)
  const anchor = -HIT / 2 - RING;
  const isCorner = pos.length === 2;

  const wrap: React.CSSProperties = {
    position: "absolute",
    width: HIT,
    height: HIT,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: cursors[pos],
    pointerEvents: "auto",
    touchAction: "none",
  };

  if (isCorner) {
    if (pos.includes("t")) wrap.top = anchor;
    else wrap.bottom = anchor;
    if (pos.includes("l")) wrap.left = anchor;
    else wrap.right = anchor;
  } else if (pos === "t" || pos === "b") {
    wrap.left = "50%";
    wrap.transform = "translateX(-50%)";
    if (pos === "t") wrap.top = anchor;
    else wrap.bottom = anchor;
  } else {
    wrap.top = "50%";
    wrap.transform = "translateY(-50%)";
    if (pos === "l") wrap.left = anchor;
    else wrap.right = anchor;
  }

  return (
    <div style={wrap} onPointerDown={onPointerDown}>
      <div
        className="cr-pop"
        style={{
          width: DOT,
          height: DOT,
          background: "var(--surface-2)",
          border: "1.5px solid var(--selection)",
          borderRadius: 3,
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.18)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
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
      className="glass cr-menu"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: x,
        top: y,
        minWidth: 184,
        padding: 6,
        zIndex: 2000,
        fontSize: 13,
        transformOrigin: "top left",
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
    className="chrome-btn"
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
      borderRadius: "var(--radius-sm)",
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
