// Stroke smoothing.
//
// Raw mouse points produce visibly faceted polylines. We smooth in two passes:
//   1. Distance-thinning — drop consecutive points within MIN_DIST world units
//      of each other. Cuts the path size dramatically without losing shape.
//   2. Quadratic Bezier through midpoints — for each interior point P, draw a
//      curve whose control point is P and which ends at the midpoint of P and
//      its successor. The curve passes smoothly through the midpoints, while
//      P itself acts only as a tangent guide. This is the classic "rounded
//      polyline" technique and produces fluid strokes with very little code.

export type Pt = { x: number; y: number };

const MIN_DIST = 1.5; // in world units
const MIN_DIST_SQ = MIN_DIST * MIN_DIST;

export const thinPoints = (points: Pt[]): Pt[] => {
  if (points.length < 2) return points.slice();
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const dx = points[i].x - prev.x;
    const dy = points[i].y - prev.y;
    if (dx * dx + dy * dy >= MIN_DIST_SQ) {
      out.push(points[i]);
    }
  }
  // Always preserve the last raw point so the stroke ends where the user lifted.
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
};

export const smoothPathD = (points: Pt[]): string => {
  if (points.length === 0) return "";
  if (points.length === 1) {
    // Render a "dot" for single-tap strokes by drawing a zero-length line —
    // strokeLinecap=round will turn it into a circle of stroke-width radius.
    const p = points[0];
    return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)} L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
  }
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const c = points[i];
    const next = points[i + 1];
    const mx = (c.x + next.x) / 2;
    const my = (c.y + next.y) / 2;
    d += ` Q ${c.x.toFixed(2)} ${c.y.toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
};
