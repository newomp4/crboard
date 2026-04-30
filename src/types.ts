// Shared types for the board.
// An "item" is anything that lives on the canvas. Each item has a position and
// size in WORLD coordinates (not pixels on the screen). Pan/zoom translates
// world coords to screen coords at render time.

// Tools that *change canvas behavior* on mousedown.
// Adding images/embeds is a one-shot action triggered from the toolbar
// (file picker / URL prompt), not a persistent canvas mode.
export type Tool = "select" | "text" | "pen" | "connector";

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
  fontWeight?: number; // 400 = body, 600 = heading. Defaults to 400 if omitted.
};

export type ImageItem = Base & {
  type: "image";
  src: string; // data URL or http(s) URL
  alt?: string;
};

export type EmbedItem = Base & {
  type: "embed";
  url: string;
  provider:
    | "youtube"
    | "instagram"
    | "tiktok"
    | "twitter"
    | "vimeo"
    | "spotify"
    | "generic";
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

// Connector ("arrow") between two items. The visible line is drawn each
// render from the endpoints' centers, clipped at each item's bbox so the
// arrow emerges from the item edge rather than its centre. The base x/y/w/h
// stores the bbox of the line (recomputed when endpoints move) so connectors
// participate in selection-by-rubber-band and storage like any other item.
export type ConnectorItem = Base & {
  type: "connector";
  from: string; // item id
  to: string; // item id
};

export type Item =
  | TextItem
  | ImageItem
  | EmbedItem
  | LinkItem
  | DrawingItem
  | ConnectorItem;

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
