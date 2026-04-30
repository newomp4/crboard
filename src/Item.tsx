// Renders a single item on the canvas. Handles selection chrome, drag-to-move,
// corner-handle resize, and dispatches double-click → edit for text.
//
// All math is done in WORLD coordinates. Mouse deltas come in as screen pixels
// and we divide by the current zoom to get world units.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Item, View } from "./types";
import type { Action } from "./store";
import { detectEmbed } from "./embeds";

type Props = {
  item: Item;
  selected: boolean;
  autoEdit?: boolean;
  view: View;
  tool: "select" | "text" | "pen";
  // Needed for multi-drag: the drag handler captures origin positions of
  // every selected item at gesture start so they all move together.
  allItems: Item[];
  selectedIds: string[];
  // Right-click handler. Canvas opens a small action menu at (clientX, clientY).
  onContextMenu?: (itemId: string, clientX: number, clientY: number) => void;
  dispatch: React.Dispatch<Action>;
};

const HANDLE_SIZE = 10;

export const ItemView = ({
  item,
  selected,
  autoEdit,
  view,
  tool,
  allItems,
  selectedIds,
  onContextMenu,
  dispatch,
}: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  // When the store flags this item as the one to edit immediately (e.g. it
  // was just created via the text tool), drop into edit mode and clear the
  // flag so a re-render doesn't keep retriggering it.
  useEffect(() => {
    if (autoEdit && item.type === "text") {
      setEditing(true);
      dispatch({ type: "setEditId", id: null });
    }
  }, [autoEdit, item.type, dispatch]);

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

      // Capture origin positions so each move event computes absolute
      // positions from the gesture start (avoids accumulating rounding error).
      const origins = new Map<string, { x: number; y: number }>();
      for (const id of dragIds) {
        const it = allItems.find((i) => i.id === id);
        if (it) origins.set(id, { x: it.x, y: it.y });
      }

      let committed = false;
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / view.zoom;
        const dy = (ev.clientY - startY) / view.zoom;
        if (dx === 0 && dy === 0) return;
        if (!committed) {
          dispatch({ type: "commitHistory" });
          committed = true;
        }
        const positions = dragIds.flatMap((id) => {
          const o = origins.get(id);
          return o ? [{ id, x: o.x + dx, y: o.y + dy }] : [];
        });
        dispatch({ type: "setItemPositions", positions });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [tool, editing, selected, item, selectedIds, allItems, view.zoom, dispatch],
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
      style={{
        position: "absolute",
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        zIndex: item.z,
      }}
      className={selected ? "selection-ring" : ""}
    >
      <ItemBody
        item={item}
        selected={selected}
        editing={editing}
        setEditing={setEditing}
        dispatch={dispatch}
      />

      {selected && tool === "select" && !editing && (
        <>
          {(["tl", "tr", "bl", "br", "t", "b", "l", "r"] as HandlePos[]).map(
            (p) => (
              <Handle key={p} pos={p} onPointerDown={startResize(p)} />
            ),
          )}
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
  setEditing,
  dispatch,
}: {
  item: Item;
  selected: boolean;
  editing: boolean;
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
      return <EmbedBody item={item} selected={selected} />;
    case "link":
      return (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            padding: 16,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            textDecoration: "none",
            fontSize: 14,
            wordBreak: "break-word",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {item.title || new URL(item.url).hostname}
          </div>
          <div style={{ color: "var(--text-3)", fontSize: 12 }}>{item.url}</div>
        </a>
      );
    case "drawing":
      return <DrawingBody item={item} />;
  }
};

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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      // Place caret at the end.
      const r = document.createRange();
      r.selectNodeContents(ref.current);
      r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  }, [editing]);

  return (
    <div
      ref={ref}
      contentEditable={editing}
      suppressContentEditableWarning
      onBlur={(e) => {
        setEditing(false);
        dispatch({
          type: "updateItem",
          id: item.id,
          patch: { text: e.currentTarget.innerText },
        });
      }}
      onPointerDown={(e) => editing && e.stopPropagation()}
      style={{
        width: "100%",
        height: "100%",
        padding: 12,
        fontSize: item.fontSize,
        lineHeight: 1.4,
        color: "var(--text)",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        outline: editing ? "none" : undefined,
        whiteSpace: "pre-wrap",
        overflow: "auto",
        cursor: editing ? "text" : "default",
      }}
    >
      {item.text}
    </div>
  );
};

// Embeds get two affordances on top of a plain iframe:
//   1. A "click to interact" overlay while the item isn't selected. iframes
//      capture every click that lands on them, which makes it impossible to
//      *select* the item to move/resize/delete. We cover the iframe with a
//      transparent div until it's selected — first click selects, then the
//      overlay disappears and subsequent clicks reach the iframe normally.
//   2. A small footer showing the source URL, clickable. So you can both watch
//      the embed and jump to the original page.
const EmbedBody = ({
  item,
  selected,
}: {
  item: Extract<Item, { type: "embed" }>;
  selected: boolean;
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
          }}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
        />
        {!selected && (
          <div
            // Pointer events on this overlay are what let the wrapper's
            // onPointerDown fire — without it, the iframe would eat the click.
            style={{
              position: "absolute",
              inset: 0,
              cursor: "pointer",
              background: "transparent",
            }}
          />
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
