// Shared types for the board.
// An "item" is anything that lives on the canvas. Each item has a position and
// size in WORLD coordinates (not pixels on the screen). Pan/zoom translates
// world coords to screen coords at render time.

// Tools that *change canvas behavior* on mousedown.
// Adding images/embeds is a one-shot action triggered from the toolbar
// (file picker / URL prompt), not a persistent canvas mode.
export type Tool = "select" | "text" | "pen";

export type Theme = "light" | "dark";

export type View = {
  x: number; // pixel offset of the world origin from the top-left of the viewport
  y: number;
  zoom: number; // 1 = 100%
};

type Base = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
};

export type TextItem = Base & {
  type: "text";
  text: string;
  fontSize: number;
};

export type ImageItem = Base & {
  type: "image";
  src: string; // data URL or http(s) URL
  alt?: string;
};

export type EmbedItem = Base & {
  type: "embed";
  url: string;
  provider: "youtube" | "instagram" | "tiktok" | "generic";
};

export type LinkItem = Base & {
  type: "link";
  url: string;
  title?: string;
};

export type Stroke = {
  d: string; // SVG path "d" attribute
  strokeWidth: number;
  color: string;
};

export type DrawingItem = Base & {
  type: "drawing";
  strokes: Stroke[];
};

export type Item = TextItem | ImageItem | EmbedItem | LinkItem | DrawingItem;

export type Board = {
  version: 1;
  name: string;
  items: Item[];
  view: View;
  createdAt: number;
  updatedAt: number;
};

// Distributive Omit — preserves the discriminated union when removing keys.
// Plain `Omit<Item, "id">` collapses the union into one big object and TS
// loses the ability to narrow on `type`. Distribution only kicks in when a
// generic type parameter is the bare LHS of a conditional, so we wrap it.
type DistributiveOmit<T, K extends keyof any> = T extends unknown
  ? Omit<T, K>
  : never;
export type ItemDraft = DistributiveOmit<Item, "id" | "z">;

export const emptyBoard = (name = "Untitled board"): Board => ({
  version: 1,
  name,
  items: [],
  view: { x: 0, y: 0, zoom: 1 },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
