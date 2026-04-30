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
  view: View;
  tool: "select" | "text" | "pen";
  dispatch: React.Dispatch<Action>;
};

const HANDLE_SIZE = 10;

export const ItemView = ({ item, selected, view, tool, dispatch }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  const startMove = useCallback(
    (e: React.PointerEvent) => {
      if (tool !== "select") return;
      if (editing) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      // Select on mousedown (additive with shift).
      if (!selected) {
        dispatch(
          e.shiftKey
            ? { type: "selectToggle", id: item.id }
            : { type: "selectOnly", ids: [item.id] },
        );
      }
      dispatch({ type: "bringToFront", id: item.id });

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = item.x;
      const origY = item.y;

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / view.zoom;
        const dy = (ev.clientY - startY) / view.zoom;
        dispatch({
          type: "updateItem",
          id: item.id,
          patch: { x: origX + dx, y: origY + dy } as Partial<Item>,
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [tool, editing, selected, item, view.zoom, dispatch],
  );

  const startResize = useCallback(
    (corner: "tl" | "tr" | "bl" | "br") => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      const startX = e.clientX;
      const startY = e.clientY;
      const orig = { x: item.x, y: item.y, w: item.w, h: item.h };

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / view.zoom;
        const dy = (ev.clientY - startY) / view.zoom;
        let { x, y, w, h } = orig;
        if (corner === "br") {
          w = Math.max(40, orig.w + dx);
          h = Math.max(40, orig.h + dy);
        } else if (corner === "bl") {
          w = Math.max(40, orig.w - dx);
          h = Math.max(40, orig.h + dy);
          x = orig.x + (orig.w - w);
        } else if (corner === "tr") {
          w = Math.max(40, orig.w + dx);
          h = Math.max(40, orig.h - dy);
          y = orig.y + (orig.h - h);
        } else {
          w = Math.max(40, orig.w - dx);
          h = Math.max(40, orig.h - dy);
          x = orig.x + (orig.w - w);
          y = orig.y + (orig.h - h);
        }
        dispatch({
          type: "updateItem",
          id: item.id,
          patch: { x, y, w, h } as Partial<Item>,
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
      <ItemBody item={item} editing={editing} setEditing={setEditing} dispatch={dispatch} />

      {selected && tool === "select" && (
        <>
          <Handle pos="tl" onPointerDown={startResize("tl")} />
          <Handle pos="tr" onPointerDown={startResize("tr")} />
          <Handle pos="bl" onPointerDown={startResize("bl")} />
          <Handle pos="br" onPointerDown={startResize("br")} />
        </>
      )}
    </div>
  );
};

const Handle = ({
  pos,
  onPointerDown,
}: {
  pos: "tl" | "tr" | "bl" | "br";
  onPointerDown: (e: React.PointerEvent) => void;
}) => {
  const cursor =
    pos === "tl" || pos === "br" ? "nwse-resize" : "nesw-resize";
  const style: React.CSSProperties = {
    position: "absolute",
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    background: "#ffffff",
    border: "1.5px solid #0a0a0a",
    cursor,
  };
  if (pos.includes("t")) style.top = -HANDLE_SIZE / 2 - 2;
  else style.bottom = -HANDLE_SIZE / 2 - 2;
  if (pos.includes("l")) style.left = -HANDLE_SIZE / 2 - 2;
  else style.right = -HANDLE_SIZE / 2 - 2;
  return <div style={style} onPointerDown={onPointerDown} />;
};

const ItemBody = ({
  item,
  editing,
  setEditing,
  dispatch,
}: {
  item: Item;
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
            background: "#fafafa",
          }}
        />
      );
    case "embed":
      return <EmbedBody item={item} />;
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
            background: "#ffffff",
            border: "1px solid #e5e5e5",
            color: "#0a0a0a",
            textDecoration: "none",
            fontSize: 14,
            wordBreak: "break-word",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {item.title || new URL(item.url).hostname}
          </div>
          <div style={{ color: "#737373", fontSize: 12 }}>{item.url}</div>
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
        color: "#0a0a0a",
        background: "#ffffff",
        border: "1px solid #e5e5e5",
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

const EmbedBody = ({ item }: { item: Extract<Item, { type: "embed" }> }) => {
  const info = detectEmbed(item.url);
  const src = info?.embedUrl ?? item.url;
  return (
    <iframe
      src={src}
      style={{
        width: "100%",
        height: "100%",
        border: "1px solid #e5e5e5",
        background: "#fafafa",
        display: "block",
      }}
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowFullScreen
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation"
    />
  );
};

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
