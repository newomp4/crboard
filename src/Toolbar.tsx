// Top + bottom chrome. Top bar: board name + file menu. Bottom bar: tools.
//
// Kept deliberately spare. All buttons are unstyled <button>s with thin borders;
// the active state is just an inverted color block.

import { useEffect, useRef, useState } from "react";
import type { Action, ConnectorStyle, SaveStatus, ShapeStyle, State } from "./store";
import { NOTE_FILL, noteTextColor } from "./store";
import type {
  ConnectorItem,
  DrawingItem,
  ShapeItem,
  TextItem,
  VideoItem,
  View,
} from "./types";
import { formatClock } from "./video";
import { getVideoController } from "./videoPlayback";
import type { BackupActions, BackupInfo } from "./App";
import { openBoardFile, saveBoardFile } from "./io";
import { downloadHtml } from "./export";
import { downloadImage } from "./exportImage";
import { buildShareUrl, encodeShareHash } from "./share";
import { clampZoom, fitToBounds, zoomCenter } from "./coords";
import { animateView } from "./viewAnim";

// Left-to-right order of the bottom toolbar tools. Drives the sliding pill's
// horizontal position (index × button pitch).
const TOOL_ORDER = ["select", "text", "pen", "connector", "shape"] as const;

type Props = {
  state: State;
  dispatch: React.Dispatch<Action>;
  saveStatus: SaveStatus;
  backup: BackupInfo;
  backupActions: BackupActions;
  onOpenBulkImport: () => void;
  onGoHome: () => void;
};

