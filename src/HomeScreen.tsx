import { useEffect, useState } from "react";
import {
  createNewBoard,
  deleteBoardById,
  listBoards,
  loadBoardById,
  type BoardMeta,
} from "./boards";
import type { Board } from "./types";

type Props = {
  onOpen: (id: string, board: Board) => void;
};

export const HomeScreen = ({ onOpen }: Props) => {
  const [boards, setBoards] = useState<BoardMeta[]>(() => listBoards());

  // Keep the index fresh if the editor saved something while we weren't looking.
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
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
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
          background: "var(--chrome-bg)",
          backdropFilter: "blur(8px)",
        }}
      >
        <div
          style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.04em" }}
        >
          crboard
        </div>
        <button
          onClick={create}
          style={{
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 500,
            background: "var(--text)",
            color: "var(--bg)",
            border: "none",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.85")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
        >
          + New board
        </button>
      </div>

      {/* ── Board grid ── */}
      <div style={{ padding: "32px", maxWidth: 1100, margin: "0 auto" }}>
        {boards.length === 0 ? (
          <EmptyState onCreate={create} />
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 14,
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

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        padding: "18px 20px 16px",
        border: "1px solid var(--border)",
        background: hovered ? "var(--hover)" : "var(--surface)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {/* Delete button — only visible on hover */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete board"
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          width: 22,
          height: 22,
          fontSize: 15,
          lineHeight: "1",
          color: "var(--text-3)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          opacity: hovered ? 1 : 0,
          transition: "opacity 100ms",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-3)")}
      >
        ×
      </button>

      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text)",
          marginRight: 20,
          marginBottom: 8,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {meta.name || "Untitled board"}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-3)" }}>
        {meta.itemCount} item{meta.itemCount !== 1 ? "s" : ""}&nbsp;&middot;&nbsp;
        {formatRelative(meta.updatedAt)}
      </div>
    </div>
  );
};

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
    <div style={{ fontWeight: 600, color: "var(--text-2)" }}>
      No boards yet
    </div>
    <button
      onClick={onCreate}
      style={{
        padding: "8px 20px",
        fontSize: 13,
        fontWeight: 500,
        background: "var(--text)",
        color: "var(--bg)",
        border: "none",
        cursor: "pointer",
      }}
    >
      Create your first board
    </button>
  </div>
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
