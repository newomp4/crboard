// Board state. We use useReducer so all mutations go through one place — easier
// to add undo later, easier to autosave on every change.
//
// History model:
//   - "Discrete" actions (addItem, removeItems, setName, etc.) automatically
//     push the prior board onto the undo stack.
//   - Drags fire many `updateItem` events per second, so we DON'T push on
//     every one. Instead, the drag handler dispatches `commitHistory` once
//     at the start of the gesture to snapshot the pre-drag state.
//   - `setView`, selection, and `setTool` never affect history.

import { useEffect, useMemo, useReducer } from "react";
import { nanoid } from "nanoid";
import type { Board, Item, ItemDraft, Theme, Tool, View } from "./types";
import { emptyBoard } from "./types";

const STORAGE_KEY = "crboard:current";
const THEME_KEY = "crboard:theme";
const HISTORY_CAP = 100;

export type PenStyle = {
  color: string;
  width: number;
};

export type State = {
  board: Board;
  past: Board[];
  future: Board[];
  selection: Set<string>;
  tool: Tool;
  // Item id that should immediately enter edit mode (used for text items
  // created via the text tool — they should be ready to type into without a
  // double-click).
  editId: string | null;
  pen: PenStyle;
  theme: Theme;
};

export type Action =
  | { type: "addItem"; item: ItemDraft; edit?: boolean }
  | { type: "addItems"; items: ItemDraft[] }
  | { type: "updateItem"; id: string; patch: Partial<Item> }
  | { type: "setItemPositions"; positions: { id: string; x: number; y: number }[] }
  | {
      type: "transformItems";
      // Each entry sets the absolute geometry of one item. fontSize is optional
      // and applies only to text items (used by group resize so heading/body
      // sizes shrink in proportion when a group is scaled down).
      transforms: {
        id: string;
        x: number;
        y: number;
        w: number;
        h: number;
        fontSize?: number;
      }[];
    }
  | { type: "removeItems"; ids: string[] }
  | { type: "duplicateItems"; ids: string[]; offset?: { x: number; y: number } }
  | { type: "nudgeItems"; ids: string[]; dx: number; dy: number }
  | { type: "selectOnly"; ids: string[] }
  | { type: "selectAdd"; ids: string[] }
  | { type: "selectToggle"; id: string }
  | { type: "clearSelection" }
  | { type: "setTool"; tool: Tool }
  | { type: "setView"; view: View }
  | { type: "setName"; name: string }
  | { type: "bringToFront"; id: string }
  | { type: "sendToBack"; id: string }
  | { type: "setPen"; patch: Partial<PenStyle> }
  | { type: "loadBoard"; board: Board }
  | { type: "newBoard" }
  | { type: "commitHistory" } // snapshot current board for an upcoming drag
  | { type: "undo" }
  | { type: "redo" }
  | { type: "setEditId"; id: string | null }
  | { type: "setTheme"; theme: Theme };

const HISTORY_ACTIONS: ReadonlySet<Action["type"]> = new Set([
  "addItem",
  "addItems",
  "removeItems",
  "duplicateItems",
  "setName",
  "loadBoard",
  "newBoard",
]);

const pushHistory = (past: Board[], board: Board): Board[] => {
  const next = [...past, board];
  if (next.length > HISTORY_CAP) next.shift();
  return next;
};

const topZ = (items: Item[]) =>
  items.reduce((m, it) => Math.max(m, it.z), 0);

const touch = (board: Board): Board => ({ ...board, updatedAt: Date.now() });

