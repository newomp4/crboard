// Renders a single item on the canvas. Handles selection chrome, drag-to-move,
// corner-handle resize, and dispatches double-click → edit for text.
//
// All math is done in WORLD coordinates. Mouse deltas come in as screen pixels
// and we divide by the current zoom to get world units.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Item, View } from "./types";
import type { Action } from "./store";
import { detectEmbed } from "./embeds";
import { computeSnap, type Guide } from "./snap";

type Props = {
  item: Item;
  selected: boolean;
  // When a multi-select is active, the group bounding box draws its own handles
  // and we hide the per-item handles to avoid two overlapping sets.
  suppressIndividualHandles?: boolean;
  autoEdit?: boolean;
  view: View;
  tool: "select" | "text" | "pen" | "connector";
  // Needed for multi-drag: the drag handler captures origin positions of
  // every selected item at gesture start so they all move together.
  allItems: Item[];
  selectedIds: string[];
  // Right-click handler. Canvas opens a small action menu at (clientX, clientY).
  onContextMenu?: (itemId: string, clientX: number, clientY: number) => void;
  // Reports active alignment guides during a drag so Canvas can render them.
  onSnapGuides?: (guides: { x: Guide | null; y: Guide | null } | null) => void;
  dispatch: React.Dispatch<Action>;
};

const HANDLE_SIZE = 10;
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
  dispatch,
}: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // For embeds: double-click "engages" the iframe so clicks/drags inside reach
  // the embedded page (play, scrub, expand). Until then, the embed is locked
  // behind a transparent overlay so dragging the wrapper always moves it
  // instead of accidentally interacting with Twitter/YouTube/etc.
  const [interactive, setInteractive] = useState(false);

  // When the store flags this item as the one to edit immediately (e.g. it
  // was just created via the text tool), drop into edit mode and clear the
  // flag so a re-render doesn't keep retriggering it.
  useEffect(() => {
    if (autoEdit && item.type === "text") {
      setEditing(true);
      dispatch({ type: "setEditId", id: null });
    }
  }, [autoEdit, item.type, dispatch]);

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
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onSnapGuides?.(null);
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
      dispatch,
    ],
  );

  const startResize = useCallback(
    (handle: HandlePos) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      let committed = false;

      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { x: item.x, y: item.y, w: item.w, h: item.h };

      // Aspect ratio is locked by default for images and embeds (stretching
      // either looks bad — Instagram has a fixed ratio, photos shouldn't
      // squish). Shift inverts the default.
      const lockByDefault = item.type === "image" || item.type === "embed";
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

        const locked = ev.shiftKey ? !lockByDefault : lockByDefault;

        // First compute unconstrained new dims based on which side is being pulled.
        let nw = orig.w;
        let nh = orig.h;
        if (left) nw = orig.w - dx;
        else if (right) nw = orig.w + dx;
        if (top) nh = orig.h - dy;
        else if (bottom) nh = orig.h + dy;
        nw = Math.max(40, nw);
        nh = Math.max(40, nh);

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
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [item, view.zoom, dispatch],
  );

  return (
    <div
      ref={ref}
      data-item-id={item.id}
      onPointerDown={startMove}
      onDoubleClick={() => {
        if (item.type === "text") setEditing(true);
        else if (item.type === "embed") setInteractive(true);
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
      }}
      className={`crboard-item${selected ? " selection-ring" : ""}`}
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
            {/* Text items only show left/right edge handles. Height is always
                content-driven (auto-grow), so exposing top/bottom handles just
                fights with the auto-grow effect and creates flicker. */}
            {(item.type === "text"
              ? (["l", "r"] as HandlePos[])
              : (["tl", "tr", "bl", "br", "t", "b", "l", "r"] as HandlePos[])
            ).map((p) => (
              <Handle key={p} pos={p} onPointerDown={startResize(p)} />
            ))}
          </>
        )}
    </div>
  );
};

type HandlePos = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

// Resize handle. 8 of them total: 4 corners + 4 edges. Edges resize one
// dimension only (text width without changing height, etc.). Corner cursors
// are diagonal, edge cursors are straight.
const Handle = ({
  pos,
  onPointerDown,
}: {
  pos: HandlePos;
  onPointerDown: (e: React.PointerEvent) => void;
}) => {
  const cornerCursors = {
    tl: "nwse-resize",
    br: "nwse-resize",
    tr: "nesw-resize",
    bl: "nesw-resize",
    t: "ns-resize",
    b: "ns-resize",
    l: "ew-resize",
    r: "ew-resize",
  } as const;

  const isCorner = pos.length === 2;
  const offset = -HANDLE_SIZE / 2 - 2;

  const style: React.CSSProperties = {
    position: "absolute",
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: "var(--surface-2)",
    border: "1.5px solid var(--selection)",
    cursor: cornerCursors[pos],
    // touchAction:none keeps the browser from intercepting pointer events on touch devices.
    touchAction: "none",
  };

  // Anchor each handle. Edge handles centre on their side using transform.
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
    case "link":
      return <LinkBody item={item} selected={selected} />;
    case "drawing":
      return <DrawingBody item={item} />;
    case "connector":
      // Connectors render in a dedicated SVG layer, not inside an item wrapper.
      return null;
  }
};

