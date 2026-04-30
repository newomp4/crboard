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

// Zoom around the centre of the viewport. Used by +/- zoom buttons.
export const zoomCenter = (view: View, vw: number, vh: number, factor: number) =>
  zoomAt(view, { x: vw / 2, y: vh / 2 }, clampZoom(view.zoom * factor));

// Compute a view that frames every item with reasonable padding.
export const fitToBounds = (
  items: { x: number; y: number; w: number; h: number }[],
  vw: number,
  vh: number,
): View => {
  if (items.length === 0) return { x: 0, y: 0, zoom: 1 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const it of items) {
    if (it.x < minX) minX = it.x;
    if (it.y < minY) minY = it.y;
    if (it.x + it.w > maxX) maxX = it.x + it.w;
    if (it.y + it.h > maxY) maxY = it.y + it.h;
  }
  const pad = 80;
  const w = maxX - minX + pad * 2;
  const h = maxY - minY + pad * 2;
  const zoom = clampZoom(Math.min(vw / w, vh / h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom };
};
