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
import { clampZoom, fitToBounds, zoomCenter } from "./coords";

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
          background: "var(--chrome-bg)",
          borderBottom: "1px solid var(--border)",
          backdropFilter: "blur(8px)",
          zIndex: 1000,
          gap: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em" }}>
          crboard
        </div>
        <div style={{ width: 1, height: 18, background: "var(--border)" }} />
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

        <HelpButton />

        <ThemeToggle theme={state.theme} dispatch={dispatch} />

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
                background: "var(--surface)",
                border: "1px solid var(--border)",
                boxShadow: "var(--shadow)",
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
                  downloadHtml(board, state.theme);
                  setMenuOpen(false);
                }}
              >
                Export shareable .html
              </MenuItem>
            </div>
          )}
        </div>
      </div>

      {tool === "pen" && (
        <PenOptions pen={state.pen} theme={state.theme} dispatch={dispatch} />
      )}

      {tool === "select" && hasSelectedText(state) && (
        <TextOptions state={state} dispatch={dispatch} />
      )}

      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 4,
          padding: 4,
          background: "var(--chrome-bg)",
          border: "1px solid var(--border)",
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

      <ZoomControls
        zoom={board.view.zoom}
        items={board.items}
        view={board.view}
        dispatch={dispatch}
      />
    </>
  );
};

// Floating panel that appears above the toolbar when the pen tool is active.
// Palette flips by theme: light canvas gets 4 shades from black; dark canvas
// gets 4 shades from white. The "primary" stroke (first swatch) always reads
// against the canvas background.
const PEN_LIGHT = ["#0a0a0a", "#525252", "#a3a3a3", "#d4d4d4"] as const;
const PEN_DARK = ["#fafafa", "#a3a3a3", "#525252", "#404040"] as const;
const PEN_WIDTHS = [1.5, 3, 6] as const;

