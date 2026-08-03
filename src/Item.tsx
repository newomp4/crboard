// Renders a single item on the canvas. Handles selection chrome, drag-to-move,
// corner-handle resize, and dispatches double-click → edit for text.
//
// All math is done in WORLD coordinates. Mouse deltas come in as screen pixels
// and we divide by the current zoom to get world units.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Item, View } from "./types";
import type { Action } from "./store";
import { detectEmbed } from "./embeds";
import { VideoBody } from "./VideoBody";
import { computeSnap, type Guide } from "./snap";
import { renderMarkdown } from "./markdown";

type Props = {
  item: Item;
  selected: boolean;
  // When a multi-select is active, the group bounding box draws its own handles
  // and we hide the per-item handles to avoid two overlapping sets.
  suppressIndividualHandles?: boolean;
  autoEdit?: boolean;
  view: View;
  tool: "select" | "text" | "pen" | "connector" | "shape";
  // Needed for multi-drag: the drag handler captures origin positions of
  // every selected item at gesture start so they all move together.
  allItems: Item[];
  selectedIds: string[];
  // Right-click handler. Canvas opens a small action menu at (clientX, clientY).
  onContextMenu?: (itemId: string, clientX: number, clientY: number) => void;
  // Reports active alignment guides during a drag so Canvas can render them.
  onSnapGuides?: (guides: { x: Guide | null; y: Guide | null } | null) => void;
  // Reports a live "W × H" / position readout during resize/move (null = clear).
  onMeasure?: (m: { label: string; x: number; y: number } | null) => void;
  dispatch: React.Dispatch<Action>;
};

const HANDLE_SIZE = 10; // visible dot
// Transparent hit area around each dot. Larger than the dot so the resize
// cursor has a stable zone — the old flush-to-dot hit box made the cursor
// flicker between resize/arrow on sub-pixel moves near a corner.
const HANDLE_HIT = 18;

// Resize cursor per handle position. Shared so startResize can pin this cursor
// on <body> for the whole drag (otherwise the cursor flickers as the pointer
// passes over the item, canvas, and other handles mid-resize).
type HandlePosT = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";
const RESIZE_CURSORS: Record<HandlePosT, string> = {
  tl: "nwse-resize",
  br: "nwse-resize",
  tr: "nesw-resize",
  bl: "nesw-resize",
  t: "ns-resize",
  b: "ns-resize",
  l: "ew-resize",
  r: "ew-resize",
};

// Minimum height for text items. Keeps short stickies large enough to grab
// reliably with a mouse — 48px works out to roughly two lines + padding.
const MIN_TEXT_H = 48;

