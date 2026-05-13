// Multi-board persistence layer.
//
// Storage layout in localStorage:
//   crboard:boards          → JSON array of BoardMeta (the index)
//   crboard:board:{id}      → full Board JSON for each board
//
// On first load we check for the old single-board key (crboard:current) and
// migrate it into the new format so no one loses their existing board.

import { nanoid } from "nanoid";
import type { Board } from "./types";
import { emptyBoard } from "./types";

export type BoardMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
};

const INDEX_KEY = "crboard:boards";
const LEGACY_KEY = "crboard:current";
export const boardDataKey = (id: string) => `crboard:board:${id}`;

// ── Read ──────────────────────────────────────────────────────────────────────

export function listBoards(): BoardMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (raw) return JSON.parse(raw) as BoardMeta[];
  } catch { /* ignore */ }
  return [];
}

export function loadBoardById(id: string): Board | null {
  try {
    const raw = localStorage.getItem(boardDataKey(id));
    if (raw) {
      const b = JSON.parse(raw) as Board;
      if (b?.version === 1) return b;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function saveBoardById(id: string, board: Board): void {
  try {
    localStorage.setItem(boardDataKey(id), JSON.stringify(board));
    // Keep the index in sync.
    const list = listBoards();
    const meta: BoardMeta = {
      id,
      name: board.name,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
      itemCount: board.items.length,
    };
    const idx = list.findIndex((m) => m.id === id);
    if (idx >= 0) list[idx] = meta;
    else list.push(meta);
    // Sort newest-first.
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch { /* quota exceeded etc. — non-fatal */ }
}

export function deleteBoardById(id: string): void {
  try {
    localStorage.removeItem(boardDataKey(id));
    const list = listBoards().filter((m) => m.id !== id);
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

// ── Create ────────────────────────────────────────────────────────────────────

export function createNewBoard(): { id: string; board: Board } {
  const id = nanoid(8);
  const board = emptyBoard();
  saveBoardById(id, board);
  return { id, board };
}

// ── Migration ─────────────────────────────────────────────────────────────────

// Call once on app start. Moves the legacy single-board entry into the new
// multi-board format so existing users keep their work.
export function migrateLegacyBoard(): void {
  try {
    if (localStorage.getItem(INDEX_KEY)) return; // already migrated
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return;
    const board = JSON.parse(raw) as Board;
    if (!board?.version) return;
    saveBoardById(nanoid(8), board);
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* ignore */ }
}
