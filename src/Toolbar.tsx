// Top + bottom chrome. Top bar: board name + file menu. Bottom bar: tools.
//
// Kept deliberately spare. All buttons are unstyled <button>s with thin borders;
// the active state is just an inverted color block.

import { useEffect, useRef, useState } from "react";
import type { Action, State } from "./store";
import type { ItemDraft } from "./types";
import { detectEmbed, looksLikeImageUrl } from "./embeds";
import { fileToDataUrl, openBoardFile, saveBoardFile } from "./io";
import { downloadHtml } from "./export";

type Props = {
  state: State;
  dispatch: React.Dispatch<Action>;
};

export const Toolbar = ({ state, dispatch }: Props) => {
  const { board, tool } = state;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }
  }, [menuOpen]);

  const screenCenter = () => {
    // Place new items near the visible center of the screen, in world coords.
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    return {
      x: (cx - board.view.x) / board.view.zoom,
      y: (cy - board.view.y) / board.view.zoom,
    };
  };

  const addImage = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = async () => {
      const files = input.files;
      if (!files || !files.length) return;
      const center = screenCenter();
      const items: ItemDraft[] = [];
      let i = 0;
      for (const f of Array.from(files)) {
        const src = await fileToDataUrl(f);
        const dims = await imageSize(src);
        const max = 480;
        const scale = Math.min(1, max / Math.max(dims.w, dims.h));
        items.push({
          type: "image",
          src,
          alt: f.name,
          x: center.x - (dims.w * scale) / 2 + i * 24,
          y: center.y - (dims.h * scale) / 2 + i * 24,
          w: dims.w * scale,
          h: dims.h * scale,
        });
        i++;
      }
      dispatch({ type: "addItems", items });
    };
    input.click();
  };

  const addEmbedOrLink = () => {
    const url = window.prompt(
      "Paste a URL (YouTube, Instagram, TikTok, image, or any link):",
    );
    if (!url) return;
    const trimmed = url.trim();
    const center = screenCenter();

    if (looksLikeImageUrl(trimmed)) {
      dispatch({
        type: "addItem",
        item: {
          type: "image",
          src: trimmed,
          x: center.x - 200,
          y: center.y - 150,
          w: 400,
          h: 300,
        },
      });
      return;
    }

    const info = detectEmbed(trimmed);
    if (info && info.provider !== "generic") {
      const { w, h } = info.defaultSize;
      dispatch({
        type: "addItem",
        item: {
          type: "embed",
          url: trimmed,
          provider: info.provider,
          x: center.x - w / 2,
          y: center.y - h / 2,
          w,
          h,
        },
      });
      return;
    }

    // Fallback: link card.
    dispatch({
      type: "addItem",
      item: {
        type: "link",
        url: trimmed,
        title: "",
        x: center.x - 160,
        y: center.y - 50,
        w: 320,
        h: 100,
      },
    });
  };

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          background: "rgba(255,255,255,0.92)",
          borderBottom: "1px solid #e5e5e5",
          backdropFilter: "blur(8px)",
          zIndex: 1000,
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em" }}>
          crboard
        </div>
        <div style={{ width: 1, height: 18, background: "#e5e5e5" }} />
        <input
          value={board.name}
          onChange={(e) =>
            dispatch({ type: "setName", name: e.target.value })
          }
          spellCheck={false}
          style={{
            border: 0,
            outline: 0,
            background: "transparent",
            fontSize: 13,
            fontWeight: 500,
            width: 240,
          }}
        />
        <div style={{ flex: 1 }} />

        <ZoomLabel zoom={board.view.zoom} />

        <div style={{ position: "relative" }} ref={menuRef}>
          <BarButton onClick={() => setMenuOpen((m) => !m)} active={menuOpen}>
            File
          </BarButton>
          {menuOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 6,
                minWidth: 200,
                background: "#fff",
                border: "1px solid #e5e5e5",
                boxShadow: "0 4px 16px rgba(0,0,0,0.06)",
                padding: 4,
                zIndex: 1001,
              }}
            >
              <MenuItem
                onClick={() => {
                  if (
                    board.items.length === 0 ||
                    confirm("Discard the current board?")
                  ) {
                    dispatch({ type: "newBoard" });
                  }
                  setMenuOpen(false);
                }}
              >
                New board
              </MenuItem>
              <MenuItem
                onClick={async () => {
                  const b = await openBoardFile();
                  if (b) dispatch({ type: "loadBoard", board: b });
                  setMenuOpen(false);
                }}
              >
                Open .crboard…
              </MenuItem>
              <MenuItem
                onClick={() => {
                  saveBoardFile(board);
                  setMenuOpen(false);
                }}
              >
                Save as .crboard
              </MenuItem>
              <Sep />
              <MenuItem
                onClick={() => {
                  downloadHtml(board);
                  setMenuOpen(false);
                }}
              >
                Export shareable .html
              </MenuItem>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 4,
          padding: 4,
          background: "rgba(255,255,255,0.92)",
          border: "1px solid #e5e5e5",
          backdropFilter: "blur(8px)",
          zIndex: 1000,
        }}
      >
        <ToolButton
          active={tool === "select"}
          onClick={() => dispatch({ type: "setTool", tool: "select" })}
          label="Select"
          shortcut="V"
        >
          <SelectIcon />
        </ToolButton>
        <ToolButton
          active={tool === "text"}
          onClick={() => dispatch({ type: "setTool", tool: "text" })}
          label="Text"
          shortcut="T"
        >
          <TextIcon />
        </ToolButton>
        <ToolButton
          active={tool === "pen"}
          onClick={() => dispatch({ type: "setTool", tool: "pen" })}
          label="Draw"
          shortcut="P"
        >
          <PenIcon />
        </ToolButton>
        <Divider />
        <ToolButton onClick={addImage} label="Add image">
          <ImageIcon />
        </ToolButton>
        <ToolButton onClick={addEmbedOrLink} label="Add link / embed">
          <LinkIcon />
        </ToolButton>
      </div>
    </>
  );
};

