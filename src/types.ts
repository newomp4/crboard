// Shared types for the board.
// An "item" is anything that lives on the canvas. Each item has a position and
// size in WORLD coordinates (not pixels on the screen). Pan/zoom translates
// world coords to screen coords at render time.

// Tools that *change canvas behavior* on mousedown.
// Adding images/embeds is a one-shot action triggered from the toolbar
// (file picker / URL prompt), not a persistent canvas mode.
export type Tool = "select" | "text" | "pen" | "connector" | "shape";

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
  // Optional styling. All omit-safe so old boards keep working:
  //   color — ink color. Undefined = "auto" (the theme's foreground, so it
  //           inverts with light/dark like it always did).
  //   bg    — note fill. Undefined = the default surface card; "transparent"
  //           = no card (label style, no border); any color = a highlight fill.
  //   align — text alignment. Undefined = left.
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right";
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
    | "reddit"
    | "loom"
    | "codepen"
    | "generic";
};

export type LinkItem = Base & {
  type: "link";
  url: string;
  title?: string;
};

// A video the user can trim to a sub-range and loop. Two sources:
//   - "file": a local video stored inline as a data URL (like ImageItem.src),
//     so it travels in share links / .html / .crboard exactly like an image.
//   - "youtube": referenced by id; playback + clip-looping is driven by the
//     YouTube IFrame Player API at render time.
// clipStart/clipEnd (seconds) define the visible/looped sub-range. clipEnd null
// means "play to the end". duration is cached once the source reports it, so the
// trim scrubber can render before playback starts.
export type VideoItem = Base & {
  type: "video";
  kind: "file" | "youtube";
  src: string; // data URL (file) or canonical youtube watch URL
  youtubeId?: string;
  fileName?: string;
  clipStart: number;
  clipEnd: number | null;
  loop: boolean;
  muted: boolean;
  duration?: number;
};

// A drawn primitive: a rectangle, an ellipse, or a sticky note (a filled rect
// that also holds centered, editable text). All three share fill/stroke; notes
// add text fields. Unlike text items, a note's box is a fixed size — its text
// wraps/clips inside rather than auto-growing the card.
export type ShapeItem = Base & {
  type: "shape";
  shape: "rect" | "ellipse" | "note";
  fill: string; // fill color, or "transparent" for outline-only
  stroke: string; // border color, or "transparent" for no border
  strokeWidth: number;
  // Sticky-note text (shape === "note").
  text?: string;
  textColor?: string;
  fontSize?: number;
};

export type Stroke = {
  d: string; // SVG path "d" attribute
  strokeWidth: number;
  color: string;
};

export type DrawingItem = Base & {
  type: "drawing";
  strokes: Stroke[];
  // Intrinsic authoring size of the stroke coordinates. The SVG viewBox is
  // pinned to these so the drawing scales to fill the item box when resized,
  // instead of sitting at its original size in the corner. Optional for
  // backward-compat with drawings saved before this field existed (they fall
  // back to w/h, which is correct until the first resize).
  vw?: number;
  vh?: number;
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
  color?: string; // stroke color; defaults to the theme's muted text
  strokeWidth?: number; // line thickness; defaults to 1.75
  // Line routing: straight (default), a smooth curve, or a right-angle elbow.
  shape?: "straight" | "curved" | "elbow";
  // Arrowheads: at the "to" end only (default), both ends, or none.
  ends?: "one" | "both" | "none";
};

export type Item =
  | TextItem
  | ImageItem
  | EmbedItem
  | LinkItem
  | VideoItem
  | DrawingItem
  | ShapeItem
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