// Text items use a real <textarea> rather than contenteditable. Reasons:
//   - Pasting into contenteditable smuggles in HTML/styles. Textarea is plain.
//   - Native textarea behavior (Enter, Tab, IME composition) is just better.
//   - Auto-grow is a one-line trick on textarea (set height = scrollHeight).
//
// We let the height of the *item* track the content. The user can still set a
// width via the left/right edge handles; the height fits the text.
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
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: every time the text or width changes, recompute height to fit.
  // We measure the textarea by setting height:auto and reading scrollHeight,
  // then update the item to match.
  //
  // Important details:
  //   1. With box-sizing:border-box, scrollHeight reports content + padding
  //      but EXCLUDES the border. The wrapper sets the textarea height via
  //      height:100% which DOES include the border, so we add it back —
  //      otherwise the last line gets clipped.
  //   2. We must restore the inline height to "100%" after measuring.
  //      Otherwise React's reconciler sees the style prop is unchanged and
  //      doesn't sync the DOM, leaving the textarea stuck at "auto" — which
  //      Chrome renders at the default rows attribute (~2 lines), and
  //      scrollTop preserves a mid-content position. Result: a tall wrapper
  //      with a small textarea at the top scrolled mid-text. (This was the
  //      "saved file opens with text overflowing the box" bug.)
  //   3. scrollTop = 0 belt-and-suspenders for the same reason: keep content
  //      top-aligned. With auto-grow keeping content within bounds, this is
  //      a no-op during normal use.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    const cs = window.getComputedStyle(ta);
    const borderY =
      (parseFloat(cs.borderTopWidth) || 0) +
      (parseFloat(cs.borderBottomWidth) || 0);
    const measured = Math.max(MIN_TEXT_H, Math.ceil(ta.scrollHeight + borderY));
    ta.style.height = "100%";
    ta.scrollTop = 0;
    if (Math.abs(measured - item.h) > 0.5) {
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { h: measured } as Partial<Item>,
      });
    }
  }, [item.text, item.w, item.fontSize, item.fontWeight, item.h, item.id, dispatch]);

  // Drop into editing → focus + place caret at end.
  useEffect(() => {
    if (editing && ref.current) {
      const ta = ref.current;
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }
  }, [editing]);

  return (
    <textarea
      ref={ref}
      value={item.text}
      readOnly={!editing}
      // Keep the textarea out of the keyboard tab order while not editing —
      // otherwise pressing Tab can quietly focus it and "hijack" Backspace.
      tabIndex={editing ? 0 : -1}
      placeholder={editing ? "Type…" : ""}
      spellCheck={editing}
      onChange={(e) =>
        dispatch({
          type: "updateItem",
          id: item.id,
          patch: { text: e.target.value } as Partial<Item>,
        })
      }
      onBlur={() => setEditing(false)}
      // While editing, don't propagate pointer events so the wrapper's drag
      // handler doesn't interfere with text selection inside the field.
      onPointerDown={(e) => {
        if (editing) e.stopPropagation();
      }}
      onKeyDown={(e) => {
        // Esc / Cmd+Enter both commit and exit edit mode.
        if (
          e.key === "Escape" ||
          ((e.metaKey || e.ctrlKey) && e.key === "Enter")
        ) {
          e.preventDefault();
          ref.current?.blur();
        }
      }}
      style={{
        // Width fills the item; height is driven by scrollHeight measurement.
        width: "100%",
        height: "100%",
        padding: 12,
        margin: 0,
        fontSize: item.fontSize,
        fontWeight: item.fontWeight ?? 400,
        lineHeight: 1.35,
        fontFamily: "inherit",
        color: "var(--text)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        outline: "none",
        resize: "none",
        // pre-wrap-equivalent for textareas — wraps long lines, preserves \n.
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflow: "hidden",
        cursor: editing ? "text" : "default",
        // Keep the textarea visually inert when not editing.
        pointerEvents: editing ? "auto" : "none",
        boxSizing: "border-box",
        display: "block",
      }}
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
    viewBox={`0 0 ${item.w} ${item.h}`}
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
      />
    ))}
  </svg>
);
