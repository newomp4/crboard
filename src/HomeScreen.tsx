import { useEffect, useState } from "react";
import {
  createNewBoard,
  deleteBoardById,
  listBoards,
  loadBoardById,
  type BoardMeta,
} from "./boards";
import type { Board, Item } from "./types";

type Props = {
  onOpen: (id: string, board: Board) => void;
};

// Shared with the editor's store so the theme picked in either place sticks.
const THEME_KEY = "crboard:theme";
type Theme = "light" | "dark";

const initialTheme = (): Theme => {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

export const HomeScreen = ({ onOpen }: Props) => {
  const [boards, setBoards] = useState<BoardMeta[]>(() => listBoards());
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Home screen owns the theme when no board is open, so the whole app stays on
  // one setting instead of the canvas being dark while this page is light.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    setBoards(listBoards());
  }, []);

  const open = (meta: BoardMeta) => {
    const board = loadBoardById(meta.id);
    if (board) onOpen(meta.id, board);
  };

  const create = () => {
    const { id, board } = createNewBoard();
    onOpen(id, board);
  };

  const remove = (id: string) => {
    if (!confirm("Delete this board? This cannot be undone.")) return;
    deleteBoardById(id);
    setBoards(listBoards());
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--bg)",
        overflowY: "auto",
        fontFamily:
          "'Geist', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {/* ── Top bar ── */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 32px",
          height: 52,
          borderBottom: "1px solid var(--border)",
          background: "var(--glass-bg)",
          WebkitBackdropFilter: "var(--glass-blur)",
          backdropFilter: "var(--glass-blur)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em" }}>
          crboard
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            className="chrome-btn"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={`${theme === "dark" ? "Light" : "Dark"} mode`}
            aria-label="Toggle theme"
            style={{
              width: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--surface)",
            }}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            className="chrome-btn"
            onClick={create}
            style={{
              padding: "7px 15px",
              fontSize: 12,
              fontWeight: 500,
              background: "var(--text)",
              color: "var(--bg)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
            }}
          >
            + New board
          </button>
        </div>
      </div>

      {/* ── Board grid ── */}
      <div style={{ padding: "32px", maxWidth: 1180, margin: "0 auto" }}>
        {boards.length === 0 ? (
          <EmptyState onCreate={create} />
        ) : (
          <div
            className="cr-fade"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
              gap: 16,
            }}
          >
            {boards.map((meta) => (
              <BoardCard
                key={meta.id}
                meta={meta}
                onOpen={() => open(meta)}
                onDelete={() => remove(meta.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ── Board card ────────────────────────────────────────────────────────────────

const BoardCard = ({
  meta,
  onOpen,
  onDelete,
}: {
  meta: BoardMeta;
  onOpen: () => void;
  onDelete: () => void;
}) => {
  const [hovered, setHovered] = useState(false);
  // Load the full board for a faithful preview (real images/text/drawings).
  // Lazy per-card so the grid paints instantly and heavy boards don't block.
  const [board, setBoard] = useState<Board | null>(null);
  useEffect(() => {
    setBoard(loadBoardById(meta.id));
  }, [meta.id]);

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface)",
        cursor: "pointer",
        userSelect: "none",
        overflow: "hidden",
        transform: hovered ? "translateY(-3px)" : "translateY(0)",
        boxShadow: hovered ? "var(--shadow-lg)" : "0 1px 2px rgba(0,0,0,0.04)",
        transition:
          "transform 160ms cubic-bezier(0.2,0.7,0.3,1), box-shadow 160ms ease, border-color 160ms ease",
        borderColor: hovered ? "var(--border-strong)" : "var(--border)",
      }}
    >
      {/* Preview */}
      <div
        className="dot-grid"
        style={{
          position: "relative",
          aspectRatio: "16 / 10",
          background: "var(--bg)",
          backgroundSize: "12px 12px",
          borderBottom: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {board && <MiniBoard board={board} />}
        {/* Delete button — only on hover */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete board"
          className="chrome-btn"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 24,
            height: 24,
            fontSize: 15,
            lineHeight: "1",
            color: "var(--text-2)",
            background: "var(--glass-bg)",
            WebkitBackdropFilter: "var(--glass-blur)",
            backdropFilter: "var(--glass-blur)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            opacity: hovered ? 1 : 0,
            transition: "opacity 120ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-2)")}
        >
          ×
        </button>
      </div>

      {/* Meta */}
      <div style={{ padding: "12px 14px 13px" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text)",
            marginBottom: 4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {meta.name || "Untitled board"}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-3)" }}>
          {meta.itemCount} item{meta.itemCount !== 1 ? "s" : ""}
          &nbsp;&middot;&nbsp;
          {formatRelative(meta.updatedAt)}
        </div>
      </div>
    </div>
  );
};

// ── Thumbnail: a faithful mini-render of the board ────────────────────────────

// Draws the actual board in miniature: real images, real (wrapped) text with its
// fill/color, drawings as vector strokes, links/embeds/videos as labelled cards,
// and connectors as faint lines. The whole thing is one SVG whose viewBox is the
// board's content bounds, scaled to fit the card — so a preview looks like the
// board, not an abstract diagram.
const MiniBoard = ({ board }: { board: Board }) => {
  const items = board.items;
  const drawable = items.filter((it) => it.type !== "connector");
  if (drawable.length === 0) return <EmptyLabel />;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of drawable) {
    if (it.x < minX) minX = it.x;
    if (it.y < minY) minY = it.y;
    if (it.x + it.w > maxX) maxX = it.x + it.w;
    if (it.y + it.h > maxY) maxY = it.y + it.h;
  }
  const W = Math.max(1, maxX - minX);
  const H = Math.max(1, maxY - minY);
  const pad = 0.06 * Math.max(W, H);

  const byId = new Map(items.map((it) => [it.id, it]));
  const ordered = [...items].sort((a, b) => a.z - b.z);

  return (
    <svg
      className="cr-fade"
      viewBox={`${minX - pad} ${minY - pad} ${W + pad * 2} ${H + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      style={{ display: "block", position: "absolute", inset: 0, color: "var(--text)" }}
    >
      {ordered.map((it) => (
        <MiniItem key={it.id} it={it} byId={byId} />
      ))}
    </svg>
  );
};

const MiniItem = ({ it, byId }: { it: Item; byId: Map<string, Item> }) => {
  switch (it.type) {
    case "connector": {
      const a = byId.get(it.from);
      const b = byId.get(it.to);
      if (!a || !b) return null;
      return (
        <line
          x1={a.x + a.w / 2}
          y1={a.y + a.h / 2}
          x2={b.x + b.w / 2}
          y2={b.y + b.h / 2}
          stroke="var(--text-3)"
          strokeOpacity={0.6}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      );
    }
    case "image":
      return (
        <g>
          <image
            href={it.src}
            x={it.x}
            y={it.y}
            width={it.w}
            height={it.h}
            preserveAspectRatio="xMidYMid slice"
          />
          <rect
            x={it.x}
            y={it.y}
            width={it.w}
            height={it.h}
            fill="none"
            stroke="var(--border)"
            strokeOpacity={0.5}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      );
    case "text": {
      const transparent = it.bg === "transparent";
      const bg = it.bg === undefined ? "var(--surface-2)" : it.bg;
      return (
        <foreignObject x={it.x} y={it.y} width={it.w} height={it.h}>
          <div
            style={{
              width: "100%",
              height: "100%",
              boxSizing: "border-box",
              padding: 12,
              margin: 0,
              fontSize: it.fontSize,
              fontWeight: it.fontWeight ?? 400,
              lineHeight: 1.35,
              color: it.color ?? "var(--text)",
              background: transparent ? "transparent" : bg,
              border: transparent ? "1px solid transparent" : "1px solid var(--border)",
              textAlign: it.align ?? "left",
              overflow: "hidden",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "inherit",
            }}
          >
            {it.text || ""}
          </div>
        </foreignObject>
      );
    }
    case "shape": {
      const stroke = it.stroke === "transparent" ? "none" : it.stroke;
      const fill = it.fill === "transparent" ? "none" : it.fill;
      return (
        <>
          {it.shape === "ellipse" ? (
            <ellipse
              cx={it.x + it.w / 2}
              cy={it.y + it.h / 2}
              rx={it.w / 2}
              ry={it.h / 2}
              fill={fill}
              stroke={stroke}
              strokeWidth={it.strokeWidth}
            />
          ) : (
            <rect
              x={it.x}
              y={it.y}
              width={it.w}
              height={it.h}
              rx={it.shape === "note" ? 6 : 0}
              fill={fill}
              stroke={stroke}
              strokeWidth={it.strokeWidth}
            />
          )}
          {it.shape === "note" && it.text && (
            <foreignObject x={it.x} y={it.y} width={it.w} height={it.h}>
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  boxSizing: "border-box",
                  padding: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  fontSize: it.fontSize ?? 16,
                  lineHeight: 1.3,
                  color: it.textColor ?? "#0a0a0a",
                  overflow: "hidden",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "inherit",
                }}
              >
                {it.text}
              </div>
            </foreignObject>
          )}
        </>
      );
    }
    case "drawing":
      return (
        <svg
          x={it.x}
          y={it.y}
          width={it.w}
          height={it.h}
          viewBox={`0 0 ${it.vw ?? it.w} ${it.vh ?? it.h}`}
          preserveAspectRatio="none"
          overflow="visible"
        >
          {it.strokes.map((s, i) => (
            <path
              key={i}
              d={s.d}
              fill="none"
              stroke="var(--text)"
              strokeOpacity={0.85}
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      );
    case "video":
    case "embed":
    case "link":
      return <MiniCard it={it} />;
  }
};

// Cards for items we can't cheaply rasterize (embeds/videos/links): a bordered
// panel with the source label and a play glyph for playable media.
const MiniCard = ({
  it,
}: {
  it: Extract<Item, { type: "video" | "embed" | "link" }>;
}) => {
  const label =
    it.type === "video"
      ? it.kind === "youtube"
        ? "YouTube"
        : it.fileName || "Video"
      : it.type === "link"
        ? it.title || hostOf(it.url)
        : capitalize(it.provider || hostOf(it.url));
  const playable = it.type === "video" || it.type === "embed";
  return (
    <foreignObject x={it.x} y={it.y} width={it.w} height={it.h}>
      <div
        style={{
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          border: "1px solid var(--border)",
          background: "var(--surface-2)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          padding: 12,
          overflow: "hidden",
          fontFamily: "inherit",
        }}
      >
        {playable && (
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background: "var(--overlay-tint)",
              border: "1px solid var(--border-strong)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text)",
              fontSize: 20,
            }}
          >
            ▶
          </div>
        )}
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text)",
            textAlign: "center",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      </div>
    </foreignObject>
  );
};

const EmptyLabel = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 11,
      color: "var(--text-faint)",
      letterSpacing: "0.04em",
    }}
  >
    empty board
  </div>
);

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ── Empty state ───────────────────────────────────────────────────────────────

const EmptyState = ({ onCreate }: { onCreate: () => void }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "60vh",
      gap: 14,
      color: "var(--text-3)",
      fontSize: 13,
    }}
  >
    <div style={{ fontWeight: 600, color: "var(--text-2)" }}>No boards yet</div>
    <button
      className="chrome-btn"
      onClick={onCreate}
      style={{
        padding: "8px 20px",
        fontSize: 13,
        fontWeight: 500,
        background: "var(--text)",
        color: "var(--bg)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
      }}
    >
      Create your first board
    </button>
  </div>
);

// ── Icons ─────────────────────────────────────────────────────────────────────

const SunIcon = () => (
  <svg
    width="15"
    height="15"
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
    width="15"
    height="15"
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const formatRelative = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
};