const apply = (state: State, action: Action): State => {
  switch (action.type) {
    case "addItem": {
      const z = topZ(state.board.items) + 1;
      const item = { ...action.item, id: nanoid(8), z } as Item;
      return {
        ...state,
        board: touch({ ...state.board, items: [...state.board.items, item] }),
        selection: new Set([item.id]),
        editId: action.edit ? item.id : state.editId,
      };
    }
    case "addItems": {
      let z = topZ(state.board.items);
      const newItems = action.items.map((it) => {
        z += 1;
        return { ...it, id: nanoid(8), z } as Item;
      });
      return {
        ...state,
        board: touch({
          ...state.board,
          items: [...state.board.items, ...newItems],
        }),
        selection: new Set(newItems.map((i) => i.id)),
      };
    }
    case "updateItem": {
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.map((it) =>
            it.id === action.id ? ({ ...it, ...action.patch } as Item) : it,
          ),
        }),
      };
    }
    case "setItemPositions": {
      const map = new Map(action.positions.map((p) => [p.id, p]));
      if (map.size === 0) return state;
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.map((it) => {
            const p = map.get(it.id);
            return p ? { ...it, x: p.x, y: p.y } : it;
          }),
        }),
      };
    }
    case "transformItems": {
      const map = new Map(action.transforms.map((t) => [t.id, t]));
      if (map.size === 0) return state;
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.map((it) => {
            const t = map.get(it.id);
            if (!t) return it;
            const next = { ...it, x: t.x, y: t.y, w: t.w, h: t.h };
            if (it.type === "text" && typeof t.fontSize === "number") {
              return { ...next, fontSize: t.fontSize };
            }
            return next;
          }),
        }),
      };
    }
    case "removeItems": {
      const ids = new Set(action.ids);
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.filter((it) => !ids.has(it.id)),
        }),
        selection: new Set(),
      };
    }
    case "duplicateItems": {
      const ids = new Set(action.ids);
      const off = action.offset ?? { x: 24, y: 24 };
      let z = topZ(state.board.items);
      const clones: Item[] = [];
      for (const it of state.board.items) {
        if (!ids.has(it.id)) continue;
        z += 1;
        clones.push({
          ...it,
          id: nanoid(8),
          x: it.x + off.x,
          y: it.y + off.y,
          z,
        } as Item);
      }
      if (!clones.length) return state;
      return {
        ...state,
        board: touch({
          ...state.board,
          items: [...state.board.items, ...clones],
        }),
        selection: new Set(clones.map((c) => c.id)),
      };
    }
    case "nudgeItems": {
      const ids = new Set(action.ids);
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.map((it) =>
            ids.has(it.id) ? { ...it, x: it.x + action.dx, y: it.y + action.dy } : it,
          ),
        }),
      };
    }
    case "selectOnly":
      return { ...state, selection: new Set(action.ids) };
    case "selectAdd": {
      const next = new Set(state.selection);
      for (const id of action.ids) next.add(id);
      return { ...state, selection: next };
    }
    case "selectToggle": {
      const next = new Set(state.selection);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { ...state, selection: next };
    }
    case "clearSelection":
      return { ...state, selection: new Set() };
    case "setTool":
      return { ...state, tool: action.tool };
    case "setView":
      return { ...state, board: { ...state.board, view: action.view } };
    case "setName":
      return { ...state, board: touch({ ...state.board, name: action.name }) };
    case "bringToFront": {
      const z = topZ(state.board.items) + 1;
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.map((it) =>
            it.id === action.id ? { ...it, z } : it,
          ),
        }),
      };
    }
    case "sendToBack": {
      const minZ = state.board.items.reduce(
        (m, it) => Math.min(m, it.z),
        Infinity,
      );
      const z = (Number.isFinite(minZ) ? minZ : 0) - 1;
      return {
        ...state,
        board: touch({
          ...state.board,
          items: state.board.items.map((it) =>
            it.id === action.id ? { ...it, z } : it,
          ),
        }),
      };
    }
    case "setPen":
      return { ...state, pen: { ...state.pen, ...action.patch } };
    case "loadBoard":
      return {
        ...state,
        board: action.board,
        selection: new Set(),
      };
    case "newBoard":
      return {
        ...state,
        board: emptyBoard(),
        selection: new Set(),
      };
    case "setEditId":
      return { ...state, editId: action.id };
    case "setTheme": {
      // When switching themes, swap the pen color too if it's currently the
      // theme-default. (User may have manually picked a custom shade — leave
      // those alone.)
      let pen = state.pen;
      if (action.theme === "dark" && state.pen.color === "#0a0a0a") {
        pen = { ...state.pen, color: "#fafafa" };
      } else if (action.theme === "light" && state.pen.color === "#fafafa") {
        pen = { ...state.pen, color: "#0a0a0a" };
      }
      return { ...state, theme: action.theme, pen };
    }
    // History actions handled in the wrapping reducer.
    case "commitHistory":
    case "undo":
    case "redo":
      return state;
  }
};

const reducer = (state: State, action: Action): State => {
  if (action.type === "undo") {
    if (state.past.length === 0) return state;
    const prev = state.past[state.past.length - 1];
    return {
      ...state,
      past: state.past.slice(0, -1),
      future: pushHistory(state.future, state.board),
      board: prev,
      selection: new Set(),
    };
  }
  if (action.type === "redo") {
    if (state.future.length === 0) return state;
    const last = state.future[state.future.length - 1];
    return {
      ...state,
      past: pushHistory(state.past, state.board),
      future: state.future.slice(0, -1),
      board: last,
      selection: new Set(),
    };
  }
  if (action.type === "commitHistory") {
    return {
      ...state,
      past: pushHistory(state.past, state.board),
      future: [],
    };
  }

  const next = apply(state, action);
  if (HISTORY_ACTIONS.has(action.type)) {
    return {
      ...next,
      past: pushHistory(state.past, state.board),
      future: [],
    };
  }
  return next;
};

const loadTheme = (): Theme => {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "dark" || raw === "light") return raw;
  } catch {
    // ignore
  }
  // Fall back to OS preference.
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
};

const loadInitial = (): State => {
  const theme = loadTheme();
  const fresh: State = {
    board: emptyBoard(),
    past: [],
    future: [],
    selection: new Set(),
    tool: "select",
    editId: null,
    pen: { color: theme === "dark" ? "#fafafa" : "#0a0a0a", width: 2 },
    theme,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const board = JSON.parse(raw) as Board;
      if (board && board.version === 1) {
        return { ...fresh, board };
      }
    }
  } catch {
    // ignore corrupt localStorage
  }
  return fresh;
};

export const useStore = () => {
  const [state, dispatch] = useReducer(reducer, undefined, loadInitial);

  // Debounced autosave to localStorage. We persist whenever the board content
  // (not just transient view/selection) changes.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.board));
      } catch {
        // Quota exceeded, etc. — non-fatal.
      }
    }, 250);
    return () => clearTimeout(t);
  }, [state.board]);

  // Theme: persist + reflect on the <html> element so CSS variables swap.
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    try {
      localStorage.setItem(THEME_KEY, state.theme);
    } catch {
      // ignore
    }
  }, [state.theme]);

  const selectedItems = useMemo(
    () => state.board.items.filter((it) => state.selection.has(it.id)),
    [state.board.items, state.selection],
  );

  return { state, dispatch, selectedItems };
};