export const Toolbar = ({
  state,
  dispatch,
  saveStatus,
  backup,
  backupActions,
  onOpenBulkImport,
  onGoHome,
}: Props) => {
  const { board, tool } = state;
  const selectedVid = selectedVideo(state);
  const selectedConn = selectedConnectorItem(state);
  const selectedShape = selectedShapeItem(state);
  const selectedDrawings = board.items.filter(
    (it): it is DrawingItem =>
      it.type === "drawing" && state.selection.has(it.id),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const copyShareLink = async () => {
    try {
      const hash = await encodeShareHash(board, state.theme);
      const url = buildShareUrl(hash);
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => {
        setShareCopied(false);
        setMenuOpen(false);
      }, 1500);
    } catch {
      setMenuOpen(false);
    }
  };

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

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 46,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          background: "var(--glass-bg)",
          borderBottom: "1px solid var(--border)",
          WebkitBackdropFilter: "var(--glass-blur)",
          backdropFilter: "var(--glass-blur)",
          zIndex: 1000,
          gap: 12,
        }}
      >
        <button
          onClick={onGoHome}
          title="All boards"
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "var(--text)",
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          crboard
        </button>
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

        <SaveIndicator status={saveStatus} />

        <HelpButton />

        <ThemeToggle theme={state.theme} dispatch={dispatch} />

        <div style={{ position: "relative" }} ref={menuRef}>
          <BarButton onClick={() => setMenuOpen((m) => !m)} active={menuOpen}>
            File
          </BarButton>
          {menuOpen && (
            <div
              className="glass cr-menu"
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 8,
                minWidth: 210,
                padding: 6,
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
                  onOpenBulkImport();
                  setMenuOpen(false);
                }}
                subtitle="Paste a list of links to add many items at once"
              >
                Import links…
              </MenuItem>
              <Sep />
              <MenuItem
                onClick={() => {
                  if (!shareCopied) copyShareLink();
                }}
                subtitle="Opens in browser — no download needed"
              >
                {shareCopied ? "Link copied!" : "Copy share link"}
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
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  downloadImage(board, state.theme);
                }}
                subtitle="High-res PNG of the whole board (zoom-in quality)"
              >
                Export as PNG…
              </MenuItem>
              {backup.supported && (
                <>
                  <Sep />
                  {backup.enabled ? (
                    <>
                      <MenuItem
                        onClick={async () => {
                          await backupActions.enable();
                          setMenuOpen(false);
                        }}
                        subtitle={`${backup.folderName ?? "—"} / ${backup.filename}${
                          backup.lastBackupAt
                            ? `  ·  ${formatRelative(backup.lastBackupAt)}`
                            : "  ·  saving…"
                        }`}
                      >
                        Auto-backup: on
                      </MenuItem>
                      <MenuItem
                        onClick={async () => {
                          await backupActions.disable();
                          setMenuOpen(false);
                        }}
                      >
                        Disable auto-backup
                      </MenuItem>
                    </>
                  ) : (
                    <MenuItem
                      onClick={async () => {
                        await backupActions.enable();
                        setMenuOpen(false);
                      }}
                      subtitle="Pick a folder, board saves there every 10 min"
                    >
                      Set up auto-backup folder…
                    </MenuItem>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {tool === "pen" && (
        <PenOptions pen={state.pen} theme={state.theme} dispatch={dispatch} />
      )}

      {tool === "connector" && (
        <ConnectorOptions
          connector={state.connector}
          theme={state.theme}
          dispatch={dispatch}
        />
      )}

      {tool === "shape" && (
        <ShapeOptions shape={state.shape} theme={state.theme} dispatch={dispatch} />
      )}

      {/* Multi-select gets align/distribute; single-select gets the
          type-specific properties panel. One panel at a time keeps it clean. */}
      {tool === "select" && state.selection.size > 1 && (
        <AlignOptions state={state} dispatch={dispatch} />
      )}

      {tool === "select" &&
        state.selection.size === 1 &&
        hasSelectedText(state) && (
          <TextOptions state={state} dispatch={dispatch} />
        )}

      {tool === "select" && state.selection.size === 1 && selectedVid && (
        <VideoOptions item={selectedVid} dispatch={dispatch} />
      )}

      {tool === "select" && state.selection.size === 1 && selectedConn && (
        <SelectedConnectorOptions
          item={selectedConn}
          theme={state.theme}
          dispatch={dispatch}
        />
      )}

      {tool === "select" && state.selection.size === 1 && selectedShape && (
        <SelectedShapeOptions
          item={selectedShape}
          theme={state.theme}
          dispatch={dispatch}
        />
      )}

      {tool === "select" &&
        state.selection.size === 1 &&
        selectedDrawings.length > 0 &&
        !hasSelectedText(state) &&
        !selectedVid && (
          <DrawingOptions
            drawings={selectedDrawings}
            theme={state.theme}
            dispatch={dispatch}
          />
        )}

      <div
        className="glass"
        style={{
          position: "fixed",
          bottom: 18,
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          gap: 4,
          padding: 6,
          zIndex: 1000,
        }}
      >
        {/* Sliding active-tool indicator. Buttons are transparent; this pill
            sits behind their icons and glides to the active tool. 36px button +
            4px gap = 40px pitch. */}
        <div
          aria-hidden
          className="tool-pill"
          style={{
            position: "absolute",
            left: 6,
            top: 6,
            width: 36,
            height: 36,
            borderRadius: "var(--radius-sm)",
            // An elevated chip (not a solid ink block): icons stay visible as it
            // glides across them, instead of the old white pill swallowing the
            // white icons mid-slide.
            background: "var(--surface-2)",
            boxShadow: "var(--shadow), 0 0 0 1px var(--border-strong)",
            willChange: "transform",
            transform: `translateX(${TOOL_ORDER.indexOf(tool) * 40}px)`,
          }}
        />
        <ToolButton
          active={tool === "select"}
          locked={tool === "select" && state.toolLocked}
          onClick={() => dispatch({ type: "setTool", tool: "select" })}
          onDoubleClick={() =>
            dispatch({ type: "setTool", tool: "select", lock: true })
          }
          label="Select"
          shortcut="V"
        >
          <SelectIcon />
        </ToolButton>
        <ToolButton
          active={tool === "text"}
          locked={tool === "text" && state.toolLocked}
          onClick={() => dispatch({ type: "setTool", tool: "text" })}
          onDoubleClick={() =>
            dispatch({ type: "setTool", tool: "text", lock: true })
          }
          label="Text"
          shortcut="T"
        >
          <TextIcon />
        </ToolButton>
        <ToolButton
          active={tool === "pen"}
          locked={tool === "pen" && state.toolLocked}
          onClick={() => dispatch({ type: "setTool", tool: "pen" })}
          onDoubleClick={() =>
            dispatch({ type: "setTool", tool: "pen", lock: true })
          }
          label="Draw"
          shortcut="P"
        >
          <PenIcon />
        </ToolButton>
        <ToolButton
          active={tool === "connector"}
          locked={tool === "connector" && state.toolLocked}
          onClick={() => dispatch({ type: "setTool", tool: "connector" })}
          onDoubleClick={() =>
            dispatch({ type: "setTool", tool: "connector", lock: true })
          }
          label="Connector"
          shortcut="C"
        >
          <ConnectorIcon />
        </ToolButton>
        <ToolButton
          active={tool === "shape"}
          locked={tool === "shape" && state.toolLocked}
          onClick={() => dispatch({ type: "setTool", tool: "shape" })}
          onDoubleClick={() =>
            dispatch({ type: "setTool", tool: "shape", lock: true })
          }
          label="Shapes"
          shortcut="S"
        >
          <ShapeToolIcon />
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
// First swatch is "ink" — black on a light canvas, white on a dark one, so it
// always reads against the background (and auto-inverts with the theme). The
// rest are fixed primaries that stay the same in either theme.
const INK = { light: "#0a0a0a", dark: "#fafafa" } as const;
const PEN_PRIMARIES = ["#e5484d", "#4c7ef3", "#30a46c", "#f5a623"] as const;
const paletteFor = (theme: "light" | "dark") =>
  [INK[theme], ...PEN_PRIMARIES] as const;
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
  const palette = paletteFor(theme);
  return (
  <div
    className="glass cr-rise-cx"
    style={{
      position: "fixed",
      bottom: 88,
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "8px 12px",
      zIndex: 1000,
    }}
  >
    {palette.map((c) => {
      const active = pen.color === c;
      return (
        <button
          key={c}
          className="cr-swatch"
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

const CONNECTOR_WIDTHS = [1.5, 2.5, 4] as const;

// Same shape as PenOptions, for the connector/arrow tool. Sets the color +
// thickness that new connectors are drawn with.
const CONNECTOR_SHAPES = ["straight", "curved", "elbow"] as const;
const CONNECTOR_ENDS = ["one", "both", "none"] as const;

// Shared color / width / shape / arrowhead controls. Used both by the connector
// tool (setting defaults for new connectors) and by a selected connector (editing
// it in place) — the caller supplies onChange to route the patch appropriately.
const ConnectorControls = ({
  value,
  theme,
  onChange,
}: {
  value: ConnectorStyle;
  theme: "light" | "dark";
  onChange: (patch: Partial<ConnectorStyle>) => void;
}) => {
  const palette = paletteFor(theme);
  return (
    <div
      className="glass cr-rise-cx"
      style={{
        position: "fixed",
        bottom: 88,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 12px",
        zIndex: 1000,
      }}
    >
      {palette.map((c) => {
        const active = value.color === c;
        return (
          <button
            key={c}
            onClick={() => onChange({ color: c })}
            aria-label={`Connector color ${c}`}
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
      {CONNECTOR_WIDTHS.map((w) => {
        const active = Math.abs(value.width - w) < 0.01;
        return (
          <button
            key={w}
            onClick={() => onChange({ width: w })}
            aria-label={`Connector width ${w}`}
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
                background: active ? "var(--bg)" : value.color,
              }}
            />
          </button>
        );
      })}
      <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
      {/* Line shape */}
      {CONNECTOR_SHAPES.map((s) => {
        const active = (value.shape ?? "straight") === s;
        return (
          <button
            key={s}
            className="chrome-btn"
            onClick={() => onChange({ shape: s })}
            aria-label={`${s} line`}
            title={`${s[0].toUpperCase()}${s.slice(1)} line`}
            style={{
              width: 30,
              height: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm)",
              background: active ? "var(--text)" : "transparent",
              color: active ? "var(--bg)" : "var(--text)",
            }}
          >
            <ShapeGlyph shape={s} />
          </button>
        );
      })}
      <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
      {/* Arrowheads */}
      {CONNECTOR_ENDS.map((e) => {
        const active = (value.ends ?? "one") === e;
        return (
          <button
            key={e}
            className="chrome-btn"
            onClick={() => onChange({ ends: e })}
            aria-label={`${e} arrowheads`}
            title={
              e === "one" ? "Arrow at end" : e === "both" ? "Arrows both ends" : "No arrows"
            }
            style={{
              width: 30,
              height: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm)",
              background: active ? "var(--text)" : "transparent",
              color: active ? "var(--bg)" : "var(--text)",
            }}
          >
            <EndsGlyph ends={e} />
          </button>
        );
      })}
    </div>
  );
};

// Connector tool: sets the defaults new connectors are drawn with.
const ConnectorOptions = ({
  connector,
  theme,
  dispatch,
}: {
  connector: ConnectorStyle;
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => (
  <ConnectorControls
    value={connector}
    theme={theme}
    onChange={(patch) => dispatch({ type: "setConnector", patch })}
  />
);

// Editing a single already-drawn connector in place (color/width/shape/arrows).
const SelectedConnectorOptions = ({
  item,
  theme,
  dispatch,
}: {
  item: ConnectorItem;
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => (
  <ConnectorControls
    value={{
      color: item.color ?? paletteFor(theme)[0],
      width: item.strokeWidth ?? 1.75,
      shape: item.shape ?? "straight",
      ends: item.ends ?? "one",
    }}
    theme={theme}
    onChange={(patch) => {
      dispatch({ type: "commitHistory" });
      const p: Partial<ConnectorItem> = {};
      if (patch.color !== undefined) p.color = patch.color;
      if (patch.width !== undefined) p.strokeWidth = patch.width;
      if (patch.shape !== undefined) p.shape = patch.shape;
      if (patch.ends !== undefined) p.ends = patch.ends;
      dispatch({ type: "updateItem", id: item.id, patch: p });
    }}
  />
);

// ---- Shape tool (rectangle / ellipse / sticky note) --------------------------

const SHAPE_KINDS = ["rect", "ellipse", "note"] as const;
// Fill options. "transparent" = outline-only. The rest are soft tints that read
// on either theme; the first color is the classic sticky-note yellow.
const SHAPE_FILLS = [
  "transparent",
  NOTE_FILL,
  "#a5d8ff",
  "#b2f2bb",
  "#ffc9c9",
  "#d0bfff",
  "#e9ecef",
] as const;
// Stroke options: "transparent" = no border, then ink + a couple of accents.
const SHAPE_STROKES = ["transparent", "#0a0a0a", "#4c7ef3", "#e5484d"] as const;
const SHAPE_WIDTHS = [1, 2, 4] as const;

// A round swatch. "transparent" renders as an outlined circle with a slash so
// "no fill / no border" is visually distinct from a white fill.
const Swatch = ({
  color,
  active,
  onClick,
  label,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
  label: string;
}) => (
  <button
    onClick={onClick}
    aria-label={label}
    title={label}
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
        position: "relative",
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: color === "transparent" ? "var(--surface)" : color,
        border: "1px solid var(--border)",
        boxShadow: active
          ? "0 0 0 2px var(--surface), 0 0 0 4px var(--selection)"
          : "none",
        overflow: "hidden",
      }}
    >
      {color === "transparent" && (
        <span
          style={{
            position: "absolute",
            left: -1,
            top: 6,
            width: 18,
            height: 1.5,
            background: "var(--danger, #e5484d)",
            transform: "rotate(-45deg)",
            transformOrigin: "center",
          }}
        />
      )}
    </span>
  </button>
);

// Shared kind / fill / stroke / width controls, used by both the shape tool
// (setting defaults) and a selected shape (editing in place).
const ShapeControls = ({
  value,
  onChange,
}: {
  value: ShapeStyle;
  onChange: (patch: Partial<ShapeStyle>) => void;
}) => (
  <div
    className="glass cr-rise-cx"
    style={{
      position: "fixed",
      bottom: 88,
      left: "50%",
      transform: "translateX(-50%)",
      display: "flex",
      alignItems: "center",
      gap: 6,
      padding: "8px 12px",
      zIndex: 1000,
    }}
  >
    {/* Kind */}
    {SHAPE_KINDS.map((k) => {
      const active = value.kind === k;
      return (
        <button
          key={k}
          className="chrome-btn"
          onClick={() => {
            // A note with no fill reads as an empty outline, so give it the
            // sticky-note yellow when there's nothing to show.
            const patch: Partial<ShapeStyle> = { kind: k };
            if (k === "note" && value.fill === "transparent") patch.fill = NOTE_FILL;
            onChange(patch);
          }}
          aria-label={k === "note" ? "Sticky note" : k === "rect" ? "Rectangle" : "Ellipse"}
          title={k === "note" ? "Sticky note" : k === "rect" ? "Rectangle" : "Ellipse"}
          style={{
            width: 30,
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-sm)",
            background: active ? "var(--text)" : "transparent",
            color: active ? "var(--bg)" : "var(--text)",
          }}
        >
          <ShapeKindGlyph kind={k} />
        </button>
      );
    })}
    <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
    {/* Fill */}
    {SHAPE_FILLS.map((c) => (
      <Swatch
        key={c}
        color={c}
        active={value.fill === c}
        onClick={() => onChange({ fill: c })}
        label={c === "transparent" ? "No fill" : `Fill ${c}`}
      />
    ))}
    <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
    {/* Stroke */}
    {SHAPE_STROKES.map((c) => (
      <Swatch
        key={c}
        color={c}
        active={value.stroke === c}
        onClick={() => onChange({ stroke: c })}
        label={c === "transparent" ? "No border" : `Border ${c}`}
      />
    ))}
    <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 2px" }} />
    {/* Stroke width */}
    {SHAPE_WIDTHS.map((w) => {
      const active = Math.abs(value.strokeWidth - w) < 0.01;
      return (
        <button
          key={w}
          onClick={() => onChange({ strokeWidth: w })}
          aria-label={`Border width ${w}`}
          title={`${w}px border`}
          style={{
            width: 26,
            height: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: active ? "var(--text)" : "transparent",
            borderRadius: "var(--radius-sm)",
          }}
        >
          <span
            style={{
              display: "block",
              width: 16,
              height: w,
              borderRadius: w,
              background: active ? "var(--bg)" : "var(--text)",
            }}
          />
        </button>
      );
    })}
  </div>
);

// Shape tool: sets the defaults new shapes are drawn with.
const ShapeOptions = ({
  shape,
  dispatch,
}: {
  shape: ShapeStyle;
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => (
  <ShapeControls
    value={shape}
    onChange={(patch) => dispatch({ type: "setShape", patch })}
  />
);

// Editing a single already-drawn shape in place. A note's text color follows the
// fill's contrast, so changing the fill re-derives readable text.
const SelectedShapeOptions = ({
  item,
  dispatch,
}: {
  item: ShapeItem;
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => (
  <ShapeControls
    value={{
      kind: item.shape,
      fill: item.fill,
      stroke: item.stroke,
      strokeWidth: item.strokeWidth,
    }}
    onChange={(patch) => {
      dispatch({ type: "commitHistory" });
      const p: Partial<ShapeItem> = {};
      if (patch.kind !== undefined) p.shape = patch.kind;
      if (patch.fill !== undefined) {
        p.fill = patch.fill;
        // Keep note text legible against the new fill.
        if (item.shape === "note") p.textColor = noteTextColor(patch.fill);
      }
      if (patch.stroke !== undefined) p.stroke = patch.stroke;
      if (patch.strokeWidth !== undefined) p.strokeWidth = patch.strokeWidth;
      dispatch({ type: "updateItem", id: item.id, patch: p });
    }}
  />
);

// Kind glyphs for the shape picker.
const ShapeKindGlyph = ({ kind }: { kind: "rect" | "ellipse" | "note" }) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
    {kind === "ellipse" ? (
      <ellipse cx="9" cy="9" rx="7" ry="5.5" stroke="currentColor" strokeWidth="1.5" />
    ) : kind === "note" ? (
      <path
        d="M3 3 H15 V11 L11 15 H3 Z M15 11 H11 V15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
    ) : (
      <rect x="2.5" y="3.5" width="13" height="11" rx="1" stroke="currentColor" strokeWidth="1.5" />
    )}
  </svg>
);

// Small line glyphs for the connector shape/arrowhead pickers.
const ShapeGlyph = ({ shape }: { shape: "straight" | "curved" | "elbow" }) => {
  const d =
    shape === "curved"
      ? "M3 15 C 8 15, 12 5, 17 5"
      : shape === "elbow"
        ? "M3 15 L 10 15 L 10 5 L 17 5"
        : "M3 15 L 17 5";
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const EndsGlyph = ({ ends }: { ends: "one" | "both" | "none" }) => (
  <svg width="22" height="20" viewBox="0 0 22 20" fill="none" aria-hidden>
    <path d="M4 10 H18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    {ends !== "none" && (
      <path
        d="M14 6 L18 10 L14 14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )}
    {ends === "both" && (
      <path
        d="M8 6 L4 10 L8 14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )}
  </svg>
);

// Recolor / resize already-drawn strokes. Same panel as the pen, but it writes
// the chosen color + width onto every selected drawing's strokes (undoable).
const DrawingOptions = ({
  drawings,
  theme,
  dispatch,
}: {
  drawings: DrawingItem[];
  theme: "light" | "dark";
  dispatch: React.Dispatch<Action>;
}) => {
  const palette = paletteFor(theme);
  const sample = drawings[0]?.strokes[0];

  const applyColor = (c: string) => {
    dispatch({ type: "commitHistory" });
    for (const d of drawings) {
      dispatch({
        type: "updateItem",
        id: d.id,
        patch: { strokes: d.strokes.map((s) => ({ ...s, color: c })) },
      });
    }
  };
  const applyWidth = (w: number) => {
    dispatch({ type: "commitHistory" });
    for (const d of drawings) {
      dispatch({
        type: "updateItem",
        id: d.id,
        patch: { strokes: d.strokes.map((s) => ({ ...s, strokeWidth: w })) },
      });
    }
  };

  return (
    <div
      className="glass cr-rise-cx"
      style={{
        position: "fixed",
        bottom: 88,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 12px",
        zIndex: 1000,
      }}
    >
      {palette.map((c) => {
        const active = sample?.color === c;
        return (
          <button
            key={c}
            className="cr-swatch"
            onClick={() => applyColor(c)}
            aria-label={`Color ${c}`}
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
        const active = sample !== undefined && Math.abs(sample.strokeWidth - w) < 0.01;
        return (
          <button
            key={w}
            className="cr-swatch"
            onClick={() => applyWidth(w)}
            aria-label={`Width ${w}`}
            title={`${w}px`}
            style={{
              width: 26,
              height: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: active ? "var(--text)" : "transparent",
              borderRadius: "var(--radius-sm)",
            }}
          >
            <span
              style={{
                display: "block",
                width: 16,
                height: w,
                borderRadius: w,
                background: active ? "var(--bg)" : sample?.color ?? "var(--text)",
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

// Text ink colors. "Auto" (undefined) follows the theme foreground so it keeps
// inverting on light/dark like plain text always has; the rest are fixed.
const TEXT_COLORS: { label: string; value: string | undefined }[] = [
  { label: "Auto (follows theme)", value: undefined },
  ...PEN_PRIMARIES.map((c) => ({ label: c, value: c as string })),
];

// Note fill / highlight. Undefined = the default surface card. "transparent" =
// no card at all (floating-label look). The tints are low-alpha so they read on
// both light and dark canvases.
const TEXT_FILLS: { label: string; value: string | undefined; kind?: "card" | "none" }[] = [
  { label: "Card", value: undefined, kind: "card" },
  { label: "No fill", value: "transparent", kind: "none" },
  { label: "Amber", value: "rgba(245,166,35,0.18)" },
  { label: "Green", value: "rgba(48,163,108,0.16)" },
  { label: "Blue", value: "rgba(76,126,243,0.16)" },
];

const TEXT_ALIGNS = ["left", "center", "right"] as const;

const TextOptions = ({
  state,
  dispatch,
}: {
  state: State;
  dispatch: React.Dispatch<Action>;
}) => {
  // Read current style from any one selected text item to show active states
  // (rough match, since a multi-select could hold mixed styles).
  const sample = state.board.items.find(
    (it): it is Extract<typeof it, { type: "text" }> =>
      it.type === "text" && state.selection.has(it.id),
  );

  const patchAll = (patch: Partial<TextItem>) => {
    dispatch({ type: "commitHistory" });
    for (const it of state.board.items) {
      if (it.type !== "text" || !state.selection.has(it.id)) continue;
      dispatch({ type: "updateItem", id: it.id, patch });
    }
  };

  return (
    <div
      className="glass cr-rise-cx"
      style={{
        position: "fixed",
        bottom: 88,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: 6,
        zIndex: 1000,
      }}
    >
      {/* Size presets */}
      {TEXT_PRESETS.map((p) => {
        const active =
          sample !== undefined &&
          sample.fontSize === p.size &&
          (sample.fontWeight ?? 400) === p.weight;
        return (
          <button
            key={p.label}
            onClick={() => patchAll({ fontSize: p.size, fontWeight: p.weight })}
            title={`${p.label} (${p.size}px${p.weight >= 600 ? " bold" : ""})`}
            style={{
              minWidth: 44,
              height: 32,
              padding: "0 9px",
              borderRadius: "var(--radius-sm)",
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

      <VDivider />

      {/* Ink color */}
      {TEXT_COLORS.map((c) => {
        const active = (sample?.color ?? undefined) === c.value;
        return (
          <button
            key={c.label}
            className="cr-swatch"
            onClick={() => patchAll({ color: c.value })}
            title={`Text: ${c.label}`}
            aria-label={`Text color ${c.label}`}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              boxShadow: active ? "0 0 0 2px var(--selection)" : "none",
            }}
          >
            <span
              style={{
                width: 15,
                height: 15,
                borderRadius: "50%",
                background: c.value ?? "var(--text)",
                border: c.value ? "none" : "1px solid var(--border-strong)",
              }}
            />
          </button>
        );
      })}

      <VDivider />

      {/* Note fill / highlight */}
      {TEXT_FILLS.map((f) => {
        const active = (sample?.bg ?? undefined) === f.value;
        return (
          <button
            key={f.label}
            className="cr-swatch"
            onClick={() => patchAll({ bg: f.value })}
            title={`Fill: ${f.label}`}
            aria-label={`Text fill ${f.label}`}
            style={{
              width: 24,
              height: 22,
              borderRadius: 5,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              boxShadow: active ? "0 0 0 2px var(--selection)" : "none",
            }}
          >
            <span
              style={{
                width: 16,
                height: 15,
                borderRadius: 3,
                background:
                  f.kind === "card"
                    ? "var(--surface-2)"
                    : f.kind === "none"
                      ? "transparent"
                      : f.value,
                border:
                  f.kind === "none"
                    ? "1px dashed var(--border-strong)"
                    : "1px solid var(--border)",
              }}
            />
          </button>
        );
      })}

      <VDivider />

      {/* Alignment */}
      {TEXT_ALIGNS.map((a) => {
        const active = (sample?.align ?? "left") === a;
        return (
          <button
            key={a}
            className="chrome-btn"
            onClick={() => patchAll({ align: a })}
            title={`Align ${a}`}
            aria-label={`Align ${a}`}
            style={{
              width: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--radius-sm)",
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
            <AlignIcon align={a} />
          </button>
        );
      })}
    </div>
  );
};

const VDivider = () => (
  <div style={{ width: 1, height: 22, background: "var(--border)", margin: "0 2px" }} />
);

const AlignIcon = ({ align }: { align: "left" | "center" | "right" }) => {
  // Four lines; the short ones shift to match the alignment.
  const rows =
    align === "left"
      ? ["2,5 16,5", "2,9 11,9", "2,13 16,13", "2,17 11,17"]
      : align === "right"
        ? ["6,5 20,5", "11,9 20,9", "6,13 20,13", "11,17 20,17"]
        : ["4,5 18,5", "7,9 15,9", "4,13 18,13", "7,17 15,17"];
  return (
    <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden>
      {rows.map((pts, i) => (
        <polyline
          key={i}
          points={pts}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
};

// Align + distribute panel, shown when 2+ items are selected. Operates on the
// selection's bounding box in world coords and dispatches new positions in one
// undoable step. Distribute needs 3+ items (spaces the middle ones evenly by
// center between the two extremes).
type AGlyphType =
  | "left" | "cx" | "right"
  | "top" | "cy" | "bottom"
  | "dh" | "dv";

const AlignOptions = ({
  state,
  dispatch,
}: {
  state: State;
  dispatch: React.Dispatch<Action>;
}) => {
  const sel = state.board.items.filter(
    (it) => state.selection.has(it.id) && it.type !== "connector",
  );
  if (sel.length < 2) return null;

  const minX = Math.min(...sel.map((i) => i.x));
  const maxR = Math.max(...sel.map((i) => i.x + i.w));
  const minY = Math.min(...sel.map((i) => i.y));
  const maxB = Math.max(...sel.map((i) => i.y + i.h));

  const commit = (positions: { id: string; x: number; y: number }[]) => {
    dispatch({ type: "commitHistory" });
    dispatch({ type: "setItemPositions", positions });
  };

  const alignH = (mode: "left" | "cx" | "right") =>
    commit(
      sel.map((i) => ({
        id: i.id,
        y: i.y,
        x:
          mode === "left"
            ? minX
            : mode === "right"
              ? maxR - i.w
              : (minX + maxR) / 2 - i.w / 2,
      })),
    );
  const alignV = (mode: "top" | "cy" | "bottom") =>
    commit(
      sel.map((i) => ({
        id: i.id,
        x: i.x,
        y:
          mode === "top"
            ? minY
            : mode === "bottom"
              ? maxB - i.h
              : (minY + maxB) / 2 - i.h / 2,
      })),
    );
  const distribute = (axis: "dh" | "dv") => {
    if (sel.length < 3) return;
    const c = (i: (typeof sel)[number]) =>
      axis === "dh" ? i.x + i.w / 2 : i.y + i.h / 2;
    const sorted = [...sel].sort((a, b) => c(a) - c(b));
    const firstC = c(sorted[0]);
    const lastC = c(sorted[sorted.length - 1]);
    const n = sorted.length;
    commit(
      sorted.map((i, idx) => {
        const target = firstC + ((lastC - firstC) * idx) / (n - 1);
        return axis === "dh"
          ? { id: i.id, x: target - i.w / 2, y: i.y }
          : { id: i.id, x: i.x, y: target - i.h / 2 };
      }),
    );
  };

  const canDistribute = sel.length >= 3;

  const btn = (type: AGlyphType, title: string, run: () => void, disabled = false) => (
    <button
      key={type}
      className="chrome-btn"
      onClick={run}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        width: 30,
        height: 30,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        color: "var(--text)",
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <AGlyph type={type} />
    </button>
  );

  return (
    <div
      className="glass cr-rise-cx"
      style={{
        position: "fixed",
        bottom: 88,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: 6,
        zIndex: 1000,
      }}
    >
      {btn("left", "Align left", () => alignH("left"))}
      {btn("cx", "Align horizontal centers", () => alignH("cx"))}
      {btn("right", "Align right", () => alignH("right"))}
      <VDivider />
      {btn("top", "Align top", () => alignV("top"))}
      {btn("cy", "Align vertical centers", () => alignV("cy"))}
      {btn("bottom", "Align bottom", () => alignV("bottom"))}
      <VDivider />
      {btn(
        "dh",
        canDistribute ? "Distribute horizontally" : "Distribute needs 3+ items",
        () => distribute("dh"),
        !canDistribute,
      )}
      {btn(
        "dv",
        canDistribute ? "Distribute vertically" : "Distribute needs 3+ items",
        () => distribute("dv"),
        !canDistribute,
      )}
    </div>
  );
};

// Minimalist align/distribute glyphs: a reference edge line + a couple of bars.
const AGlyph = ({ type }: { type: AGlyphType }) => {
  const line = (p: Record<string, number>) => (
    <line {...p} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  );
  const bar = (x: number, y: number, w: number, h: number) => (
    <rect x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
  );
  let content: React.ReactNode = null;
  switch (type) {
    case "left":
      content = (<>{line({ x1: 3, y1: 3, x2: 3, y2: 17 })}{bar(4, 5, 11, 3)}{bar(4, 12, 7, 3)}</>);
      break;
    case "cx":
      content = (<>{line({ x1: 10, y1: 3, x2: 10, y2: 17 })}{bar(4, 5, 12, 3)}{bar(6, 12, 8, 3)}</>);
      break;
    case "right":
      content = (<>{line({ x1: 17, y1: 3, x2: 17, y2: 17 })}{bar(5, 5, 11, 3)}{bar(9, 12, 7, 3)}</>);
      break;
    case "top":
      content = (<>{line({ x1: 3, y1: 3, x2: 17, y2: 3 })}{bar(5, 4, 3, 11)}{bar(12, 4, 3, 7)}</>);
      break;
    case "cy":
      content = (<>{line({ x1: 3, y1: 10, x2: 17, y2: 10 })}{bar(5, 4, 3, 12)}{bar(12, 6, 3, 8)}</>);
      break;
    case "bottom":
      content = (<>{line({ x1: 3, y1: 17, x2: 17, y2: 17 })}{bar(5, 5, 3, 11)}{bar(12, 9, 3, 7)}</>);
      break;
    case "dh":
      content = (<>{bar(3, 5, 3, 10)}{bar(8.5, 5, 3, 10)}{bar(14, 5, 3, 10)}</>);
      break;
    case "dv":
      content = (<>{bar(5, 3, 10, 3)}{bar(5, 8.5, 10, 3)}{bar(5, 14, 10, 3)}</>);
      break;
  }
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" aria-hidden>
      {content}
    </svg>
  );
};

// The lone selected item, iff it's a video — controls the trim panel's
// visibility (mirrors hasSelectedText for the text preset panel).
const selectedVideo = (state: State): VideoItem | null => {
  if (state.selection.size !== 1) return null;
  const [id] = state.selection;
  const it = state.board.items.find((i) => i.id === id);
  return it && it.type === "video" ? it : null;
};

const selectedConnectorItem = (state: State): ConnectorItem | null => {
  if (state.selection.size !== 1) return null;
  const [id] = state.selection;
  const it = state.board.items.find((i) => i.id === id);
  return it && it.type === "connector" ? it : null;
};

const selectedShapeItem = (state: State): ShapeItem | null => {
  if (state.selection.size !== 1) return null;
  const [id] = state.selection;
  const it = state.board.items.find((i) => i.id === id);
  return it && it.type === "shape" ? it : null;
};

// Trim + loop panel shown when a single video is selected. A dual-handle
// scrubber sets [clipStart, clipEnd] against the video's full duration; the
// loop/sound toggles flip the item's flags. All writes go through updateItem,
// with a single commitHistory snapshot taken on drag start so a scrub is one
// undo step.
const VideoOptions = ({
  item,
  dispatch,
}: {
  item: VideoItem;
  dispatch: React.Dispatch<Action>;
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | "start" | "end">(null);
  const [drag, setDrag] = useState<null | "start" | "end">(null);
  const dur = item.duration ?? 0;
  const end = item.clipEnd ?? dur;

  // Live playhead: drive the marker's position with rAF straight from the
  // player's clock — no React re-render per frame, so it stays buttery.
  useEffect(() => {
    if (dur <= 0) return;
    let raf = 0;
    const tick = () => {
      const ctrl = getVideoController(item.id);
      const ph = playheadRef.current;
      if (ctrl && ph) {
        const pct = Math.min(100, Math.max(0, (ctrl.getTime() / dur) * 100));
        ph.style.left = `${pct}%`;
        ph.style.opacity = "1";
      } else if (ph) {
        ph.style.opacity = "0";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dur, item.id]);

  const timeFromX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return frac * dur;
  };

  useEffect(() => {
    if (dur <= 0) return;
    const move = (e: PointerEvent) => {
      const which = dragRef.current;
      if (!which) return;
      const t = timeFromX(e.clientX);
      if (which === "start") {
        const ns = Math.max(0, Math.min(t, (item.clipEnd ?? dur) - 0.2));
        dispatch({ type: "updateItem", id: item.id, patch: { clipStart: ns } });
      } else {
        const ne = Math.min(dur, Math.max(t, item.clipStart + 0.2));
        dispatch({ type: "updateItem", id: item.id, patch: { clipEnd: ne } });
      }
    };
    const up = () => {
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dur, item.id, item.clipStart, item.clipEnd, dispatch]);

  const startPct = dur > 0 ? (item.clipStart / dur) * 100 : 0;
  const endPct = dur > 0 ? (end / dur) * 100 : 100;
  // Grow the scrubber with the video's length so long clips are easier to trim.
  // Base ~220px, up to ~+25% (≈275px) for long videos.
  const trackMin = Math.round(220 + Math.min(56, dur / 10));

  // Click anywhere on the track (not a handle) to jump the playhead there.
  const seekAt = (clientX: number) => {
    const t = Math.min(end, Math.max(item.clipStart, timeFromX(clientX)));
    getVideoController(item.id)?.seek(t);
  };

  return (
    <div
      className="glass cr-rise-cx"
      style={{
        position: "fixed",
        bottom: 88,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        zIndex: 1000,
        minWidth: 400,
      }}
    >
      {dur <= 0 ? (
        <span style={{ fontSize: 12, color: "var(--text-3)", padding: "2px 4px" }}>
          Reading video…
        </span>
      ) : (
        <>
          <TimeLabel value={formatClock(item.clipStart)} />
          <div
            ref={trackRef}
            onPointerDown={(e) => seekAt(e.clientX)}
            style={{
              position: "relative",
              flex: 1,
              height: 30,
              minWidth: trackMin,
              cursor: "pointer",
            }}
          >
            {/* base track */}
            <div
              style={{
                position: "absolute",
                top: 13,
                left: 0,
                right: 0,
                height: 5,
                borderRadius: 3,
                background: "var(--border-strong)",
              }}
            />
            {/* selected clip region */}
            <div
              style={{
                position: "absolute",
                top: 13,
                left: `${startPct}%`,
                width: `${Math.max(0, endPct - startPct)}%`,
                height: 5,
                borderRadius: 3,
                background: "var(--text)",
              }}
            />
            {/* live playhead */}
            <div
              ref={playheadRef}
              style={{
                position: "absolute",
                top: 3,
                bottom: 3,
                left: "0%",
                width: 2,
                marginLeft: -1,
                borderRadius: 1,
                background: "var(--text-2)",
                opacity: 0,
                pointerEvents: "none",
                transition: "opacity 150ms ease",
              }}
            />
            <TrimHandle
              pct={startPct}
              bubble={drag === "start" ? formatClock(item.clipStart) : null}
              onDown={() => {
                dispatch({ type: "commitHistory" });
                dragRef.current = "start";
                setDrag("start");
              }}
            />
            <TrimHandle
              pct={endPct}
              bubble={drag === "end" ? formatClock(end) : null}
              onDown={() => {
                dispatch({ type: "commitHistory" });
                dragRef.current = "end";
                setDrag("end");
              }}
            />
          </div>
          <TimeLabel value={formatClock(end)} muted />
          <div style={{ width: 1, height: 18, background: "var(--border)" }} />
          <PanelToggle
            active={item.loop}
            label="Loop"
            onClick={() =>
              dispatch({ type: "updateItem", id: item.id, patch: { loop: !item.loop } })
            }
          />
          <PanelToggle
            active={!item.muted}
            label={item.muted ? "Muted" : "Sound"}
            onClick={() =>
              dispatch({ type: "updateItem", id: item.id, patch: { muted: !item.muted } })
            }
          />
        </>
      )}
    </div>
  );
};

const TimeLabel = ({ value, muted }: { value: string; muted?: boolean }) => (
  <span
    style={{
      fontSize: 11,
      color: muted ? "var(--text-3)" : "var(--text-2)",
      fontVariantNumeric: "tabular-nums",
      minWidth: 38,
      textAlign: "center",
    }}
  >
    {value}
  </span>
);

const TrimHandle = ({
  pct,
  bubble,
  onDown,
}: {
  pct: number;
  bubble: string | null;
  onDown: () => void;
}) => (
  <div
    className="cr-trim-handle"
    onPointerDown={(e) => {
      e.preventDefault();
      e.stopPropagation();
      onDown();
    }}
    style={{
      position: "absolute",
      top: "50%",
      left: `${pct}%`,
      transform: "translate(-50%, -50%)",
      width: 16,
      height: 16,
      borderRadius: "50%",
      background: "var(--surface)",
      border: "2.5px solid var(--text)",
      boxShadow: "var(--shadow)",
      cursor: "ew-resize",
      touchAction: "none",
    }}
  >
    {bubble && (
      <span
        className="glass"
        style={{
          position: "absolute",
          bottom: "calc(100% + 8px)",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "3px 7px",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          color: "var(--text)",
          pointerEvents: "none",
        }}
      >
        {bubble}
      </span>
    )}
  </div>
);

const PanelToggle = ({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) => (
  <button
    className="chrome-btn"
    onClick={onClick}
    style={{
      height: 28,
      padding: "0 10px",
      fontSize: 12,
      borderRadius: "var(--radius-sm)",
      border: "1px solid var(--border)",
      background: active ? "var(--text)" : "transparent",
      color: active ? "var(--bg)" : "var(--text)",
    }}
  >
    {label}
  </button>
);

// Tiny "Saving…" / "Saved" indicator. Stays mounted so the layout doesn't
// jump; opacity transitions in/out on activity.
const SaveIndicator = ({ status }: { status: SaveStatus }) => {
  // Show while saving, and for ~1.5s after a successful save. A failed save
  // stays up (and reads as an alert) until the next successful write, so the
  // user can't miss that their recent changes aren't persisted.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (status.failed || status.pending) {
      setVisible(true);
      return;
    }
    if (status.savedAt) {
      setVisible(true);
      const t = setTimeout(() => setVisible(false), 1500);
      return () => clearTimeout(t);
    }
  }, [status.pending, status.savedAt, status.failed]);

  const danger = "var(--danger, #e5484d)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 11,
        fontWeight: status.failed ? 600 : 400,
        color: status.failed ? danger : "var(--text-3)",
        justifyContent: "flex-end",
        whiteSpace: "nowrap",
        opacity: visible ? 1 : 0,
        transition: "opacity 200ms ease",
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none",
      }}
      role={status.failed ? "alert" : undefined}
      aria-live={status.failed ? "assertive" : "polite"}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: status.failed
            ? danger
            : status.pending
              ? "var(--text-faint)"
              : "var(--text-2)",
        }}
      />
      {status.failed
        ? "Can't save — storage full"
        : status.pending
          ? "Saving…"
          : "Saved"}
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
    className="chrome-btn"
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
      borderRadius: "var(--radius-sm)",
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
  const glide = (target: View) =>
    animateView(view, target, (v) => dispatch({ type: "setView", view: v }));
  const stepZoom = (factor: number) => {
    glide(zoomCenter(view, window.innerWidth, window.innerHeight, factor));
  };
  const fit = () => {
    glide(
      items.length === 0
        ? { x: 0, y: 0, zoom: 1 }
        : fitToBounds(items, window.innerWidth, window.innerHeight),
    );
  };
  return (
    <div
      className="glass"
      style={{
        position: "fixed",
        right: 14,
        bottom: 18,
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
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
        className="chrome-btn"
        onClick={() => setOpen(true)}
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        style={{
          width: 28,
          height: 28,
          fontSize: 13,
          color: "var(--text-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
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
    ["V / T / P / C", "Select / Text / Pen / Connector"],
    [`${mod}Z`, "Undo"],
    [`${isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"}`, "Redo"],
    [`${mod}D`, "Duplicate"],
    [`${mod}A`, "Select all"],
    [`${mod}C / ${mod}X / ${mod}V`, "Copy / cut / paste items"],
    [`${mod}] / ${mod}[`, "Bring forward / send back"],
    [`${mod}0 / ${mod}1`, "Reset zoom / fit content"],
    [`${mod}J`, "Zoom to selection"],
    [`${mod}F`, "Find on board"],
    ["Alt + pen", "Eraser (drag through drawings)"],
    ["Double-click tool", "Lock tool (stay-in-tool mode)"],
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
      className="cr-fade"
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
        className="cr-modal"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          borderRadius: "var(--radius)",
          padding: 22,
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
                    fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
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
    className="chrome-btn"
    onClick={onClick}
    style={{
      padding: "6px 12px",
      fontSize: 12,
      fontWeight: 500,
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)",
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
  subtitle,
}: {
  children: React.ReactNode;
  onClick: () => void;
  // Optional dim line below the main label, used to show backup folder path,
  // last-saved timestamp, etc.
  subtitle?: string;
}) => (
  <button
    className="chrome-btn"
    onClick={onClick}
    style={{
      display: "block",
      width: "100%",
      textAlign: "left",
      padding: "8px 10px",
      fontSize: 13,
      borderRadius: "var(--radius-sm)",
    }}
    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
  >
    <div>{children}</div>
    {subtitle && (
      <div
        style={{
          fontSize: 11,
          color: "var(--text-3)",
          marginTop: 2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 280,
        }}
      >
        {subtitle}
      </div>
    )}
  </button>
);

// "5 minutes ago" / "just now" formatting for the backup status line. Updates
// only when the menu rerenders, which is fine — the absolute timestamp is in
// the title attribute if you really want precision.
const formatRelative = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
};

const Sep = () => (
  <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
);

const ToolButton = ({
  active,
  locked,
  onClick,
  onDoubleClick,
  label,
  shortcut,
  children,
}: {
  active?: boolean;
  locked?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}) => (
  <button
    className="chrome-btn"
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    title={
      shortcut
        ? `${label} (${shortcut})${onDoubleClick ? " — double-click to lock" : ""}`
        : label
    }
    aria-label={label}
    style={{
      // Transparent — the sliding .tool-pill chip behind provides the active
      // affordance. The active icon brightens to full --text; inactive icons sit
      // dimmed at --text-3 so they stay legible even as the chip passes over them.
      position: "relative",
      width: 36,
      height: 36,
      borderRadius: "var(--radius-sm)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "transparent",
      color: active ? "var(--text)" : "var(--text-3)",
      transition: "color 200ms ease",
    }}
    onMouseEnter={(e) => {
      if (!active) e.currentTarget.style.background = "var(--hover)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = "transparent";
    }}
  >
    {children}
    {locked && (
      <span
        aria-hidden
        style={{
          position: "absolute",
          right: 4,
          bottom: 4,
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: active ? "var(--text)" : "var(--text-3)",
        }}
      />
    )}
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
const ConnectorIcon = () => (
  <Stroke>
    <circle cx="5" cy="19" r="2" />
    <path d="M6.5 17.5L18 6" />
    <path d="M14 6h5v5" />
  </Stroke>
);
const ShapeToolIcon = () => (
  <Stroke>
    <rect x="3" y="4" width="10" height="8" rx="1" />
    <circle cx="16" cy="15" r="5" />
  </Stroke>
);
