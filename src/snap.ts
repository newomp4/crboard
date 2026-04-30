// Alignment-snap math.
//
// Given the bounding box of whatever's being dragged and the bounding boxes of
// all other items on the board, find the smallest position adjustment that
// puts a "reference line" of the dragged bbox flush with a reference line of
// some other item — within a screen-pixel threshold.
//
// Reference lines per item:
//   X axis: left edge, vertical centre, right edge
//   Y axis: top edge, horizontal centre, bottom edge
//
// We snap independently per axis: a drag can pick up an X-snap, a Y-snap,
// both, or neither.

export type Box = { x: number; y: number; w: number; h: number };

export type Guide = {
  // Coordinate of the guide line in world units (the value of the matched
  // edge — e.g. for an X-axis guide, this is the X coordinate of the line).
  pos: number;
  // The two boxes whose alignment caused the guide. We use them to draw a
  // line that spans both for visual context.
  spans: Box[];
};

export type SnapResult = {
  dx: number;
  dy: number;
  xGuide: Guide | null;
  yGuide: Guide | null;
};

export const NO_SNAP: SnapResult = {
  dx: 0,
  dy: 0,
  xGuide: null,
  yGuide: null,
};

const xRefs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
const yRefs = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];

export const computeSnap = (
  mine: Box,
  others: Box[],
  threshold: number,
): SnapResult => {
  let bestDx = 0;
  let bestDxDist = threshold + 1;
  let xGuide: Guide | null = null;
  let bestDy = 0;
  let bestDyDist = threshold + 1;
  let yGuide: Guide | null = null;

  const myXs = xRefs(mine);
  const myYs = yRefs(mine);

  for (const o of others) {
    const oXs = xRefs(o);
    const oYs = yRefs(o);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const d = oXs[j] - myXs[i];
        const ad = Math.abs(d);
        if (ad < bestDxDist) {
          bestDxDist = ad;
          bestDx = d;
          xGuide = { pos: oXs[j], spans: [mine, o] };
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const d = oYs[j] - myYs[i];
        const ad = Math.abs(d);
        if (ad < bestDyDist) {
          bestDyDist = ad;
          bestDy = d;
          yGuide = { pos: oYs[j], spans: [mine, o] };
        }
      }
    }
  }

  return {
    dx: bestDxDist <= threshold ? bestDx : 0,
    dy: bestDyDist <= threshold ? bestDy : 0,
    xGuide: bestDxDist <= threshold ? xGuide : null,
    yGuide: bestDyDist <= threshold ? yGuide : null,
  };
};
