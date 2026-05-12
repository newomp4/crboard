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

const FONT = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

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

  ctx.fillStyle = colors.surface;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = Math.max(0.5, scale * 0.5);
  ctx.strokeRect(x, y, w, h);

  const pad    = 12 * scale;
  const baseFz = (it.fontSize || 16) * scale;
  const baseW  = it.fontWeight || 400;
  const lh     = 1.35;
  const MULT   = [1.6, 1.35, 1.15, 1.05, 1.0, 0.9];

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  let curY = y + pad;
  for (const line of (it.text || "").split("\n")) {
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      const fz = baseFz * MULT[Math.min(hm[1].length, 6) - 1];
      ctx.font = `bold ${fz}px ${FONT}`;
      ctx.fillStyle = colors.text;
      ctx.fillText(hm[2].replace(/\*\*|__|~~|\*|_|`/g, ""), x + pad, curY + fz * 0.8);
      curY += fz * lh;
    } else {
      const ulm = /^[-*]\s+(.*)/.exec(line);
      const olm = /^(\d+)\.\s+(.*)/.exec(line);
      const content = ulm ? ulm[1] : olm ? olm[2] : line;
      const prefix  = ulm ? "•" : olm ? `${olm[1]}.` : null;
      const indent  = prefix ? 18 * scale : 0;
      const fz      = baseFz;

      if (prefix) {
        ctx.font = `${baseW} ${fz}px ${FONT}`;
        ctx.fillStyle = colors.text;
        ctx.fillText(prefix, x + pad, curY + fz * 0.8);
      }

      let curX = x + pad + indent;
      for (const run of parseInline(content)) {
        const wt = run.bold ? Math.max(baseW, 700) : baseW;
        ctx.font = `${run.italic ? "italic " : ""}${wt} ${fz}px ${FONT}`;
        ctx.fillStyle = colors.text;
        if (run.text) {
          ctx.fillText(run.text, curX, curY + fz * 0.8);
          curX += ctx.measureText(run.text).width;
        }
      }
      curY += fz * lh;
    }
    if (curY > y + h) break;
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

function renderConnectorsLayer(
  ctx: CanvasRenderingContext2D,
  items: Item[],
  byId: Map<string, Item>,
  wx: (x: number) => number,
  wy: (y: number) => number,
  scale: number,
  colors: Colors,
) {
  ctx.strokeStyle = colors.text2;
  ctx.fillStyle   = colors.text2;
  ctx.lineWidth   = 1.75 * scale;
  ctx.lineCap     = "round";

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

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const angle = Math.atan2(y2 - y1, x2 - x1);
    const aLen  = 7 * scale;
    const aAng  = Math.PI / 6;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - aLen * Math.cos(angle - aAng), y2 - aLen * Math.sin(angle - aAng));
    ctx.lineTo(x2 - aLen * Math.cos(angle + aAng), y2 - aLen * Math.sin(angle + aAng));
    ctx.closePath();
    ctx.fill();
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

  // Fetch embed thumbnails and load regular images in parallel.
  const [embedThumbnails, imageCache] = await Promise.all([
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
  ]);

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
    } else if (it.type === "link") {
      renderLinkItem(ctx, it, wx, wy, scale, colors);
    } else if (it.type === "embed") {
      renderEmbedItem(
        ctx, it, wx, wy, scale, colors,
        embedThumbnails.get(it.id) ?? null,
      );
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
