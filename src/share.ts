// Board sharing via URL hash.
//
// The entire board + theme are compressed (deflate-raw via the browser's
// built-in CompressionStream) and base64url-encoded into the fragment:
//
//   https://newomp4.github.io/crboard/#share/<encoded>
//
// No server, no external service. The recipient opens the link; the app
// detects the prefix and renders the board read-only. Because the data lives
// in the fragment it is never sent to any server, so images stored as data
// URLs stay private to the link holder.

import type { Board, Theme } from "./types";

export const SHARE_PREFIX = "share/";

// ── Encode ────────────────────────────────────────────────────────────────────

export async function encodeShareHash(
  board: Board,
  theme: Theme,
): Promise<string> {
  const json = JSON.stringify({ board, theme });
  const compressed = await new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer();
  let binary = "";
  for (const b of new Uint8Array(compressed)) binary += String.fromCharCode(b);
  // base64url: URL-safe, no padding so no %3D in the fragment
  return (
    SHARE_PREFIX +
    btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
  );
}

// Build the full shareable URL for a hash produced by encodeShareHash.
export function buildShareUrl(hash: string): string {
  // import.meta.env.BASE_URL is '/' in dev and '/crboard/' on GitHub Pages.
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  return `${location.origin}${base}/#${hash}`;
}

// ── Decode ────────────────────────────────────────────────────────────────────

export type SharePayload = { board: Board; theme: Theme };

export async function decodeShareHash(
  hash: string,
): Promise<SharePayload | null> {
  // hash should NOT include the leading '#'
  if (!hash.startsWith(SHARE_PREFIX)) return null;
  const encoded = hash.slice(SHARE_PREFIX.length);
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const text = await new Response(
      new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw")),
    ).text();
    const payload = JSON.parse(text) as SharePayload;
    if (!payload?.board?.items) return null;
    return payload;
  } catch {
    return null;
  }
}