const PenOptions = ({
  pen,
  theme,
  dispatch,
}: {
  pen: { color: string; width: number };
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => {
  const palette = theme === "dark" ? PEN_DARK : PEN_LIGHT;
  return (
  <div
    style={{
      position: "fixed",
      bottom: 64,
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "6px 10px",
      background: "var(--chrome-bg)",
      border: "1px solid var(--border)",
      backdropFilter: "blur(8px)",
      zIndex: 1000,
    }}
  >
    {palette.map((c) => {
      const active = pen.color === c;
      return (
        <button
          key={c}
          onClick={() => dispatch({ type: "setPen", patch: { color: c } })}
          aria-label={`Pen color ${c}`}
          title={c}
          style={{
            width: 22,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: c,
              border: "1px solid var(--border)",
              boxShadow: active
                ? "0 0 0 2px var(--surface), 0 0 0 4px var(--selection)"
                : "none",
            }}
          />
        </button>
      );
    })}
    <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
    {PEN_WIDTHS.map((w) => {
      const active = Math.abs(pen.width - w) < 0.01;
      return (
        <button
          key={w}
          onClick={() => dispatch({ type: "setPen", patch: { width: w } })}
          aria-label={`Pen width ${w}`}
          title={`${w}px`}
          style={{
            width: 26,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: active ? "var(--text)" : "transparent",
          }}
        >
          <span
            style={{
              display: "block",
              width: 16,
              height: w,
              borderRadius: w,
              background: active ? "var(--bg)" : pen.color,
            }}
          />
        </button>
      );
    })}
  </div>
  );
};

// True when at least one selected item is a text item — controls visibility
// of the text-style preset panel.
const hasSelectedText = (state: State) =>
  state.board.items.some(
    (it) => it.type === "text" && state.selection.has(it.id),
  );

// Text size presets. Each click writes fontSize + fontWeight on every selected
// text item (other selected items are unaffected). The ramp roughly doubles at
// each step so "Title" reads as a real headline next to "Body".
const TEXT_PRESETS: { label: string; size: number; weight: number }[] = [
  { label: "Small", size: 13, weight: 400 },
  { label: "Body", size: 18, weight: 400 },
  { label: "Heading", size: 36, weight: 700 },
  { label: "Title", size: 64, weight: 800 },
];

const TextOptions = ({
  state,
  dispatch,
}: {
  state: State;
  dispatch: React.Dispatch<Action>;
}) => {
  // Read the current size from any one selected text item to highlight the
  // active preset (rough match, since the user might have an arbitrary size).
  const sample = state.board.items.find(
    (it): it is Extract<typeof it, { type: "text" }> =>
      it.type === "text" && state.selection.has(it.id),
  );

  const apply = (size: number, weight: number) => {
    dispatch({ type: "commitHistory" });
    for (const it of state.board.items) {
      if (it.type !== "text" || !state.selection.has(it.id)) continue;
      dispatch({
        type: "updateItem",
        id: it.id,
        patch: { fontSize: size, fontWeight: weight },
      });
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 64,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: 4,
        background: "var(--chrome-bg)",
        border: "1px solid var(--border)",
        backdropFilter: "blur(8px)",
        zIndex: 1000,
      }}
    >
      {TEXT_PRESETS.map((p) => {
        const active =
          sample !== undefined &&
          sample.fontSize === p.size &&
          (sample.fontWeight ?? 400) === p.weight;
        return (
          <button
            key={p.label}
            onClick={() => apply(p.size, p.weight)}
            title={`${p.label} (${p.size}px${p.weight >= 600 ? " bold" : ""})`}
            style={{
              minWidth: 48,
              height: 32,
              padding: "0 10px",
              background: active ? "var(--text)" : "transparent",
              color: active ? "var(--bg)" : "var(--text)",
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = "var(--hover)";
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = "transparent";
            }}
          >
            <span
              style={{
                // Show a glyph hint sized to roughly match the preset.
                fontSize: Math.min(16, p.size * 0.6),
                fontWeight: p.weight,
                marginRight: 6,
                fontFamily: "ui-serif, Georgia, serif",
              }}
            >
              T
            </span>
            {p.label}
          </button>
        );
      })}
    </div>
  );
};

const ThemeToggle = ({
  theme,
  dispatch,
}: {
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => (
  <button
    onClick={() =>
      dispatch({ type: "setTheme", theme: theme === "dark" ? "light" : "dark" })
    }
    aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    title={`${theme === "dark" ? "Light" : "Dark"} mode`}
    style={{
      width: 28,
      height: 28,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--text-2)",
      border: "1px solid var(--border)",
      background: "var(--surface)",
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
  >
    {theme === "dark" ? <SunIcon /> : <MoonIcon />}
  </button>
);

const SunIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
  </svg>
);

// Bottom-right zoom controls. The middle "100%" button doubles as fit-to-content
// (clicking it frames every item in the viewport).
const ZoomControls = ({
  zoom,
  items,
  view,
  dispatch,
}: {
  zoom: number;
  items: { x: number; y: number; w: number; h: number }[];
  view: { x: number; y: number; zoom: number };
  dispatch: React.Dispatch<Action>;
}) => {
  const stepZoom = (factor: number) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    dispatch({ type: "setView", view: zoomCenter(view, vw, vh, factor) });
  };
  const fit = () => {
    if (items.length === 0) {
      dispatch({ type: "setView", view: { x: 0, y: 0, zoom: 1 } });
      return;
    }
    dispatch({
      type: "setView",
      view: fitToBounds(items, window.innerWidth, window.innerHeight),
    });
  };
  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 16,
        display: "flex",
        alignItems: "center",
        background: "var(--chrome-bg)",
        border: "1px solid var(--border)",
        backdropFilter: "blur(8px)",
        zIndex: 1000,
      }}
    >
      <ChromeBtn onClick={() => stepZoom(0.8)} title="Zoom out">
        −
      </ChromeBtn>
      <button
        onClick={fit}
        title="Fit to content (⌘1)"
        style={{
          width: 56,
          height: 28,
          fontSize: 11,
          color: "var(--text-2)",
          fontVariantNumeric: "tabular-nums",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        {Math.round(clampZoom(zoom) * 100)}%
      </button>
      <ChromeBtn onClick={() => stepZoom(1.25)} title="Zoom in">
        +
      </ChromeBtn>
    </div>
  );
};

const ChromeBtn = ({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      width: 28,
      height: 28,
      fontSize: 14,
      color: "var(--text-2)",
      lineHeight: 1,
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
  >
    {children}
  </button>
);

// "?" button + on-demand shortcuts overlay. Click outside / Escape closes.
// Pressing "?" anywhere also toggles it.
const HelpButton = () => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t?.isContentEditable ||
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA"
      )
        return;
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        style={{
          width: 28,
          height: 28,
          fontSize: 13,
          color: "var(--text-2)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
      >
        ?
      </button>
      {open && <HelpOverlay onClose={() => setOpen(false)} />}
    </>
  );
};

const HelpOverlay = ({ onClose }: { onClose: () => void }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? "⌘" : "Ctrl+";

  const rows: [string, string][] = [
    ["V / T / P", "Select / Text / Pen"],
    [`${mod}Z`, "Undo"],
    [`${isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"}`, "Redo"],
    [`${mod}D`, "Duplicate"],
    [`${mod}A`, "Select all"],
    [`${mod}C / ${mod}X / ${mod}V`, "Copy / cut / paste items"],
    [`${mod}] / ${mod}[`, "Bring forward / send back"],
    [`${mod}0 / ${mod}1`, "Reset zoom / fit content"],
    [`${mod}J`, "Zoom to selection"],
    ["Arrows", "Nudge 1px (Shift = 10px)"],
    ["Backspace", "Delete selection"],
    ["Esc", "Deselect"],
    ["Space + drag", "Pan (any tool)"],
    ["Drag empty canvas", "Rubber-band select (Shift extends)"],
    ["Right-click item", "Context menu"],
    ["Hold Shift on resize", "Toggle aspect-ratio lock"],
    ["?", "Show this help"],
  ];

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.3)",
        zIndex: 1500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow)",
          padding: 20,
          minWidth: 340,
          maxWidth: 420,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>Keyboard shortcuts</div>
          <button
            onClick={onClose}
            style={{ color: "var(--text-3)", fontSize: 18, lineHeight: 1, padding: 4 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td
                  style={{
                    padding: "4px 12px 4px 0",
                    color: "var(--text-2)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    whiteSpace: "nowrap",
                    verticalAlign: "top",
                  }}
                >
                  {k}
                </td>
                <td style={{ padding: "4px 0", color: "var(--text)" }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

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
      border: "1px solid var(--border)",
      background: active ? "var(--text)" : "var(--surface)",
      color: active ? "var(--bg)" : "var(--text)",
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
    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
  >
    {children}
  </button>
);

const Sep = () => (
  <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
);

const Divider = () => (
  <div style={{ width: 1, background: "var(--border)", margin: "4px 2px" }} />
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
      background: active ? "var(--text)" : "transparent",
      color: active ? "var(--bg)" : "var(--text)",
    }}
    onMouseEnter={(e) => {
      if (!active) e.currentTarget.style.background = "var(--hover)";
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
