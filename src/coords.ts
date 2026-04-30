// Coordinate helpers.
//
// The board has two coordinate systems:
//   - SCREEN coords: pixels on the user's monitor, origin at the viewport's top-left.
//   - WORLD coords: the abstract infinite plane the items live on.
//
// They are related by the canvas's pan offset (view.x, view.y) and zoom factor:
//   screen = world * zoom + offset
//   world  = (screen - offset) / zoom

import type { View } from "./types";

export type Vec2 = { x: number; y: number };

export const screenToWorld = (s: Vec2, view: View): Vec2 => ({
  x: (s.x - view.x) / view.zoom,
  y: (s.y - view.y) / view.zoom,
});

export const worldToScreen = (w: Vec2, view: View): Vec2 => ({
  x: w.x * view.zoom + view.x,
  y: w.y * view.zoom + view.y,
});

// Zoom while keeping the world point under the cursor stationary.
// This is the math that makes "scroll-wheel zoom on a map" feel right.
export const zoomAt = (
  view: View,
  cursor: Vec2,
  newZoom: number,
): View => {
  const world = screenToWorld(cursor, view);
  return {
    zoom: newZoom,
    x: cursor.x - world.x * newZoom,
    y: cursor.y - world.y * newZoom,
  };
};

export const clampZoom = (z: number) => Math.min(8, Math.max(0.1, z));
