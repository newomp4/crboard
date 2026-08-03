// Export the board as a single high-resolution PNG.
//
// Each item is rendered onto an offscreen HTML Canvas using the same world
// coordinates stored in the board. Scale is 3 world-units → 1 canvas pixel
// (roughly 300 DPI equivalent), capped at 12 000px on either dimension so we
// stay within browser canvas limits. An 80 world-unit border is added on all
// four sides so nothing is flush to the edge.
//
// Embed items (iframes) can't be rasterised by the browser due to cross-origin
// security. Instead, we fetch real thumbnails from each provider's public API:
//   YouTube  → img.youtube.com CDN (no auth, no CORS issues)
//   Vimeo    → vimeo.com/api/oembed.json (CORS-enabled, free)
//   Spotify  → open.spotify.com/oembed (CORS-enabled)
//   TikTok   → tiktok.com/oembed (CORS-enabled)
// Twitter, Reddit, Instagram, Loom, CodePen have no reliable cross-origin
// thumbnail source and show a labelled placeholder card instead.

import type { Board, EmbedItem, Item, Theme } from "./types";
import { resamplePeaks } from "./audio";
import geistUrl from "./fonts/Geist-Variable.woff2?url";

// Load Geist once so canvas text renders in it (the 2D context can only use
// fonts the document has actually loaded). Cached; falls back to system fonts
// if it can't load, so an export never fails over a font.
let geistLoad: Promise<void> | null = null;
function ensureGeist(): Promise<void> {
  if (!geistLoad) {
    geistLoad = (async () => {
      try {
        const face = new FontFace("Geist", `url(${geistUrl}) format("woff2")`, {
          weight: "100 900",
        });
        await face.load();
        document.fonts.add(face);
      } catch {
        /* system-font fallback */
      }
    })();
  }
  return geistLoad;
}

const PADDING = 80;   // world-unit border around all content
const BASE_SCALE = 3; // world units → canvas pixels
const MAX_DIM = 12000;

// ── Geometry helpers ─────────────────────────────────────────────────────────

function getBounds(items: Item[]) {
  if (items.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w);
    maxY = Math.max(maxY, it.y + it.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function rayBoxExit(
  start: { x: number; y: number },
  dir:   { x: number; y: number },
  box:   { x: number; y: number; w: number; h: number },
) {
  const tx = dir.x > 0 ? (box.x + box.w - start.x) / dir.x
           : dir.x < 0 ? (box.x           - start.x) / dir.x : Infinity;
  const ty = dir.y > 0 ? (box.y + box.h - start.y) / dir.y
           : dir.y < 0 ? (box.y           - start.y) / dir.y : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  return { x: start.x + dir.x * t, y: start.y + dir.y * t };
}

// ── Embed thumbnail fetching ──────────────────────────────────────────────────

// Extract YouTube video ID from any valid YouTube URL variant.
function youtubeId(url: URL): string | null {
  if (url.hostname.endsWith("youtu.be")) return url.pathname.slice(1) || null;
  if (url.hostname.endsWith("youtube.com")) {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const m = url.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/);
    if (m) return m[2];
  }
  return null;
}

// Fetch a JSON oEmbed endpoint that responds with { thumbnail_url }.
async function fetchOembedThumb(oembedUrl: string): Promise<string | null> {
  try {
    const res = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { thumbnail_url?: string };
    return data.thumbnail_url ?? null;
  } catch {
    return null;
  }
}

// Returns the best available thumbnail URL for an embed item, or null if none
// can be obtained without auth or a backend proxy.
async function getEmbedThumbnailUrl(it: EmbedItem): Promise<string | null> {
  try {
    const url = new URL(it.url);
    switch (it.provider) {
      case "youtube": {
        const id = youtubeId(url);
        // img.youtube.com is a public CDN — no auth, CORS-friendly for images.
        // Try maxres first; hqdefault is the reliable fallback.
        return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
      }
      case "vimeo": {
        // Vimeo's oEmbed endpoint has Access-Control-Allow-Origin: *.
        const id = url.pathname.match(/\/(\d+)(?:\/|$)/)?.[1];
        if (!id) return null;
        return fetchOembedThumb(
          `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(it.url)}`,
        );
      }
      case "spotify":
        return fetchOembedThumb(
          `https://open.spotify.com/oembed?url=${encodeURIComponent(it.url)}`,
        );
      case "tiktok":
        return fetchOembedThumb(
          `https://www.tiktok.com/oembed?url=${encodeURIComponent(it.url)}`,
        );
      // twitter, instagram, reddit, loom, codepen, generic — no public
      // cross-origin thumbnail source; fall through to placeholder card.
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// Load an image element from a URL; resolves to null on any error.
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ── Theme ────────────────────────────────────────────────────────────────────

type Colors = {
  bg: string; surface: string; border: string;
  text: string; text2: string; text3: string;
};

function themeColors(theme: Theme): Colors {
  const d = theme === "dark";
  return {
    bg:      d ? "#0a0a0a" : "#fafafa",
    surface: d ? "#171717" : "#ffffff",
    border:  d ? "#262626" : "#e5e5e5",
    text:    d ? "#fafafa" : "#0a0a0a",
    text2:   d ? "#d4d4d4" : "#525252",
    text3:   d ? "#a3a3a3" : "#737373",
  };
}

const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

// ── Inline markdown → runs ───────────────────────────────────────────────────

type Run = { text: string; bold: boolean; italic: boolean };

function parseInline(raw: string): Run[] {
  let s = raw
    .replace(/~~([^~\n]+?)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^\s)]+\)/g, "$1");

  const runs: Run[] = [];
  let bold = false, italic = false, buf = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("**", i) || s.startsWith("__", i)) {
      if (buf) runs.push({ text: buf, bold, italic });
      buf = ""; bold = !bold; i += 2;
    } else if (
      (s[i] === "*" && s[i + 1] !== "*") ||
      (s[i] === "_" && s[i + 1] !== "_")
    ) {
      if (buf) runs.push({ text: buf, bold, italic });
      buf = ""; italic = !italic; i++;
    } else {
      buf += s[i++];
    }
  }
  if (buf) runs.push({ text: buf, bold, italic });
  return runs.length ? runs : [{ text: s, bold: false, italic: false }];
}

