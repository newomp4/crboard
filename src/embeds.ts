// URL → embeddable iframe URL.
//
// We don't need provider scripts (Instagram embed.js etc.) — most platforms
// expose a plain /embed URL that returns a self-contained iframe page.

import type { EmbedItem, ItemDraft } from "./types";

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

// Build the appropriate item draft for a URL, centred at a given world point:
// image URL → image item, recognised social link → embed, anything else → link card.
export const itemFromUrl = (
  url: string,
  center: { x: number; y: number },
): ItemDraft => {
  if (looksLikeImageUrl(url)) {
    return {
      type: "image",
      src: url,
      x: center.x - 200,
      y: center.y - 150,
      w: 400,
      h: 300,
    };
  }
  const info = detectEmbed(url);
  if (info && info.provider !== "generic") {
    return {
      type: "embed",
      url,
      provider: info.provider,
      x: center.x - info.defaultSize.w / 2,
      y: center.y - info.defaultSize.h / 2,
      w: info.defaultSize.w,
      h: info.defaultSize.h,
    };
  }
  return {
    type: "link",
    url,
    x: center.x - 160,
    y: center.y - 50,
    w: 320,
    h: 100,
  };
};

// Walk through the standard clipboard MIME types in priority order looking
// for something we can treat as a URL. Each branch handles a real-world quirk:
//   - text/uri-list is what Safari and many drag-drop sources set when you
//     copy a hyperlink. The format is one URL per line, # comments allowed.
//   - text/plain might be the URL itself, OR it might wrap the URL in quotes,
//     surrounding text, or a markdown link `[title](url)`. We try the whole
//     trimmed string first, then fall back to extracting the first URL-ish
//     substring.
//   - text/html is what rich-text editors set when copying a link. Pull the
//     first href out.
export const extractUrlFromClipboard = (cd: DataTransfer): string | null => {
  const uriList = cd.getData("text/uri-list");
  if (uriList) {
    for (const line of uriList.split(/[\r\n]+/)) {
      const t = line.trim();
      if (t && !t.startsWith("#") && /^https?:\/\//i.test(t)) return t;
    }
  }

  const text = cd.getData("text/plain");
  if (text) {
    const trimmed = text.trim().replace(/^['"]+|['"]+$/g, "");
    if (/^https?:\/\/\S+$/i.test(trimmed)) return trimmed;
    // Extract a URL from anywhere in the text (handles things like markdown
    // links and "Check out https://… ⇣" rich-text copies).
    const m = text.match(/https?:\/\/[^\s<>"`']+[^\s<>"`'.,;)\]}>]/);
    if (m) return m[0];
  }

  const html = cd.getData("text/html");
  if (html) {
    const m = html.match(/href=["']([^"']+)["']/i);
    if (m && /^https?:\/\//i.test(m[1])) return m[1];
  }

  return null;
};
