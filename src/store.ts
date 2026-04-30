// Board state. We use useReducer so all mutations go through one place — easier
// to add undo later, easier to autosave on every change.

import { useEffect, useMemo, useReducer } from "react";
import { nanoid } from "nanoid";
import type { Board, Item, ItemDraft, Tool, View } from "./types";
import { emptyBoard } from "./types";

const STORAGE_KEY = "crboard:current";

export type State = {
  board: Board;
  selection: Set<string>;
  tool: Tool;
};

export type Action =
  | { type: "addItem"; item: ItemDraft }
  | { type: "addItems"; items: ItemDraft[] }
  | { type: "updateItem"; id: string; patch: Partial<Item> }
  | { type: "removeItems"; ids: string[] }
  | { type: "selectOnly"; ids: string[] }
  | { type: "selectToggle"; id: string }
  | { type: "clearSelection" }
  | { type: "setTool"; tool: Tool }
  | { type: "setView"; view: View }
  | { type: "setName"; name: string }
  | { type: "bringToFront"; id: string }
  | { type: "loadBoard"; board: Board }
  | { type: "newBoard" };

const topZ = (items: Item[]) =>
  items.reduce((m, it) => Math.max(m, it.z), 0);

const touch = (board: Board): Board => ({ ...board, updatedAt: Date.now() });

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "addItem": {
      const z = topZ(state.board.items) + 1;
      const item = { ...action.item, id: nanoid(8), z } as Item;
      return {
        ...state,
        board: touch({ ...state.board, items: [...state.board.items, item] }),
        selection: new Set([item.id]),
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
    case "selectOnly":
      return { ...state, selection: new Set(action.ids) };
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
  }
};

const loadInitial = (): State => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const board = JSON.parse(raw) as Board;
      if (board && board.version === 1) {
        return { board, selection: new Set(), tool: "select" };
      }
    }
  } catch {
    // ignore corrupt localStorage
  }
  return { board: emptyBoard(), selection: new Set(), tool: "select" };
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

  const selectedItems = useMemo(
    () => state.board.items.filter((it) => state.selection.has(it.id)),
    [state.board.items, state.selection],
  );

  return { state, dispatch, selectedItems };
};
