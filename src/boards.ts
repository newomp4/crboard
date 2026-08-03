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

// A tiny schematic of the board for the home-screen preview: each item as a
// normalized rectangle (0..1) plus a one-letter type code for coloring. No
// pixels, no image data — just geometry, so it's cheap to store and render.
export type ThumbRect = { x: number; y: number; w: number; h: number; t: string };
export type BoardThumb = { r: ThumbRect[]; w: number; h: number };

export type BoardMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  thumb?: BoardThumb;
};

// Build the schematic from a board. Normalizes every item into the content
// bounding box using a single scale (so proportions are preserved), caps the
// count to keep the payload tiny, and drops connectors (they're lines).
export function computeThumb(board: Board): BoardThumb {
  const items = board.items.filter((it) => it.type !== "connector");
  if (items.length === 0) return { r: [], w: 1, h: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
  }
  const W = Math.max(1, maxX - minX);
  const H = Math.max(1, maxY - minY);
  const S = Math.max(W, H);
  const r = items.slice(0, 80).map((it) => ({
    x: (it.x - minX) / S,
    y: (it.y - minY) / S,
    w: Math.max(0.004, it.w / S),
    h: Math.max(0.004, it.h / S),
    t: it.type[0], // t/i/e/v/l/d
  }));
  return { r, w: W / S, h: H / S };
}

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

// Backfill thumbnails for boards saved before previews existed. Loads each such
// board once, computes its schematic, rewrites the index. Runs once from the
// home screen; afterwards every save keeps the thumb fresh.
export function backfillThumbs(): BoardMeta[] {
  const list = listBoards();
  let changed = false;
  for (const meta of list) {
    if (meta.thumb) continue;
    const board = loadBoardById(meta.id);
    if (board) {
      meta.thumb = computeThumb(board);
      changed = true;
    }
  }
  if (changed) {
    try {
      localStorage.setItem(INDEX_KEY, JSON.stringify(list));
    } catch {
      /* quota — non-fatal */
    }
  }
  return list;
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

// Throws if localStorage rejects the write (quota exceeded, private-mode, etc.).
// Callers that must surface "your work isn't being saved" rely on this throwing
// rather than silently dropping the data — see the autosave in store.ts.
export function saveBoardById(id: string, board: Board): void {
  localStorage.setItem(boardDataKey(id), JSON.stringify(board));
  // Keep the index in sync.
  const list = listBoards();
  const meta: BoardMeta = {
    id,
    name: board.name,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    itemCount: board.items.length,
    thumb: computeThumb(board),
  };
  const idx = list.findIndex((m) => m.id === id);
  if (idx >= 0) list[idx] = meta;
  else list.push(meta);
  // Sort newest-first.
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  localStorage.setItem(INDEX_KEY, JSON.stringify(list));
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
  // An empty board is tiny, but if storage is completely full even this can
  // throw — don't let that block opening the editor; autosave will surface it.
  try { saveBoardById(id, board); } catch { /* storage full — non-fatal here */ }
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