export const ItemView = ({
  item,
  selected,
  suppressIndividualHandles,
  autoEdit,
  view,
  tool,
  allItems,
  selectedIds,
  onContextMenu,
  onSnapGuides,
  onMeasure,
  dispatch,
}: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // Live transform preview while scaling a text box by a corner. Dragging changes
  // this (a GPU transform, no reflow) for smoothness; the real fontSize/width is
  // committed once on release.
  const [textScale, setTextScale] = useState<{ s: number; origin: string } | null>(
    null,
  );
  const textCommitRef = useRef<{ x: number; y: number; w: number; fontSize: number } | null>(
    null,
  );
  // For embeds: double-click "engages" the iframe so clicks/drags inside reach
  // the embedded page (play, scrub, expand). Until then, the embed is locked
  // behind a transparent overlay so dragging the wrapper always moves it
  // instead of accidentally interacting with Twitter/YouTube/etc.
  const [interactive, setInteractive] = useState(false);

  // Text items and sticky notes both hold editable text via the same edit flow.
  const isEditableText =
    item.type === "text" || (item.type === "shape" && item.shape === "note");

  // When the store flags this item as the one to edit immediately (e.g. it
  // was just created via the text tool), drop into edit mode and clear the
  // flag so a re-render doesn't keep retriggering it.
  useEffect(() => {
    if (autoEdit && isEditableText) {
      setEditing(true);
      dispatch({ type: "setEditId", id: null });
    }
  }, [autoEdit, isEditableText, dispatch]);

  // Losing selection always exits edit/interactive mode — keeps the two
  // states in sync without a flicker.
  useEffect(() => {
    if (!selected) {
      setEditing(false);
      setInteractive(false);
    }
  }, [selected]);

  // Esc exits embed-interactive mode (text edit handles its own Esc inside
  // the textarea).
  useEffect(() => {
    if (!interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInteractive(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interactive]);

  const startMove = useCallback(
    (e: React.PointerEvent) => {
      if (tool !== "select") return;
      if (editing) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      // Shift-click toggles selection without dragging. Otherwise figure out
      // which items the gesture should drag together.
      if (e.shiftKey) {
        dispatch({ type: "selectToggle", id: item.id });
        return;
      }

      let dragIds: string[];
      if (selected) {
        // Drag whole current selection.
        dragIds = selectedIds.length > 0 ? selectedIds : [item.id];
      } else {
        // Replace selection with just this item, then drag it.
        dispatch({ type: "selectOnly", ids: [item.id] });
        dragIds = [item.id];
      }
      dispatch({ type: "bringToFront", id: item.id });

      // Capture origin positions for each dragged item AND the bbox of the
      // group at gesture start. The bbox is used by the alignment-snap math.
      const origins = new Map<string, { x: number; y: number; w: number; h: number }>();
      let bbMinX = Infinity,
        bbMinY = Infinity,
        bbMaxX = -Infinity,
        bbMaxY = -Infinity;
      for (const id of dragIds) {
        const it = allItems.find((i) => i.id === id);
        if (it) {
          origins.set(id, { x: it.x, y: it.y, w: it.w, h: it.h });
          if (it.x < bbMinX) bbMinX = it.x;
          if (it.y < bbMinY) bbMinY = it.y;
          if (it.x + it.w > bbMaxX) bbMaxX = it.x + it.w;
          if (it.y + it.h > bbMaxY) bbMaxY = it.y + it.h;
        }
      }
      const dragBbox = {
        x: bbMinX,
        y: bbMinY,
        w: bbMaxX - bbMinX,
        h: bbMaxY - bbMinY,
      };

      // Other-item bboxes for snap targets — exclude the items being dragged,
      // exclude connectors (their bbox is just the line bbox; not useful as a
      // snap target), and zero-size items.
      const dragSet = new Set(dragIds);
      const others = allItems
        .filter(
          (it) =>
            !dragSet.has(it.id) &&
            it.type !== "connector" &&
            it.w > 1 &&
            it.h > 1,
        )
        .map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h }));

      // 6 screen pixels worth of slack, converted to world units.
      const snapThreshold = 6 / view.zoom;

      let committed = false;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (ev: PointerEvent) => {
        const rawDx = (ev.clientX - startX) / view.zoom;
        const rawDy = (ev.clientY - startY) / view.zoom;
        if (rawDx === 0 && rawDy === 0) return;
        if (!committed) {
          dispatch({ type: "commitHistory" });
          committed = true;
        }
        // Run snap on the *would-be* new bbox.
        const candidate = {
          x: dragBbox.x + rawDx,
          y: dragBbox.y + rawDy,
          w: dragBbox.w,
          h: dragBbox.h,
        };
        const snap = computeSnap(candidate, others, snapThreshold);
        const dx = rawDx + snap.dx;
        const dy = rawDy + snap.dy;
        onSnapGuides?.({ x: snap.xGuide, y: snap.yGuide });
        const positions = dragIds.flatMap((id) => {
          const o = origins.get(id);
          return o ? [{ id, x: o.x + dx, y: o.y + dy }] : [];
        });
        dispatch({ type: "setItemPositions", positions });
        // Readout shows the grabbed item's new top-left in world coords.
        const self = origins.get(item.id);
        if (self) {
          onMeasure?.({
            label: `${Math.round(self.x + dx)}, ${Math.round(self.y + dy)}`,
            x: ev.clientX,
            y: ev.clientY,
          });
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onSnapGuides?.(null);
        onMeasure?.(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [
      tool,
      editing,
      selected,
      item,
      selectedIds,
      allItems,
      view.zoom,
      onSnapGuides,
      onMeasure,
      dispatch,
    ],
  );

  const startResize = useCallback(
    (handle: HandlePos) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      // Pin the resize cursor on <body> for the whole gesture so it can't
      // flicker as the pointer crosses the item/canvas/other handles.
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = RESIZE_CURSORS[handle];
      document.body.style.userSelect = "none";

      let committed = false;

      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { x: item.x, y: item.y, w: item.w, h: item.h };
      // Drawings can be legitimately small (a flat line), so don't force them
      // up to the 40px floor used for cards/media — that made resize feel jumpy.
      const minSize = item.type === "drawing" ? 12 : 40;
      const origFont = item.type === "text" ? item.fontSize || 16 : 0;

      // Aspect ratio is locked by default for images and embeds (stretching
      // either looks bad — Instagram has a fixed ratio, photos shouldn't
      // squish). Shift inverts the default.
      const lockByDefault =
        item.type === "image" || item.type === "embed" || item.type === "video";
      const aspect = orig.w / orig.h;

      // Decompose handle into anchors. The handle is the side(s) being
      // pulled; the *opposite* side stays fixed.
      const left = handle.includes("l");
      const right = handle.includes("r");
      const top = handle.includes("t");
      const bottom = handle.includes("b");

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / view.zoom;
        const dy = (ev.clientY - startY) / view.zoom;
        if (dx === 0 && dy === 0) return;
        if (!committed) {
          dispatch({ type: "commitHistory" });
          committed = true;
        }

        // Text corners UNIFORMLY SCALE the whole block — font, width, and height
        // grow together like scaling an image, with the opposite corner pinned.
        // Because width scales in lockstep with the font, the text reflows to the
        // same line count, so height scales by the same factor: we can predict it
        // (orig.h * scale) and anchor instantly, with no lag. Edge (l/r) handles
        // fall through to the plain width-reflow path below.
        if (item.type === "text" && (left || right) && (top || bottom)) {
          // Scale from whichever axis the corner was pulled along more, so both
          // horizontal and vertical drags grow the block.
          const rW = (right ? orig.w + dx : orig.w - dx) / orig.w;
          const rH = (bottom ? orig.h + dy : orig.h - dy) / orig.h;
          const scale = Math.max(0.15, Math.max(rW, rH));
          const nwT = Math.max(48, orig.w * scale);
          const nhT = orig.h * scale; // predicted (proportional) height
          const nf = Math.max(8, origFont * scale);
          const nxT = left ? orig.x + orig.w - nwT : orig.x;
          const nyT = top ? orig.y + orig.h - nhT : orig.y;
          // Preview with a transform (smooth, no reflow); commit on release.
          const s = nf / origFont;
          const origin = `${left ? "right" : "left"} ${top ? "bottom" : "top"}`;
          setTextScale({ s, origin });
          textCommitRef.current = { x: nxT, y: nyT, w: nwT, fontSize: nf };
          onMeasure?.({
            label: `${Math.round(nf)} px`,
            x: ev.clientX,
            y: ev.clientY,
          });
          return;
        }

        const locked = ev.shiftKey ? !lockByDefault : lockByDefault;

        // First compute unconstrained new dims based on which side is being pulled.
        let nw = orig.w;
        let nh = orig.h;
        if (left) nw = orig.w - dx;
        else if (right) nw = orig.w + dx;
        if (top) nh = orig.h - dy;
        else if (bottom) nh = orig.h + dy;
        nw = Math.max(minSize, nw);
        nh = Math.max(minSize, nh);

        if (locked) {
          const cornerHandle = (left || right) && (top || bottom);
          if (cornerHandle) {
            // Pick whichever dim changed more proportionally, derive the other.
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

        dispatch({
          type: "updateItem",
          id: item.id,
          patch: { x: nx, y: ny, w: nw, h: nh } as Partial<Item>,
        });
        onMeasure?.({
          label: `${Math.round(nw)} × ${Math.round(nh)}`,
          x: ev.clientX,
          y: ev.clientY,
        });
      };
      const onUp = () => {
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
        onMeasure?.(null);
        // Commit a text-corner scale: apply the real fontSize/width and drop the
        // transform preview in one render so there's no flash.
        const commit = textCommitRef.current;
        if (commit) {
          textCommitRef.current = null;
          dispatch({
            type: "updateItem",
            id: item.id,
            patch: commit as Partial<Item>,
          });
          setTextScale(null);
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [item, view.zoom, onMeasure, dispatch],
  );

  return (
    <div
      ref={ref}
      data-item-id={item.id}
      onPointerDown={startMove}
      onDoubleClick={() => {
        if (isEditableText) setEditing(true);
        else if (item.type === "embed" || item.type === "video") setInteractive(true);
      }}
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        e.stopPropagation();
        if (!selected) {
          dispatch({ type: "selectOnly", ids: [item.id] });
        }
        onContextMenu?.(item.id, e.clientX, e.clientY);
      }}
      // Belt-and-suspenders: even with draggable=false on every <a>/<img>, some
      // browsers still try to start a drag on the wrapper itself. Eat the event.
      onDragStart={(e) => e.preventDefault()}
      style={{
        position: "absolute",
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        zIndex: item.z,
        ...(textScale
          ? { transform: `scale(${textScale.s})`, transformOrigin: textScale.origin }
          : null),
      }}
      className={`crboard-item cr-item-in${selected ? " selection-ring" : ""}`}
    >
      <ItemBody
        item={item}
        selected={selected}
        editing={editing}
        interactive={interactive}
        setEditing={setEditing}
        dispatch={dispatch}
      />

      {selected &&
        tool === "select" &&
        !editing &&
        !suppressIndividualHandles && (
          <>
            {/* Text: left/right edges change WIDTH (text reflows, height
                auto-grows); corners SCALE the font (box grows both ways). No
                pure top/bottom handles — height is content-driven, so a raw
                height handle would just fight the auto-grow effect. */}
            {(item.type === "text"
              ? (["tl", "tr", "bl", "br", "l", "r"] as HandlePos[])
              : (["tl", "tr", "bl", "br", "t", "b", "l", "r"] as HandlePos[])
            ).map((p) => (
              <Handle key={p} pos={p} onPointerDown={startResize(p)} />
            ))}
          </>
        )}
    </div>
  );
};

type HandlePos = HandlePosT;

// Resize handle: a large transparent hit area (stable cursor zone) with a small
// visible dot centred inside. Anchored so the dot sits right on the item's
// corner/edge. Edges resize one dimension; corners resize both.
const Handle = ({
  pos,
  onPointerDown,
}: {
  pos: HandlePos;
  onPointerDown: (e: React.PointerEvent) => void;
}) => {
  const isCorner = pos.length === 2;
  // Selection ring is drawn at outline-offset 2px + 1px half-width = ~3px
  // outside the box. Push the dot centre out by the same amount so the handles
  // sit exactly on the visible ring instead of floating inside its corners.
  const RING = 3;
  const anchor = -HANDLE_HIT / 2 - RING;

  const wrap: React.CSSProperties = {
    position: "absolute",
    width: HANDLE_HIT,
    height: HANDLE_HIT,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: RESIZE_CURSORS[pos],
    // touchAction:none keeps the browser from intercepting pointer events on touch devices.
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
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
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

const ItemBody = ({
  item,
  selected,
  editing,
  interactive,
  setEditing,
  dispatch,
}: {
  item: Item;
  selected: boolean;
  editing: boolean;
  interactive: boolean;
  setEditing: (v: boolean) => void;
  dispatch: React.Dispatch<Action>;
}) => {
  switch (item.type) {
    case "text":
      return (
        <TextBody
          item={item}
          editing={editing}
          setEditing={setEditing}
          dispatch={dispatch}
        />
      );
    case "image":
      return (
        <img
          src={item.src}
          alt={item.alt ?? ""}
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            userSelect: "none",
            display: "block",
            background: "var(--bg)",
          }}
        />
      );
    case "embed":
      return <EmbedBody item={item} interactive={interactive} />;
    case "video":
      return <VideoBody item={item} interactive={interactive} dispatch={dispatch} />;
    case "link":
      return <LinkBody item={item} selected={selected} />;
    case "drawing":
      return <DrawingBody item={item} />;
    case "shape":
      return (
        <ShapeBody
          item={item}
          editing={editing}
          setEditing={setEditing}
          dispatch={dispatch}
        />
      );
    case "connector":
      // Connectors render in a dedicated SVG layer, not inside an item wrapper.
      return null;
  }
};

// Rectangle / ellipse / sticky note. Rect + ellipse are pure SVG fills. A note
// is a filled card that also holds centered text — double-click to edit (a plain
// textarea; the card size is fixed, so text wraps/clips instead of auto-growing).
const ShapeBody = ({
  item,
  editing,
  setEditing,
  dispatch,
}: {
  item: Extract<Item, { type: "shape" }>;
  editing: boolean;
  setEditing: (v: boolean) => void;
  dispatch: React.Dispatch<Action>;
}) => {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [editing]);

  const geom = (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${item.w} ${item.h}`}
      preserveAspectRatio="none"
      style={{ display: "block", position: "absolute", inset: 0 }}
    >
      {item.shape === "ellipse" ? (
        <ellipse
          cx={item.w / 2}
          cy={item.h / 2}
          rx={Math.max(0, item.w / 2 - item.strokeWidth / 2)}
          ry={Math.max(0, item.h / 2 - item.strokeWidth / 2)}
          fill={item.fill}
          stroke={item.stroke}
          strokeWidth={item.strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <rect
          x={item.strokeWidth / 2}
          y={item.strokeWidth / 2}
          width={Math.max(0, item.w - item.strokeWidth)}
          height={Math.max(0, item.h - item.strokeWidth)}
          rx={item.shape === "note" ? 6 : 0}
          fill={item.fill}
          stroke={item.stroke}
          strokeWidth={item.strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );

  if (item.shape !== "note") return geom;

  // Sticky note: geometry + centered text overlay.
  const textStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    padding: 12,
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    fontSize: item.fontSize ?? 16,
    lineHeight: 1.3,
    color: item.textColor ?? "#0a0a0a",
    fontFamily: "inherit",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  return (
    <>
      {geom}
      {editing ? (
        <textarea
          ref={taRef}
          className="cr-note-input"
          value={item.text ?? ""}
          placeholder="Type…"
          spellCheck
          onChange={(e) =>
            dispatch({
              type: "updateItem",
              id: item.id,
              patch: { text: e.target.value } as Partial<Item>,
            })
          }
          onBlur={() => setEditing(false)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "Enter")) {
              e.preventDefault();
              taRef.current?.blur();
            }
          }}
          style={{
            ...textStyle,
            background: "transparent",
            border: "none",
            outline: "none",
            resize: "none",
            cursor: "text",
            // Match the view div's vertical centering so the text doesn't jump
            // when entering/leaving edit. `align-content` centers a textarea's
            // own content in modern browsers; older ones fall back to top.
            display: "block",
            alignContent: "center",
            textAlignLast: "center",
          }}
        />
      ) : (
        <div style={{ ...textStyle, pointerEvents: "none" }}>{item.text}</div>
      )}
    </>
  );
};

// Text items use a real <textarea> rather than contenteditable. Reasons:
//   - Pasting into contenteditable smuggles in HTML/styles. Textarea is plain.
//   - Native textarea behavior (Enter, Tab, IME composition) is just better.
//   - Auto-grow is a one-line trick on textarea (set height = scrollHeight).
//
// We let the height of the *item* track the content. The user can still set a
// width via the left/right edge handles; the height fits the text.
// Two presentations:
//   - editing: a real <textarea> with the raw markdown source.
//   - viewing: a <div> containing the rendered markdown HTML.
// Auto-grow measures whichever element is currently mounted. Switching between
// the two can cause a small height jump (a "# Heading" raw line is shorter
// than the rendered h1) — that's intentional: the box always fits whatever
// you're looking at. Click outside to leave edit mode and see the formatting.
const TextBody = ({
  item,
  editing,
  setEditing,
  dispatch,
}: {
  item: Extract<Item, { type: "text" }>;
  editing: boolean;
  setEditing: (v: boolean) => void;
  dispatch: React.Dispatch<Action>;
}) => {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  // Auto-grow: pick the active element and feed its measured height back as
  // item.h. Always restore textarea inline height to "100%" after the temporary
  // "auto" measurement (otherwise React's reconciler doesn't sync the DOM and
  // the textarea ends up stuck at the browser's default rows height, which
  // visually clips content — this was the "text spills out of the box" bug).
  useLayoutEffect(() => {
    let measured: number;
    if (editing) {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      const cs = window.getComputedStyle(ta);
      const borderY =
        (parseFloat(cs.borderTopWidth) || 0) +
        (parseFloat(cs.borderBottomWidth) || 0);
      measured = Math.max(
        MIN_TEXT_H,
        Math.ceil(ta.scrollHeight + borderY),
      );
      ta.style.height = "100%";
      ta.scrollTop = 0;
    } else {
      const v = viewRef.current;
      if (!v) return;
      // offsetHeight already includes padding + border on the rendered div.
      measured = Math.max(MIN_TEXT_H, Math.ceil(v.offsetHeight));
    }
    if (Math.abs(measured - item.h) > 0.5) {
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { h: measured } as Partial<Item>,
      });
    }
  }, [
    item.text,
    item.w,
    item.fontSize,
    item.fontWeight,
    item.h,
    item.id,
    editing,
    dispatch,
  ]);

  // Drop into editing → focus + place caret at end.
  useEffect(() => {
    if (editing && taRef.current) {
      const ta = taRef.current;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }
  }, [editing]);

  // Optional per-item styling (see TextItem). "transparent" bg drops the card
  // chrome entirely for a clean floating-label look.
  const transparentBg = item.bg === "transparent";
  const background = item.bg === undefined ? "var(--surface-2)" : item.bg;
  const border = transparentBg ? "1px solid transparent" : "1px solid var(--border)";

  // Shared font/box styling so the textarea and view div have the same metrics
  // (matters mostly for predictable wrapping when toggling edit/view).
  const baseStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    padding: 12,
    margin: 0,
    fontSize: item.fontSize,
    fontWeight: item.fontWeight ?? 400,
    lineHeight: 1.35,
    fontFamily: "inherit",
    textAlign: item.align ?? "left",
    color: item.color ?? "var(--text)",
    background,
    border,
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflow: "hidden",
  };

  if (editing) {
    return (
      <textarea
        ref={taRef}
        className="cr-text-input"
        value={item.text}
        readOnly={false}
        tabIndex={0}
        placeholder="Type something…"
        spellCheck
        onChange={(e) =>
          dispatch({
            type: "updateItem",
            id: item.id,
            patch: { text: e.target.value } as Partial<Item>,
          })
        }
        onBlur={() => setEditing(false)}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (
            e.key === "Escape" ||
            ((e.metaKey || e.ctrlKey) && e.key === "Enter")
          ) {
            e.preventDefault();
            taRef.current?.blur();
          }
        }}
        style={{
          ...baseStyle,
          outline: "none",
          resize: "none",
          cursor: "text",
          display: "block",
        }}
      />
    );
  }

  // View mode: rendered markdown. The .md-view class controls heading sizes,
  // code styling, list indent, etc. (see index.css). Pointerdown on an anchor
  // is allowed to bubble normally for navigation, but we stopPropagation so
  // the wrapper doesn't grab the click as a drag start.
  return (
    <div
      ref={viewRef}
      className="md-view"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("a")) e.stopPropagation();
      }}
      style={{ ...baseStyle, cursor: "default" }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
    />
  );
};

// Link cards mirror the embed pattern: visible source-link footer, click-to-focus
// overlay so first click selects (rather than navigating away). Once selected,
// click anywhere in the card to open. The native <a draggable=false> means the
// browser's "drag link out" gesture stops fighting our move handler.
const LinkBody = ({
  item,
  selected,
}: {
  item: Extract<Item, { type: "link" }>;
  selected: boolean;
}) => {
  let host = item.url;
  let path = "";
  try {
    const u = new URL(item.url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname + u.search;
  } catch {
    /* keep raw url as title */
  }
  const title = item.title || host;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 4,
          fontSize: 14,
        }}
      >
        <div
          style={{
            fontWeight: 600,
            color: "var(--text)",
            wordBreak: "break-word",
          }}
        >
          {title}
        </div>
        <div
          style={{
            color: "var(--text-3)",
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={item.url}
        >
          {host}
          {path && path !== "/" ? path : ""}
        </div>
      </div>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        draggable={false}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        title={item.url}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          fontSize: 11,
          color: "var(--text-2)",
          textDecoration: "none",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          Open original
        </span>
        <ExternalIcon />
      </a>
      {!selected && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            cursor: "pointer",
          }}
        />
      )}
    </div>
  );
};

// Embeds wrap an iframe with two affordances:
//   1. A transparent "click to interact" overlay that's ALWAYS on until the
//      user double-clicks to "engage" the embed (interactive=true). While
//      locked, every click on the embed is caught by the overlay so the
//      wrapper can select/drag/resize the item without the iframe stealing
//      the gesture (the old "click selects an embed once and then the iframe
//      hijacks every drag" problem).
//   2. A small footer showing the source URL, clickable, that always works.
const EmbedBody = ({
  item,
  interactive,
}: {
  item: Extract<Item, { type: "embed" }>;
  interactive: boolean;
}) => {
  const info = detectEmbed(item.url);
  const src = info?.embedUrl ?? item.url;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
        <iframe
          src={src}
          style={{
            width: "100%",
            height: "100%",
            border: 0,
            background: "var(--bg)",
            display: "block",
            // While locked, ignore the iframe entirely so no stray hover/drag
            // events leak into Twitter/YouTube/etc.
            pointerEvents: interactive ? "auto" : "none",
          }}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
        />
        {!interactive && (
          <div
            // The overlay both blocks iframe interaction and gives the user
            // a hint to "double-click to play" via cursor + a tiny badge.
            style={{
              position: "absolute",
              inset: 0,
              cursor: "default",
              background: "transparent",
            }}
            title="Double-click to interact (Esc to exit)"
          />
        )}
        {interactive && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: 6,
              top: 6,
              fontSize: 10,
              padding: "2px 6px",
              color: "var(--text-2)",
              background: "var(--chrome-bg)",
              border: "1px solid var(--border)",
              pointerEvents: "none",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Esc to exit
          </div>
        )}
      </div>
      <SourceLinkFooter url={item.url} />
    </div>
  );
};

// A thin "where this came from" bar. Stays within the item's bounds so it
// scales with resize. Truncates with ellipsis on narrow embeds.
const SourceLinkFooter = ({ url }: { url: string }) => {
  let host = url;
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname + u.search;
  } catch {
    /* leave as-is */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      draggable={false}
      // Don't let clicks/drags here trigger item selection or move.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      title={url}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 10px",
        borderTop: "1px solid var(--border)",
        background: "var(--surface-2)",
        fontSize: 11,
        color: "var(--text-2)",
        textDecoration: "none",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <span style={{ color: "var(--text)", fontWeight: 500 }}>{host}</span>
        {path && path !== "/" ? <span>{path}</span> : null}
      </span>
      <ExternalIcon />
    </a>
  );
};

const ExternalIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
    aria-hidden
  >
    <path d="M14 5h5v5" />
    <path d="M19 5l-9 9" />
    <path d="M19 13v6H5V5h6" />
  </svg>
);

const DrawingBody = ({
  item,
}: {
  item: Extract<Item, { type: "drawing" }>;
}) => (
  <svg
    width="100%"
    height="100%"
    // viewBox pinned to the authoring size (vw/vh), NOT the live w/h, so the
    // strokes scale to fill the box on resize. preserveAspectRatio="none" lets
    // the drawing stretch with the box (drawings resize freely, aspect unlocked).
    viewBox={`0 0 ${item.vw ?? item.w} ${item.vh ?? item.h}`}
    preserveAspectRatio="none"
    style={{ display: "block", overflow: "visible", pointerEvents: "none" }}
  >
    {item.strokes.map((s, i) => (
      <path
        key={i}
        d={s.d}
        stroke={s.color}
        strokeWidth={s.strokeWidth}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    ))}
  </svg>
);