const ZoomLabel = ({ zoom }: { zoom: number }) => (
  <div
    style={{
      fontVariantNumeric: "tabular-nums",
      fontSize: 12,
      color: "#737373",
      padding: "0 8px",
    }}
  >
    {Math.round(zoom * 100)}%
  </div>
);

const BarButton = ({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) => (
  <button
    onClick={onClick}
    style={{
      padding: "6px 12px",
      fontSize: 12,
      fontWeight: 500,
      border: "1px solid #e5e5e5",
      background: active ? "#0a0a0a" : "#ffffff",
      color: active ? "#ffffff" : "#0a0a0a",
    }}
  >
    {children}
  </button>
);

const MenuItem = ({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    style={{
      display: "block",
      width: "100%",
      textAlign: "left",
      padding: "8px 10px",
      fontSize: 13,
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = "#f5f5f5")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
  >
    {children}
  </button>
);

const Sep = () => (
  <div style={{ height: 1, background: "#e5e5e5", margin: "4px 0" }} />
);

const Divider = () => (
  <div style={{ width: 1, background: "#e5e5e5", margin: "4px 2px" }} />
);

const ToolButton = ({
  active,
  onClick,
  label,
  shortcut,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    title={shortcut ? `${label} (${shortcut})` : label}
    aria-label={label}
    style={{
      width: 36,
      height: 36,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: active ? "#0a0a0a" : "transparent",
      color: active ? "#ffffff" : "#0a0a0a",
    }}
    onMouseEnter={(e) => {
      if (!active) e.currentTarget.style.background = "#f5f5f5";
    }}
    onMouseLeave={(e) => {
      if (!active) e.currentTarget.style.background = "transparent";
    }}
  >
    {children}
  </button>
);

// Tiny inline SVG icons. Stroke-only, monochrome, currentColor.
const Stroke = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const SelectIcon = () => (
  <Stroke>
    <path d="M5 4l6 16 2.5-7L20 11z" />
  </Stroke>
);
const TextIcon = () => (
  <Stroke>
    <path d="M5 6h14" />
    <path d="M12 6v14" />
  </Stroke>
);
const PenIcon = () => (
  <Stroke>
    <path d="M14 4l6 6-11 11H3v-6z" />
  </Stroke>
);
const ImageIcon = () => (
  <Stroke>
    <rect x="3" y="4" width="18" height="16" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M3 17l5-5 5 5 3-3 5 5" />
  </Stroke>
);
const LinkIcon = () => (
  <Stroke>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1" />
  </Stroke>
);

const imageSize = (src: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = src;
  });
