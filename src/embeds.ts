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

// Twitter / X. Both hostnames resolve to the same tweet ID, so we accept either
// and emit the platform.twitter.com embed (the iframe Twitter has shipped for
// years and that doesn't need their widget script).
const tweetId = (url: URL): string | null => {
  const h = url.hostname.replace(/^mobile\./, "");
  if (h !== "twitter.com" && h !== "x.com" && h !== "www.x.com" && h !== "www.twitter.com")
    return null;
  const m = url.pathname.match(/\/status\/(\d+)/);
  return m ? m[1] : null;
};

// Vimeo: vimeo.com/{id} or vimeo.com/{user}/{id}
const vimeoId = (url: URL): string | null => {
  if (!url.hostname.endsWith("vimeo.com")) return null;
  const m = url.pathname.match(/\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
};

// Spotify: open.spotify.com/{type}/{id} where type is track/episode/album/playlist
const spotifyPath = (url: URL): string | null => {
  if (!url.hostname.endsWith("spotify.com")) return null;
  const m = url.pathname.match(
    /^\/(track|episode|album|playlist|artist|show)\/([\w-]+)/,
  );
  return m ? `${m[1]}/${m[2]}` : null;
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

  const tw = tweetId(url);
  if (tw) {
    // The dnt=true & theme query params make the embed cleaner; the embed page
    // itself handles theming separately from those.
    return {
      provider: "twitter",
      embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${tw}&dnt=true`,
      defaultSize: { w: 480, h: 600 + FOOTER },
    };
  }

  const vid = vimeoId(url);
  if (vid) {
    return {
      provider: "vimeo",
      embedUrl: `https://player.vimeo.com/video/${vid}`,
      defaultSize: { w: 560, h: 315 + FOOTER },
    };
  }

  const sp = spotifyPath(url);
  if (sp) {
    return {
      provider: "spotify",
      embedUrl: `https://open.spotify.com/embed/${sp}`,
      // Tracks/episodes are short, playlists/albums are tall. Use a flexible default.
      defaultSize: {
        w: 360,
        h: (sp.startsWith("track/") || sp.startsWith("episode/") ? 152 : 380) +
          FOOTER,
      },
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
