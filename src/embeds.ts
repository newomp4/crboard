// URL → embeddable iframe URL.
//
// We don't need provider scripts (Instagram embed.js etc.) — most platforms
// expose a plain /embed URL that returns a self-contained iframe page.

import type { EmbedItem } from "./types";

export type EmbedInfo = {
  provider: EmbedItem["provider"];
  embedUrl: string;
  defaultSize: { w: number; h: number };
};

const youtubeId = (url: URL): string | null => {
  if (url.hostname.endsWith("youtu.be")) {
    return url.pathname.slice(1) || null;
  }
  if (url.hostname.endsWith("youtube.com")) {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const m = url.pathname.match(/^\/(embed|shorts|live)\/([\w-]+)/);
    if (m) return m[2];
  }
  return null;
};

const instagramShortcode = (url: URL): string | null => {
  if (!url.hostname.endsWith("instagram.com")) return null;
  const m = url.pathname.match(/^\/(p|reel|tv|reels)\/([\w-]+)/);
  return m ? `${m[1] === "reels" ? "reel" : m[1]}/${m[2]}` : null;
};

const tiktokId = (url: URL): string | null => {
  if (!url.hostname.endsWith("tiktok.com")) return null;
  const m = url.pathname.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
};

export const detectEmbed = (input: string): EmbedInfo | null => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  // Default sizes include room for the ~28px source-link footer below the iframe.
  const FOOTER = 28;

  const yt = youtubeId(url);
  if (yt) {
    return {
      provider: "youtube",
      embedUrl: `https://www.youtube.com/embed/${yt}`,
      defaultSize: { w: 560, h: 315 + FOOTER },
    };
  }

  const ig = instagramShortcode(url);
  if (ig) {
    return {
      provider: "instagram",
      embedUrl: `https://www.instagram.com/${ig}/embed/`,
      defaultSize: { w: 360, h: 640 + FOOTER },
    };
  }

  const tt = tiktokId(url);
  if (tt) {
    return {
      provider: "tiktok",
      embedUrl: `https://www.tiktok.com/embed/v2/${tt}`,
      defaultSize: { w: 340, h: 600 + FOOTER },
    };
  }

  return {
    provider: "generic",
    embedUrl: input,
    defaultSize: { w: 480, h: 360 + FOOTER },
  };
};

// Quick "looks like a URL" check for paste/drop handling.
export const looksLikeUrl = (s: string): boolean =>
  /^https?:\/\/\S+$/i.test(s.trim());

// Image URL heuristic — if the URL ends in a known image extension we treat it
// as an image rather than an embed.
export const looksLikeImageUrl = (s: string): boolean =>
  /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i.test(s.trim());
