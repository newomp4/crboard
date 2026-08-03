// Rendering for the trimmable video item.
//
// Two sources, one behaviour: play the clip [clipStart, clipEnd] and loop it.
//   - Local files use a plain <video>; we watch timeupdate and seek back to
//     clipStart when we cross clipEnd (native `loop` can't loop a sub-range).
//   - YouTube uses the IFrame Player API so we can seek/loop programmatically —
//     the raw embed URL's start/end params can't loop a portion reliably.
//
// Like embeds, a transparent overlay sits over the media until the user
// double-clicks to "engage" it (interactive=true), so dragging/selecting the
// item doesn't get swallowed by the player controls.

import { useEffect, useRef } from "react";
import type { Item } from "./types";
import type { Action } from "./store";
import { formatClock } from "./video";
import { registerVideo } from "./videoPlayback";

type VideoItemT = Extract<Item, { type: "video" }>;

export const VideoBody = ({
  item,
  interactive,
  dispatch,
}: {
  item: VideoItemT;
  interactive: boolean;
  dispatch: React.Dispatch<Action>;
}) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        overflow: "hidden",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <div style={{ flex: 1, position: "relative", minHeight: 0, background: "#000" }}>
        {item.kind === "file" ? (
          <FileVideo item={item} interactive={interactive} dispatch={dispatch} />
        ) : (
          <YouTubeVideo item={item} interactive={interactive} dispatch={dispatch} />
        )}
        {!interactive && (
          <div
            style={{ position: "absolute", inset: 0, cursor: "default", background: "transparent" }}
            title="Double-click to use controls (Esc to exit)"
          />
        )}
        {interactive && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              right: 6,
              top: 6,
              fontSize: 10,
              padding: "2px 6px",
              color: "var(--text-2)",
              background: "var(--chrome-bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
              pointerEvents: "none",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            Esc to exit
          </div>
        )}
      </div>
      <VideoFooter item={item} />
    </div>
  );
};

// ── Local file playback ───────────────────────────────────────────────────────

const FileVideo = ({
  item,
  interactive,
  dispatch,
}: {
  item: VideoItemT;
  interactive: boolean;
  dispatch: React.Dispatch<Action>;
}) => {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const onLoaded = () => {
      if (item.duration == null && Number.isFinite(v.duration)) {
        dispatch({ type: "updateItem", id: item.id, patch: { duration: v.duration } });
      }
      if (v.currentTime < item.clipStart) v.currentTime = item.clipStart;
    };
    const onTime = () => {
      const end = item.clipEnd ?? v.duration;
      if (Number.isFinite(end) && v.currentTime >= end - 0.03) {
        if (item.loop) {
          v.currentTime = item.clipStart;
          v.play().catch(() => {});
        } else {
          v.pause();
        }
      } else if (v.currentTime < item.clipStart - 0.25) {
        v.currentTime = item.clipStart;
      }
    };
    v.addEventListener("loadedmetadata", onLoaded);
    v.addEventListener("timeupdate", onTime);
    return () => {
      v.removeEventListener("loadedmetadata", onLoaded);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [item.id, item.clipStart, item.clipEnd, item.loop, item.duration, dispatch]);

  // Keep the playhead inside the clip when the user drags the trim handles.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.currentTime < item.clipStart || (item.clipEnd != null && v.currentTime > item.clipEnd)) {
      v.currentTime = item.clipStart;
    }
  }, [item.clipStart, item.clipEnd]);

  // Expose playback to the trim panel (live playhead + click-to-seek).
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    return registerVideo(item.id, {
      getTime: () => v.currentTime,
      seek: (t) => {
        v.currentTime = t;
      },
    });
  }, [item.id]);

  return (
    <video
      ref={ref}
      src={item.src}
      autoPlay
      muted={item.muted}
      playsInline
      controls={interactive}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        display: "block",
        background: "#000",
        pointerEvents: interactive ? "auto" : "none",
      }}
    />
  );
};

// ── YouTube playback via the IFrame Player API ────────────────────────────────

