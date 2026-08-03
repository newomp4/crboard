// Rendering + playback for the audio item: a waveform you can click to seek,
// a play/pause button, and a footer with the file name and a time readout.
//
// The waveform is drawn from item.peaks (precomputed at import — see audio.ts)
// as SVG bars, so it inherits theme colors via CSS variables and stays crisp
// at any zoom. Played progress is a second, ink-colored copy of the bars
// revealed by a clipPath rect. Progress updates during playback go straight to
// the DOM (clip rect width + time label text) from a rAF loop — no React
// re-renders at 60fps.
//
// Unlike embeds/videos there's no double-click-to-engage step: the player is
// our own UI, so the button and waveform simply stopPropagation and everything
// else on the card still drags the item.

import { useEffect, useRef, useState } from "react";
import type { Item } from "./types";
import type { Action } from "./store";
import { AUDIO_FOOTER, PEAK_BUCKETS, resamplePeaks } from "./audio";
import { formatClock } from "./video";

type AudioItemT = Extract<Item, { type: "audio" }>;

const PAD = 12; // player-area padding
const BTN = 36; // play button diameter
const GAP = 12; // button → waveform gap

export const AudioBody = ({
  item,
  dispatch,
}: {
  item: AudioItemT;
  dispatch: React.Dispatch<Action>;
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);

  // Waveform geometry in world units, derived from the item box so the SVG
  // viewBox matches its on-screen size and bars never distort.
  const wfW = Math.max(40, item.w - PAD * 2 - BTN - GAP);
  const wfH = Math.max(20, item.h - AUDIO_FOOTER - PAD * 2);
  const step = 5; // bar + gap
  const barW = 3;
  const n = Math.max(12, Math.min(PEAK_BUCKETS, Math.floor(wfW / step)));
  const bars = resamplePeaks(item.peaks, n);
  // Latest geometry for the rAF painter (which must not close over stale w).
  const geomRef = useRef({ wfW });
  geomRef.current = { wfW };

  const paint = () => {
    const a = audioRef.current;
    if (!a) return;
    const dur = item.duration ?? (Number.isFinite(a.duration) ? a.duration : 0);
    const frac = dur > 0 ? Math.min(1, a.currentTime / dur) : 0;
    clipRef.current?.setAttribute("width", String(frac * geomRef.current.wfW));
    if (timeRef.current) {
      timeRef.current.textContent = `${formatClock(a.currentTime)} / ${formatClock(dur)}`;
    }
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;

  // Wire element events once per item: cache duration onto the item the first
  // time the metadata reports it, mirror play state, run the rAF painter only
  // while actually playing.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const tick = () => {
      paintRef.current();
      rafRef.current = requestAnimationFrame(tick);
    };
    const stopTick = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      paintRef.current();
    };
    const onLoaded = () => {
      if (item.duration == null && Number.isFinite(a.duration)) {
        dispatch({ type: "updateItem", id: item.id, patch: { duration: a.duration } });
      }
      paintRef.current();
    };
    const onPlay = () => {
      setPlaying(true);
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
    };
    const onStop = () => {
      setPlaying(false);
      stopTick();
    };
    a.addEventListener("loadedmetadata", onLoaded);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onStop);
    a.addEventListener("ended", onStop);
    if (a.readyState >= 1) onLoaded();
    return () => {
      a.removeEventListener("loadedmetadata", onLoaded);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onStop);
      a.removeEventListener("ended", onStop);
      stopTick();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // Repaint when the box is resized (the clip rect width is in viewBox units).
  useEffect(() => {
    paintRef.current();
  }, [wfW]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  };

  // Click / drag on the waveform seeks. Capture the pointer so a scrub keeps
  // tracking outside the SVG; stopPropagation so it never drags the item.
  const onWavePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    e.stopPropagation();
    const svg = svgRef.current;
    const a = audioRef.current;
    if (!svg || !a) return;
    svg.setPointerCapture(e.pointerId);
    const seekTo = (clientX: number) => {
      const r = svg.getBoundingClientRect();
      const dur = item.duration ?? (Number.isFinite(a.duration) ? a.duration : 0);
      if (r.width <= 0 || dur <= 0) return;
      const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      a.currentTime = frac * dur;
      paintRef.current();
    };
    seekTo(e.clientX);
    const onMove = (ev: PointerEvent) => seekTo(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const clipId = `audio-clip-${item.id}`;
  const barHeights = bars.map((p) => Math.max(2, p * wfH * 0.92));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        overflow: "hidden",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <audio ref={audioRef} src={item.src} preload="metadata" />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          gap: GAP,
          padding: PAD,
        }}
      >
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          style={{
            width: BTN,
            height: BTN,
            flexShrink: 0,
            borderRadius: "50%",
            border: "1px solid var(--border-strong)",
            background: playing ? "var(--text)" : "var(--surface)",
            color: playing ? "var(--bg)" : "var(--text)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            padding: 0,
          }}
        >
          {playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <svg
          ref={svgRef}
          onPointerDown={onWavePointerDown}
          viewBox={`0 0 ${wfW} ${wfH}`}
          preserveAspectRatio="none"
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            display: "block",
            cursor: "pointer",
            touchAction: "none",
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect ref={clipRef} x="0" y="0" width="0" height={wfH} />
            </clipPath>
          </defs>
          <WaveBars n={n} step={step} barW={barW} wfH={wfH} heights={barHeights} fill="var(--text-faint)" />
          <g clipPath={`url(#${clipId})`}>
            <WaveBars n={n} step={step} barW={barW} wfH={wfH} heights={barHeights} fill="var(--text)" />
          </g>
        </svg>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          fontSize: 11,
          color: "var(--text-2)",
          flexShrink: 0,
        }}
      >
        <MusicIcon />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: "var(--text)",
            fontWeight: 500,
          }}
        >
          {item.fileName || "Audio"}
        </span>
        <span
          ref={timeRef}
          style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}
        >
          {`0:00 / ${formatClock(item.duration ?? 0)}`}
        </span>
      </div>
    </div>
  );
};

// One pass of waveform bars, vertically centered. Rendered twice (faint base +
// ink progress copy under a clipPath), so it's factored out.
const WaveBars = ({
  n,
  step,
  barW,
  wfH,
  heights,
  fill,
}: {
  n: number;
  step: number;
  barW: number;
  wfH: number;
  heights: number[];
  fill: string;
}) => (
  <g fill={fill}>
    {Array.from({ length: n }, (_, i) => (
      <rect
        key={i}
        x={i * step}
        y={(wfH - heights[i]) / 2}
        width={barW}
        height={heights[i]}
        rx={barW / 2}
      />
    ))}
  </g>
);

const PlayGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    {/* nudged right so the triangle reads optically centered in the circle */}
    <path d="M8.5 5.5v13l11-6.5z" />
  </svg>
);

const PauseGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="6.5" y="5" width="4" height="14" rx="1" />
    <rect x="13.5" y="5" width="4" height="14" rx="1" />
  </svg>
);

const MusicIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0 }}
    aria-hidden
  >
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);
