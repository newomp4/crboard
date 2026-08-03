// Helpers for the trimmable video item — YouTube URL parsing, draft builders
// for both sources, and a metadata probe for local files.

import type { ItemDraft } from "./types";

// Recognised local video extensions (used by the file picker + drag/drop).
export const VIDEO_EXT = /\.(mp4|m4v|mov|webm|ogg|ogv)$/i;

// Local files are stored inline as data URLs, so they persist in localStorage
// and travel in exports. Base64 inflates bytes ~33% and localStorage is capped
// near 5 MB per origin, so anything much past this won't survive a reload —
// the "Add video" flow warns and steers large files toward YouTube.
export const MAX_INLINE_VIDEO_BYTES = 6 * 1024 * 1024; // ~6 MB

const YT_DEFAULT = { w: 560, h: 315 };
const FILE_DEFAULT = { w: 480, h: 270 };
const FOOTER = 28; // matches the embed footer height

// Extract a YouTube video id from any common URL shape. Mirrors the parser in
// embeds.ts but is exported here for the video path.
export function parseYouTubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.hostname.endsWith("youtu.be")) return url.pathname.slice(1) || null;
  if (url.hostname.endsWith("youtube.com")) {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const m = url.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/);
    if (m) return m[2];
  }
  return null;
}

// A YouTube URL may carry ?t=90 / &start=90 — honour it as the initial clip
// start so pasting a timestamped link lands where the user meant.
function youtubeStartParam(input: string): number {
  try {
    const url = new URL(input.trim());
    const t = url.searchParams.get("t") ?? url.searchParams.get("start");
    if (!t) return 0;
    const n = parseInt(t.replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function youtubeVideoDraft(
  input: string,
  center: { x: number; y: number },
): ItemDraft | null {
  const id = parseYouTubeId(input);
  if (!id) return null;
  const w = YT_DEFAULT.w;
  const h = YT_DEFAULT.h + FOOTER;
  return {
    type: "video",
    kind: "youtube",
    src: `https://www.youtube.com/watch?v=${id}`,
    youtubeId: id,
    clipStart: youtubeStartParam(input),
    clipEnd: null,
    loop: true,
    muted: true,
    x: center.x - w / 2,
    y: center.y - h / 2,
    w,
    h,
  };
}

export function fileVideoDraft(
  dataUrl: string,
  fileName: string,
  center: { x: number; y: number },
  meta?: { w: number; h: number; duration: number },
): ItemDraft {
  // Fit within a sensible default box while preserving aspect ratio.
  const maxW = 520;
  let w = FILE_DEFAULT.w;
  let h = FILE_DEFAULT.h;
  if (meta && meta.w > 0 && meta.h > 0) {
    const scale = Math.min(1, maxW / meta.w);
    w = meta.w * scale;
    h = meta.h * scale;
  }
  return {
    type: "video",
    kind: "file",
    src: dataUrl,
    fileName,
    clipStart: 0,
    clipEnd: null,
    loop: true,
    muted: true,
    duration: meta?.duration,
    x: center.x - w / 2,
    y: center.y - (h + FOOTER) / 2,
    w,
    h: h + FOOTER,
  };
}

// Probe a local video's intrinsic size + duration off-screen before we place it,
// so the item lands at the right aspect ratio and the trim scrubber has a length.
export function videoFileMeta(
  src: string,
): Promise<{ w: number; h: number; duration: number }> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = () =>
      resolve({
        w: v.videoWidth || FILE_DEFAULT.w,
        h: v.videoHeight || FILE_DEFAULT.h,
        duration: Number.isFinite(v.duration) ? v.duration : 0,
      });
    v.onloadedmetadata = done;
    v.onerror = () => resolve({ w: FILE_DEFAULT.w, h: FILE_DEFAULT.h, duration: 0 });
    v.src = src;
  });
}

// mm:ss (or h:mm:ss past an hour) for the trim UI's time labels.
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}
