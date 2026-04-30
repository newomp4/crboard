# crboard

An infinite canvas for collecting things — text, images, drawings, and **embedded
social media** (Instagram reels, YouTube videos, TikToks). Like Miro, but reels
play inline. Export any board to a single self-contained HTML file you can
share with anyone.

No accounts. No backend. No hosting bill.

## Run it

```bash
npm install
npm run dev
```

Then open the printed URL (usually http://localhost:5173).

## Use it

- **Pan**: scroll, or hold space and drag, or middle-click drag.
- **Zoom**: ⌘/ctrl + scroll, or pinch on a trackpad.
- **Add text**: pick the text tool (T), click anywhere, type. Double-click to edit again.
- **Add image**: click the image button — or paste an image from your clipboard, or drag an image file onto the canvas.
- **Add an embed/link**: click the link button and paste a URL. YouTube / Instagram / TikTok auto-detect into a playable embed; everything else becomes a link card.
- **Draw**: pick the pen tool (P), drag.
- **Move / resize**: select an item with V (or just click), drag to move, drag corners to resize.
- **Delete**: select, then Backspace.

Boards autosave to your browser. **File → Save as `.crboard`** keeps a
portable JSON copy on disk.

## Share a board

**File → Export shareable .html** bundles the whole board into one HTML file:
the layout, your images (inlined), the drawings, and a tiny pan/zoom viewer.
Send the file via email, Drive, Dropbox, AirDrop — recipient double-clicks,
opens in any browser, can pan/zoom and watch the embeds. They don't need
crboard installed.

The exported file is view-only. They can re-import it in their own crboard
to keep editing (it's a valid `.crboard` JSON inside).

## How it works (short version)

- **Infinite canvas** is one HTML element with a CSS `transform:
  translate(x,y) scale(z)` applied. Items live inside it at "world"
  coordinates and the transform converts them to screen pixels. We use the
  DOM rather than a `<canvas>` element because canvases can't host iframes,
  and Instagram/YouTube/TikTok embeds *are* iframes.
- **Embeds** use each platform's plain `/embed` URL — no provider scripts,
  no API keys, no widgets to load.
- **Drawing** is recorded as `<path>` elements in an SVG layer so strokes
  scale crisply at any zoom.
- **State** is a single reducer; every change debounce-saves to
  `localStorage` so closing the tab doesn't lose your work.
- **Export** writes a self-contained HTML file with the board JSON in a
  `<script>` tag and a vanilla-JS viewer (no React, no dependencies) that
  re-renders it. The whole file is one inert document — no network calls
  beyond the embeds themselves.

## Stack

Vite · React · TypeScript · Tailwind. Everything lives in this folder —
delete the folder and nothing is left behind.

## Project layout

```
src/
  App.tsx          // shell, paste/drop handlers
  Canvas.tsx       // pan/zoom, tool dispatch, drawing
  Toolbar.tsx      // top bar + tool dock
  Item.tsx         // renders one item (text/image/embed/link/drawing)
  store.ts         // reducer + autosave
  types.ts         // Item, Board, View
  coords.ts        // screen ↔ world math
  embeds.ts        // URL → embed iframe
  io.ts            // .crboard save/open
  export.ts        // single-HTML export + bundled viewer
```