// ── Item renderers ───────────────────────────────────────────────────────────

function renderTextItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "text" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
) {
  const x = wx(it.x), y = wy(it.y);
  const w = it.w * scale, h = it.h * scale;

  // Note fill: default surface card, a custom highlight, or none ("transparent"
  // drops both fill and border for the floating-label look).
  if (it.bg !== "transparent") {
    ctx.fillStyle = it.bg || colors.surface;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = Math.max(0.5, scale * 0.5);
    ctx.strokeRect(x, y, w, h);
  }

  // Ink color: custom if set, else the theme foreground.
  const ink = it.color || colors.text;

  const pad    = 12 * scale;
  const baseFz = (it.fontSize || 16) * scale;
  const baseW  = it.fontWeight || 400;
  const lh     = 1.35;
  const MULT   = [1.6, 1.35, 1.15, 1.05, 1.0, 0.9];

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const maxX = x + w - pad;
  let curY = y + pad;

  // Draw a run of styled words with word-wrapping. On-screen the text box uses
  // CSS `pre-wrap`/`break-word`, so a long paragraph flows onto multiple lines.
  // The old exporter drew each source line as one straight fillText and let the
  // clip region chop off anything past the edge — text that looked fine on the
  // board came out truncated in the PNG. Here we lay words out one at a time and
  // wrap to the next row when the next word would cross maxX, matching the board.
  const drawWrapped = (
    runs: Run[],
    fz: number,
    startX: number,
    weight: number,
  ) => {
    let curX = startX;
    let rowUsed = false; // has anything been drawn on the current visual row?
    for (const run of runs) {
      const wt = run.bold ? Math.max(weight, 700) : weight;
      const font = `${run.italic ? "italic " : ""}${wt} ${fz}px ${FONT}`;
      // Split on whitespace but keep the gaps so inter-word spacing survives.
      for (const token of run.text.split(/(\s+)/)) {
        if (token === "") continue;
        ctx.font = font;
        if (/^\s+$/.test(token)) {
          if (rowUsed) curX += ctx.measureText(" ").width;
          continue;
        }
        const tw = ctx.measureText(token).width;
        if (rowUsed && curX + tw > maxX) {
          curY += fz * lh; // wrap
          curX = startX;
          rowUsed = false;
          if (curY > y + h) return; // past the box — clip handles the rest
        }
        ctx.fillStyle = ink;
        ctx.fillText(token, curX, curY + fz * 0.8);
        curX += tw;
        rowUsed = true;
      }
    }
    curY += fz * lh;
  };

  for (const line of (it.text || "").split("\n")) {
    if (curY > y + h) break;
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      const fz = baseFz * MULT[Math.min(hm[1].length, 6) - 1];
      const clean = hm[2].replace(/\*\*|__|~~|\*|_|`/g, "");
      drawWrapped([{ text: clean, bold: true, italic: false }], fz, x + pad, 700);
      continue;
    }
    const ulm = /^[-*]\s+(.*)/.exec(line);
    const olm = /^(\d+)\.\s+(.*)/.exec(line);
    const content = ulm ? ulm[1] : olm ? olm[2] : line;
    const prefix  = ulm ? "•" : olm ? `${olm[1]}.` : null;
    const indent  = prefix ? 18 * scale : 0;

    if (prefix) {
      ctx.font = `${baseW} ${baseFz}px ${FONT}`;
      ctx.fillStyle = ink;
      ctx.fillText(prefix, x + pad, curY + baseFz * 0.8);
    }
    if (content === "") {
      curY += baseFz * lh; // blank line → one empty row
      continue;
    }
    drawWrapped(parseInline(content), baseFz, x + pad + indent, baseW);
  }
  ctx.restore();
}

// Rectangle / ellipse / sticky note. Rect + ellipse are a fill + optional
// stroke; a note additionally centers its text (word-wrapped, clipped to the box).
function renderShapeItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "shape" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
) {
  const x = wx(it.x), y = wy(it.y);
  const w = it.w * scale, h = it.h * scale;
  const sw = (it.strokeWidth || 0) * scale;
  const hasFill = it.fill !== "transparent";
  const hasStroke = it.stroke !== "transparent" && sw > 0;

  ctx.save();
  if (it.shape === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      x + w / 2, y + h / 2,
      Math.max(0, w / 2 - sw / 2), Math.max(0, h / 2 - sw / 2),
      0, 0, Math.PI * 2,
    );
  } else {
    const r = it.shape === "note" ? Math.min(6 * scale, w / 2, h / 2) : 0;
    ctx.beginPath();
    ctx.roundRect(
      x + sw / 2, y + sw / 2,
      Math.max(0, w - sw), Math.max(0, h - sw),
      r,
    );
  }
  if (hasFill) { ctx.fillStyle = it.fill; ctx.fill(); }
  if (hasStroke) { ctx.strokeStyle = it.stroke; ctx.lineWidth = sw; ctx.stroke(); }
  ctx.restore();

  if (it.shape !== "note" || !it.text) return;

  // Centered note text.
  const pad = 12 * scale;
  const fz = (it.fontSize || 16) * scale;
  const lh = fz * 1.3;
  const maxW = Math.max(0, w - pad * 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.font = `400 ${fz}px ${FONT}`;
  ctx.fillStyle = it.textColor || "#0a0a0a";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Word-wrap each hard line to the box width.
  const lines: string[] = [];
  for (const para of it.text.split("\n")) {
    if (para === "") { lines.push(""); continue; }
    let cur = "";
    for (const word of para.split(/\s+/)) {
      const trial = cur ? cur + " " + word : word;
      if (cur && ctx.measureText(trial).width > maxW) {
        lines.push(cur);
        cur = word;
      } else {
        cur = trial;
      }
    }
    lines.push(cur);
  }

  const blockH = lines.length * lh;
  let cy = y + h / 2 - blockH / 2 + fz * 0.8;
  const cx = x + w / 2;
  for (const line of lines) {
    ctx.fillText(line, cx, cy);
    cy += lh;
  }
  ctx.restore();
}

function renderLinkItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "link" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
) {
  const x = wx(it.x), y = wy(it.y);
  const w = it.w * scale, h = it.h * scale;

  ctx.fillStyle = colors.surface;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = Math.max(0.5, scale * 0.5);
  ctx.strokeRect(x, y, w, h);

  const pad     = 16 * scale;
  const titleFz = 14 * scale;
  const urlFz   = 12 * scale;
  let host = "";
  try { host = new URL(it.url).hostname; } catch (_) { host = it.url; }

  const blockH = titleFz + 4 * scale + urlFz;
  const startY = y + (h - blockH) / 2;

  ctx.font = `600 ${titleFz}px ${FONT}`;
  ctx.fillStyle = colors.text;
  ctx.fillText(it.title || host, x + pad, startY + titleFz * 0.85, w - pad * 2);

  ctx.font = `400 ${urlFz}px ${FONT}`;
  ctx.fillStyle = colors.text3;
  ctx.fillText(it.url, x + pad, startY + titleFz + 4 * scale + urlFz * 0.85, w - pad * 2);
}

// Videos can't be rasterised live any more than embeds can, so the PNG shows a
// still: YouTube gets its real thumbnail, local files get a black frame. Both
// get a play badge + a footer label so the export reads as "video here".
function renderVideoItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "video" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
  thumbnail: HTMLImageElement | null,
) {
  const x = wx(it.x), y = wy(it.y);
  const w = it.w * scale, h = it.h * scale;
  const footerH = Math.min(28 * scale, h * 0.2);
  const mediaH = h - footerH;

  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, mediaH); ctx.clip();
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, mediaH);
  if (thumbnail) drawImageCover(ctx, thumbnail, x, y, w, mediaH);
  ctx.restore();

  // Play badge: white triangle in a translucent disc, centred on the media area.
  const cx = x + w / 2, cy = y + mediaH / 2;
  const r = Math.max(10, Math.min(w, mediaH) * 0.12);
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffffff";
  const t = r * 0.5;
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.55, cy - t);
  ctx.lineTo(cx - t * 0.55, cy + t);
  ctx.lineTo(cx + t, cy);
  ctx.closePath(); ctx.fill();

  // Footer strip with a label.
  ctx.fillStyle = colors.surface;
  ctx.fillRect(x, y + mediaH, w, footerH);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = Math.max(0.5, scale * 0.5);
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  ctx.moveTo(x, y + mediaH); ctx.lineTo(x + w, y + mediaH); ctx.stroke();

  const fz = Math.min(11 * scale, footerH * 0.5);
  const pad = 10 * scale;
  ctx.font = `500 ${fz}px ${FONT}`;
  ctx.fillStyle = colors.text;
  const label = it.kind === "youtube" ? "YouTube" : it.fileName || "Video";
  ctx.fillText(label, x + pad, y + mediaH + footerH / 2 + fz * 0.35, w - pad * 2);
}

// Audio renders faithfully in a PNG — the waveform is data we already have
// (item.peaks), so draw the real player: play badge, bars, footer with name.
function renderAudioItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "audio" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
) {
  const x = wx(it.x), y = wy(it.y);
  const w = it.w * scale, h = it.h * scale;
  const footerH = Math.min(28 * scale, h * 0.25);
  const bodyH = h - footerH;

  ctx.fillStyle = colors.surface;
  ctx.fillRect(x, y, w, h);

  // Play badge on the left of the player row.
  const pad = 12 * scale;
  const btnR = Math.min(18 * scale, bodyH * 0.32);
  const bcx = x + pad + btnR, bcy = y + bodyH / 2;
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = Math.max(0.5, scale * 0.5);
  ctx.beginPath(); ctx.arc(bcx, bcy, btnR, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = colors.text;
  const t = btnR * 0.45;
  ctx.beginPath();
  ctx.moveTo(bcx - t * 0.55, bcy - t);
  ctx.lineTo(bcx - t * 0.55, bcy + t);
  ctx.lineTo(bcx + t, bcy);
  ctx.closePath(); ctx.fill();

  // Waveform bars between the badge and the right edge.
  const wfX = bcx + btnR + 12 * scale;
  const wfW = Math.max(10, x + w - pad - wfX);
  const wfH = Math.max(8, bodyH - pad * 2);
  const step = 5 * scale, barW = 3 * scale;
  const n = Math.max(8, Math.floor(wfW / step));
  const bars = resamplePeaks(it.peaks, n);
  ctx.fillStyle = colors.text2;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(2 * scale, bars[i] * wfH * 0.92);
    const bx = wfX + i * step;
    const by = y + bodyH / 2 - bh / 2;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(bx, by, barW, bh, barW / 2);
      ctx.fill();
    } else {
      ctx.fillRect(bx, by, barW, bh);
    }
  }

  // Footer strip with the file name, matching the video footer.
  ctx.fillStyle = colors.surface;
  ctx.fillRect(x, y + bodyH, w, footerH);
  ctx.strokeStyle = colors.border;
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  ctx.moveTo(x, y + bodyH); ctx.lineTo(x + w, y + bodyH); ctx.stroke();

  const fz = Math.min(11 * scale, footerH * 0.5);
  ctx.font = `500 ${fz}px ${FONT}`;
  ctx.fillStyle = colors.text;
  ctx.fillText(it.fileName || "Audio", x + 10 * scale, y + bodyH + footerH / 2 + fz * 0.35, w - 20 * scale);
}

// Draw image covering the destination rect (object-fit: cover).
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number, dy: number, dw: number, dh: number,
) {
  const imgAR = img.naturalWidth / img.naturalHeight;
  const boxAR = dw / dh;
  let sx: number, sy: number, sw: number, sh: number;
  if (imgAR > boxAR) {
    sh = img.naturalHeight; sw = sh * boxAR;
    sx = (img.naturalWidth - sw) / 2; sy = 0;
  } else {
    sw = img.naturalWidth; sh = sw / boxAR;
    sx = 0; sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function renderEmbedItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "embed" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
  thumbnail: HTMLImageElement | null,
) {
  const x = wx(it.x), y = wy(it.y);
  const w = it.w * scale, h = it.h * scale;
  const provider = it.provider === "generic" ? "embed" : it.provider;

  if (thumbnail) {
    // Draw real thumbnail filling the item box, then a small provider badge.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    drawImageCover(ctx, thumbnail, x, y, w, h);
    ctx.restore();

    // Thin border so it doesn't float on a white background.
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = Math.max(0.5, scale * 0.5);
    ctx.strokeRect(x, y, w, h);

    // Provider badge (bottom-left corner).
    const badgePad = 5 * scale;
    const badgeFz  = Math.max(8 * scale, 8);
    ctx.font = `500 ${badgeFz}px ${FONT}`;
    const labelW  = ctx.measureText(provider.toUpperCase()).width;
    const badgeW  = labelW + badgePad * 2;
    const badgeH  = badgeFz + badgePad * 2;
    const badgeX  = x + 8 * scale;
    const badgeY  = y + h - 8 * scale - badgeH;

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(provider.toUpperCase(), badgeX + badgePad, badgeY + badgePad + badgeFz * 0.82);
  } else {
    // Placeholder card: subtle background + centered provider label.
    ctx.fillStyle = colors.bg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = Math.max(0.5, scale * 0.5);
    ctx.strokeRect(x, y, w, h);

    const fz    = Math.min(14 * scale, w / 8);
    const urlFz = Math.min(11 * scale, w / 12);
    let host = "";
    try { host = new URL(it.url).hostname; } catch (_) { host = it.url; }

    ctx.textAlign = "center";
    ctx.font = `500 ${fz}px ${FONT}`;
    ctx.fillStyle = colors.text3;
    ctx.fillText(provider.toUpperCase(), x + w / 2, y + h / 2 - fz * 0.4);

    ctx.font = `400 ${urlFz}px ${FONT}`;
    ctx.fillText(host, x + w / 2, y + h / 2 + fz * 0.8, w - 24 * scale);
    ctx.textAlign = "left";
  }
}

function renderDrawingItem(
  ctx: CanvasRenderingContext2D,
  it: Extract<Item, { type: "drawing" }>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
) {
  // Stroke paths are in local coords (relative to item origin), stored in
  // world units. Translate + scale so 1 local unit = 1 canvas pixel × scale.
  ctx.save();
  ctx.translate(wx(it.x), wy(it.y));
  ctx.scale(scale, scale);
  for (const stroke of it.strokes || []) {
    ctx.beginPath();
    ctx.strokeStyle = stroke.color || "#0a0a0a";
    ctx.lineWidth   = stroke.strokeWidth || 2;
    ctx.lineCap     = "round";
    ctx.lineJoin    = "round";
    ctx.stroke(new Path2D(stroke.d));
  }
  ctx.restore();
}

// SVG path "d" for a connector — mirrors connectorPath in src/Canvas.tsx so the
// PNG matches the canvas (shape is scale-free, computed on the projected points).
function connectorPathD(
  shape: string, x1: number, y1: number, x2: number, y2: number,
): string {
  const dx = x2 - x1, dy = y2 - y1;
  if (shape === "curved") {
    if (Math.abs(dx) >= Math.abs(dy))
      return `M ${x1} ${y1} C ${x1 + dx * 0.5} ${y1} ${x2 - dx * 0.5} ${y2} ${x2} ${y2}`;
    return `M ${x1} ${y1} C ${x1} ${y1 + dy * 0.5} ${x2} ${y2 - dy * 0.5} ${x2} ${y2}`;
  }
  if (shape === "elbow") {
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = (x1 + x2) / 2;
      return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
    }
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

// Tangent directions at each endpoint (radians), so arrowheads point along the
// path — outward at the start, toward the tip at the end.
function connectorEndAngles(
  shape: string, x1: number, y1: number, x2: number, y2: number,
): { endAngle: number; startAngle: number } {
  const dx = x2 - x1, dy = y2 - y1;
  if (shape === "curved") {
    if (Math.abs(dx) >= Math.abs(dy))
      return { endAngle: Math.atan2(0, dx * 0.5), startAngle: Math.atan2(0, -dx * 0.5) };
    return { endAngle: Math.atan2(dy * 0.5, 0), startAngle: Math.atan2(-dy * 0.5, 0) };
  }
  if (shape === "elbow") {
    if (Math.abs(dx) >= Math.abs(dy)) {
      const mx = (x1 + x2) / 2;
      return { endAngle: Math.atan2(0, x2 - mx), startAngle: Math.atan2(0, x1 - mx) };
    }
    const my = (y1 + y2) / 2;
    return { endAngle: Math.atan2(y2 - my, 0), startAngle: Math.atan2(y1 - my, 0) };
  }
  return { endAngle: Math.atan2(dy, dx), startAngle: Math.atan2(-dy, -dx) };
}

function renderConnectorsLayer(
  ctx: CanvasRenderingContext2D,
  items: Item[],
  byId: Map<string, Item>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
) {
  ctx.lineJoin = "round";
  ctx.lineCap  = "round";

  for (const it of items) {
    if (it.type !== "connector") continue;
    const a = byId.get(it.from);
    const b = byId.get(it.to);
    if (!a || !b) continue;

    const fc = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const tc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const e1 = rayBoxExit(fc, { x: tc.x - fc.x, y: tc.y - fc.y }, a);
    const e2 = rayBoxExit(tc, { x: fc.x - tc.x, y: fc.y - tc.y }, b);

    const x1 = wx(e1.x), y1 = wy(e1.y);
    const x2 = wx(e2.x), y2 = wy(e2.y);

    const shape = it.shape ?? "straight";
    const ends  = it.ends ?? "one";
    const cw    = it.strokeWidth ?? 1.75;

    ctx.strokeStyle = it.color ?? colors.text2;
    ctx.fillStyle   = it.color ?? colors.text2;
    ctx.lineWidth   = cw * scale;
    ctx.stroke(new Path2D(connectorPathD(shape, x1, y1, x2, y2)));

    const { endAngle, startAngle } = connectorEndAngles(shape, x1, y1, x2, y2);
    const aLen = Math.max(6, 4 + cw * 1.6) * scale;
    const aAng = Math.PI / 6;
    const head = (tx: number, ty: number, ang: number) => {
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - aLen * Math.cos(ang - aAng), ty - aLen * Math.sin(ang - aAng));
      ctx.lineTo(tx - aLen * Math.cos(ang + aAng), ty - aLen * Math.sin(ang + aAng));
      ctx.closePath();
      ctx.fill();
    };
    if (ends !== "none") head(x2, y2, endAngle);
    if (ends === "both") head(x1, y1, startAngle);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function downloadImage(board: Board, theme: Theme = "light") {
  if (board.items.length === 0) return;

  const bounds = getBounds(board.items);
  if (!bounds) return;

  const bx = bounds.x - PADDING;
  const by = bounds.y - PADDING;
  const bw = bounds.w + PADDING * 2;
  const bh = bounds.h + PADDING * 2;

  let scale = BASE_SCALE;
  if (bw * scale > MAX_DIM) scale = MAX_DIM / bw;
  if (bh * scale > MAX_DIM) scale = Math.min(scale, MAX_DIM / bh);

  const cw = Math.round(bw * scale);
  const ch = Math.round(bh * scale);

  const canvas = document.createElement("canvas");
  canvas.width  = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;

  const colors = themeColors(theme);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, cw, ch);

  const wx = (x: number) => (x - bx) * scale;
  const wy = (y: number) => (y - by) * scale;

  const sorted = [...board.items].sort((a, b) => (a.z || 0) - (b.z || 0));
  const byId   = new Map(board.items.map((it) => [it.id, it]));

  const embedItems = sorted.filter(
    (it): it is Extract<Item, { type: "embed" }> => it.type === "embed",
  );
  const regularImages = sorted.filter(
    (it): it is Extract<Item, { type: "image" }> => it.type === "image",
  );
  const youtubeVideos = sorted.filter(
    (it): it is Extract<Item, { type: "video" }> =>
      it.type === "video" && it.kind === "youtube",
  );

  // Fetch embed + video thumbnails and load regular images in parallel.
  // Kick off font loading in parallel with the image/thumbnail fetches.
  const fontReady = ensureGeist();

  const [embedThumbnails, imageCache, videoThumbnails] = await Promise.all([
    // For each embed, try to get a real thumbnail; gracefully fall back to null.
    Promise.all(
      embedItems.map(async (it) => {
        const thumbUrl = await getEmbedThumbnailUrl(it);
        const img = thumbUrl ? await loadImage(thumbUrl) : null;
        return [it.id, img] as [string, HTMLImageElement | null];
      }),
    ).then((entries) => new Map(entries)),

    // Regular images: data URLs resolve instantly; http(s) need network.
    Promise.all(
      regularImages.map(async (it) => {
        const img = await loadImage(it.src);
        return [it.src, img] as [string, HTMLImageElement | null];
      }),
    ).then((entries) => new Map(entries)),

    // YouTube videos: use the CDN poster frame (no auth/CORS issues).
    Promise.all(
      youtubeVideos.map(async (it) => {
        const img = it.youtubeId
          ? await loadImage(`https://img.youtube.com/vi/${it.youtubeId}/hqdefault.jpg`)
          : null;
        return [it.id, img] as [string, HTMLImageElement | null];
      }),
    ).then((entries) => new Map(entries)),
  ]);

  await fontReady;

  // Render items in z-order; connectors go on top of everything.
  for (const it of sorted) {
    if (it.type === "connector") continue;
    if (it.type === "text") {
      renderTextItem(ctx, it, wx, wy, scale, colors);
    } else if (it.type === "image") {
      const img = imageCache.get(it.src);
      if (img) ctx.drawImage(img, wx(it.x), wy(it.y), it.w * scale, it.h * scale);
    } else if (it.type === "drawing") {
      renderDrawingItem(ctx, it, wx, wy, scale);
    } else if (it.type === "shape") {
      renderShapeItem(ctx, it, wx, wy, scale);
    } else if (it.type === "link") {
      renderLinkItem(ctx, it, wx, wy, scale, colors);
    } else if (it.type === "embed") {
      renderEmbedItem(
        ctx, it, wx, wy, scale, colors,
        embedThumbnails.get(it.id) ?? null,
      );
    } else if (it.type === "video") {
      renderVideoItem(
        ctx, it, wx, wy, scale, colors,
        videoThumbnails.get(it.id) ?? null,
      );
    } else if (it.type === "audio") {
      renderAudioItem(ctx, it, wx, wy, scale, colors);
    }
  }

  renderConnectorsLayer(ctx, sorted, byId, wx, wy, scale, colors);

  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href     = url;
      a.download = `${(board.name || "board").replace(/[^\w\-. ]+/g, "_")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    "image/png",
  );
}
