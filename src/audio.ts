// Helpers for the audio item — file detection, draft building, and the
// one-time waveform decode.
//
// The waveform is the interesting part: at import time we run the file through
// the Web Audio API once and boil it down to PEAK_BUCKETS numbers (0..1 peak
// amplitude per slice of the clip). Those peaks are stored ON the item, so
// drawing the waveform — on the canvas, in home-screen previews, in the PNG
// and HTML exports — is just "draw N bars", never "decode audio again".

import type { ItemDraft } from "./types";

// Recognised audio extensions for drag/drop. .webm is deliberately absent —
// it's claimed by VIDEO_EXT and the drop handler checks video first.
export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|aiff?)$/i;

// Same reasoning (and limit) as local videos: data URLs live in localStorage,
// which caps out near 5 MB per origin after base64 inflation.
export const MAX_INLINE_AUDIO_BYTES = 6 * 1024 * 1024; // ~6 MB

export const AUDIO_FOOTER = 28; // matches the video/embed footer height
const DEFAULT_W = 340;
const DEFAULT_H = 92 + AUDIO_FOOTER;

// How many waveform buckets to keep. ~100 reads as a real waveform at any
// size the item is likely to be, while adding <1 KB to the saved board.
export const PEAK_BUCKETS = 96;

export function fileAudioDraft(
  dataUrl: string,
  fileName: string,
  center: { x: number; y: number },
  meta?: { duration: number; peaks?: number[] },
): ItemDraft {
  return {
    type: "audio",
    src: dataUrl,
    fileName,
    duration: meta?.duration,
    peaks: meta?.peaks,
    x: center.x - DEFAULT_W / 2,
    y: center.y - DEFAULT_H / 2,
    w: DEFAULT_W,
    h: DEFAULT_H,
  };
}

// Decode the clip once and reduce it to duration + peaks. If the Web Audio
// decoder rejects the codec (rare — a file <audio> can still play), fall back
// to probing duration with an off-screen element and no peaks; the player
// then renders a neutral placeholder waveform.
export async function audioFileMeta(
  src: string,
): Promise<{ duration: number; peaks?: number[] }> {
  try {
    const bytes = await (await fetch(src)).arrayBuffer();
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(bytes);
      return { duration: decoded.duration, peaks: computePeaks(decoded) };
    } finally {
      void ctx.close();
    }
  } catch {
    return { duration: await probeDuration(src) };
  }
}

// Max |sample| per bucket across all channels, normalized so the loudest
// bucket is 1. Samples are strided so even an hour-long file costs at most a
// few hundred thousand reads. Rounded to 2 decimals to keep the JSON tiny.
function computePeaks(buffer: AudioBuffer): number[] {
  const len = buffer.length;
  if (len === 0) return [];
  const bucketLen = len / PEAK_BUCKETS;
  const stride = Math.max(1, Math.floor(bucketLen / 2000));
  const peaks = new Array<number>(PEAK_BUCKETS).fill(0);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let b = 0; b < PEAK_BUCKETS; b++) {
      const start = Math.floor(b * bucketLen);
      const end = Math.min(len, Math.floor((b + 1) * bucketLen));
      let peak = peaks[b];
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      peaks[b] = peak;
    }
  }
  const max = Math.max(0.01, ...peaks);
  return peaks.map((p) => Math.round((p / max) * 100) / 100);
}

function probeDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () =>
      resolve(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => resolve(0);
    a.src = src;
  });
}

// Resample the stored peaks down to n bars (max over each covered range), for
// renderers that draw fewer bars than PEAK_BUCKETS on narrow items. Also the
// single source of the placeholder shape when a clip has no peaks.
export function resamplePeaks(
  peaks: number[] | undefined,
  n: number,
): number[] {
  if (!peaks || peaks.length === 0) {
    // Neutral rolling pattern — deliberately regular so it doesn't pretend to
    // be real signal.
    return Array.from(
      { length: n },
      (_, i) => 0.35 + 0.3 * Math.abs(Math.sin(i * 0.55)),
    );
  }
  if (n >= peaks.length) return peaks;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * peaks.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let j = start; j < end; j++) if (peaks[j] > m) m = peaks[j];
    out[i] = m;
  }
  return out;
}
