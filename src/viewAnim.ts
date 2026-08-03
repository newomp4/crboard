// Smoothly animates the canvas camera (pan + zoom) between two views.
//
// Discrete "jump" commands — Fit, Reset zoom, Zoom-to-selection, the +/- zoom
// buttons — used to snap the view instantly, which reads as cheap. They now
// call animateView() so the board glides like a real camera.
//
// Live gestures (wheel / trackpad pan-zoom) stay instant: they call
// cancelViewAnim() first so an in-flight tween doesn't fight the user's input.
//
// One tween runs at a time (module-level rAF handle); starting a new one
// cancels the previous. Everything is pure transform math on the view object,
// so it's GPU-cheap and never touches layout.
import type { View } from "./types";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

const prefersReduced = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

let rafId: number | null = null;

// Stop any in-flight camera animation. Called by live pan/zoom so the user's
// direct input always wins over a tween.
export function cancelViewAnim() {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

export function animateView(
  from: View,
  to: View,
  onFrame: (v: View) => void,
  duration = 340,
) {
  cancelViewAnim();

  // Already there, or the user asked for no motion → jump straight to target.
  const dz = Math.abs(to.zoom - from.zoom);
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (prefersReduced() || (dz < 0.001 && dx < 0.5 && dy < 0.5)) {
    onFrame(to);
    return;
  }

  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const e = easeOutCubic(t);
    onFrame({
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
      zoom: from.zoom + (to.zoom - from.zoom) * e,
    });
    if (t < 1) rafId = requestAnimationFrame(tick);
    else rafId = null;
  };
  rafId = requestAnimationFrame(tick);
}