// Load the API script once; resolve when window.YT.Player is constructable.
let ytApiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  const w = window as unknown as { YT?: { Player?: unknown }; onYouTubeIframeAPIReady?: () => void };
  if (w.YT && w.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise<void>((resolve) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      if (typeof prev === "function") prev();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
  return ytApiPromise;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const YouTubeVideo = ({
  item,
  interactive,
  dispatch,
}: {
  item: VideoItemT;
  interactive: boolean;
  dispatch: React.Dispatch<Action>;
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const pollRef = useRef<number | null>(null);
  const unregRef = useRef<(() => void) | null>(null);
  // Latest clip params, read by the poll loop without recreating the player.
  const clip = useRef({ start: item.clipStart, end: item.clipEnd, loop: item.loop });
  clip.current = { start: item.clipStart, end: item.clipEnd, loop: item.loop };

  // Create the player once per video id. Clip changes are picked up via the ref.
  useEffect(() => {
    let cancelled = false;
    // YT.Player replaces its target node, so hand it a throwaway child we create
    // imperatively — React never manages that node, avoiding removeChild clashes.
    const host = hostRef.current;
    if (!host) return;
    const target = document.createElement("div");
    target.style.width = "100%";
    target.style.height = "100%";
    host.appendChild(target);

    const poll = () => {
      const p = playerRef.current;
      if (p && typeof p.getCurrentTime === "function") {
        const t = p.getCurrentTime();
        const end = clip.current.end;
        if (end != null && t >= end - 0.1) {
          if (clip.current.loop) p.seekTo(clip.current.start, true);
          else p.pauseVideo();
        } else if (t < clip.current.start - 0.35) {
          p.seekTo(clip.current.start, true);
        }
      }
      // Snappy poll so the clip loops tightly and the playhead reads smoothly.
      pollRef.current = window.setTimeout(poll, 90);
    };

    loadYouTubeApi().then(() => {
      if (cancelled) return;
      const YT = (window as any).YT;
      playerRef.current = new YT.Player(target, {
        videoId: item.youtubeId,
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          start: Math.floor(item.clipStart) || 0,
        },
        events: {
          onReady: (e: any) => {
            if (item.muted) e.target.mute();
            else e.target.unMute();
            e.target.playVideo();
            const d = e.target.getDuration?.();
            if (d && item.duration == null) {
              dispatch({ type: "updateItem", id: item.id, patch: { duration: d } });
            }
            unregRef.current = registerVideo(item.id, {
              getTime: () => e.target.getCurrentTime?.() ?? 0,
              seek: (t) => e.target.seekTo(t, true),
            });
            poll();
          },
          onStateChange: (e: any) => {
            // 0 = ENDED → restart the clip when looping.
            if (e.data === 0 && clip.current.loop) {
              e.target.seekTo(clip.current.start, true);
              e.target.playVideo();
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      unregRef.current?.();
      unregRef.current = null;
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* player may already be gone */
      }
      playerRef.current = null;
      host.removeChild(target);
    };
    // Only recreate when the underlying video changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.youtubeId]);

  // Reflect the mute toggle onto a live player.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || typeof p.mute !== "function") return;
    if (item.muted) p.mute();
    else p.unMute();
  }, [item.muted]);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: interactive ? "auto" : "none" }}>
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Footer ────────────────────────────────────────────────────────────────────

const VideoFooter = ({ item }: { item: VideoItemT }) => {
  const clip =
    item.clipEnd != null
      ? `${formatClock(item.clipStart)}–${formatClock(item.clipEnd)}`
      : item.clipStart > 0
        ? `from ${formatClock(item.clipStart)}`
        : null;
  const label = item.kind === "youtube" ? "YouTube" : item.fileName || "Video";
  const inner = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderTop: "1px solid var(--border)",
        background: "var(--surface-2)",
        fontSize: 11,
        color: "var(--text-2)",
        flexShrink: 0,
      }}
    >
      <FilmIcon />
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
        {label}
      </span>
      {clip && (
        <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--text-3)" }}>
          {clip}
          {item.loop ? " · loop" : ""}
        </span>
      )}
    </div>
  );

  if (item.kind === "youtube") {
    return (
      <a
        href={item.src}
        target="_blank"
        rel="noreferrer"
        draggable={false}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        title={item.src}
        style={{ textDecoration: "none", color: "inherit" }}
      >
        {inner}
      </a>
    );
  }
  return inner;
};

const FilmIcon = () => (
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
    <rect x="3" y="4" width="18" height="16" rx="1" />
    <path d="M3 9h18M3 15h18M8 4v16M16 4v16" />
  </svg>
);
