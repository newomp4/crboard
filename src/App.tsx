// Top-level app shell. Wires the store, the canvas, the toolbar, and the
// global paste/drop handlers (so you can drag-drop an image file or paste a
// URL anywhere).

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "./Canvas";
import { Toolbar } from "./Toolbar";
import { useToolShortcuts } from "./shortcuts";
import { useStore, type Action } from "./store";
import {
  extractAllUrls,
  extractUrlFromClipboard,
  itemFromUrl,
} from "./embeds";
import { fileToDataUrl } from "./io";
import {
  backupFilename,
  isBackupSupported,
  loadSavedBackupDir,
  pickBackupDir,
  clearBackupDir,
  writeBackup,
} from "./backup";
import { clampZoom } from "./coords";
import type { Item, ItemDraft } from "./types";

// Magic number used to identify clipboard payloads written by crboard, so a
// crboard paste isn't confused with arbitrary JSON the user might copy from
// elsewhere.
const CR_CLIPBOARD_TAG = "crboard/v1";

// Auto-backup runs every BACKUP_INTERVAL milliseconds while a folder is set up.
const BACKUP_INTERVAL = 10 * 60 * 1000; // 10 minutes

export type BackupInfo = {
  enabled: boolean;
  folderName: string | null;
  lastBackupAt: number | null;
  filename: string;
  supported: boolean;
};

export type BackupActions = {
  enable: () => Promise<void>;
  disable: () => Promise<void>;
};

const App = () => {
  const { state, dispatch, saveStatus } = useStore();
  useToolShortcuts(dispatch);

  // Compute world coordinates near the visible center for new items.
  const worldCenter = () => ({
    x: (window.innerWidth / 2 - state.board.view.x) / state.board.view.zoom,
    y: (window.innerHeight / 2 - state.board.view.y) / state.board.view.zoom,
  });

  // ---- auto-backup ----
  // The backup interval reads the LATEST board via a ref so the timer doesn't
  // need to be torn down/recreated on every keystroke (which would defeat the
  // 10-minute schedule).
  const [backupHandle, setBackupHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<number | null>(null);
  const boardRef = useRef(state.board);
  useEffect(() => {
    boardRef.current = state.board;
  }, [state.board]);

  // On mount, try to silently resume the previous backup folder.
  useEffect(() => {
    void (async () => {
      const h = await loadSavedBackupDir();
      if (h) setBackupHandle(h);
    })();
  }, []);

  // While a backup folder is set up, run an initial backup (so the user sees
  // the file appear) and re-run every BACKUP_INTERVAL ms.
  useEffect(() => {
    if (!backupHandle) return;
    let alive = true;
    const run = async () => {
      if (!alive) return;
      try {
        await writeBackup(backupHandle, boardRef.current);
        if (alive) setLastBackupAt(Date.now());
      } catch (err) {
        // File handle may have lost permission (folder moved, browser
        // restarted, etc.). Drop it so the user re-enables it from the menu.
        console.warn("crboard auto-backup failed:", err);
      }
    };
    void run();
    const id = setInterval(() => void run(), BACKUP_INTERVAL);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [backupHandle]);

  const backupInfo: BackupInfo = {
    enabled: backupHandle !== null,
    folderName: backupHandle?.name ?? null,
    lastBackupAt,
    filename: backupFilename,
    supported: isBackupSupported(),
  };

  const backupActions: BackupActions = {
    enable: async () => {
      const h = await pickBackupDir();
      if (h) setBackupHandle(h);
    },
    disable: async () => {
      await clearBackupDir();
      setBackupHandle(null);
      setLastBackupAt(null);
    },
  };

  // ---- find on board ----
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t?.isContentEditable ||
        t?.tagName === "INPUT" ||
        t?.tagName === "TEXTAREA"
      )
        return;
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- bulk import ----
  // Take a list of URLs, build the right item type for each (image/embed/link),
  // shelf-pack into rows up to MAX_ROW_W wide, then translate so the bbox of
  // all items lands centered on the current viewport.
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkImport = (urls: string[]) => {
    if (urls.length === 0) return;
    const tiles = urls.map((u) => {
      const d = itemFromUrl(u, { x: 0, y: 0 });
      return { ...d, x: 0, y: 0 } as ItemDraft;
    });

    // Shelf-pack: items flow left→right, wrap to a new row when adding the
    // next item would exceed MAX_ROW_W. Each row's height is the tallest
    // item in it. Gives a natural newspaper-style layout for mixed sizes.
    const MAX_ROW_W = 1400;
    const GAP = 20;
    let cx = 0,
      cy = 0,
      rowH = 0;
    for (const t of tiles) {
      if (cx + t.w > MAX_ROW_W && cx > 0) {
        cx = 0;
        cy += rowH + GAP;
        rowH = 0;
      }
      t.x = cx;
      t.y = cy;
      cx += t.w + GAP;
      if (t.h > rowH) rowH = t.h;
    }

    const bboxRight = tiles.reduce((a, t) => Math.max(a, t.x + t.w), 0);
    const bboxBottom = tiles.reduce((a, t) => Math.max(a, t.y + t.h), 0);
    const c = worldCenter();
    const shiftX = c.x - bboxRight / 2;
    const shiftY = c.y - bboxBottom / 2;
    const placed = tiles.map((t) => ({
      ...t,
      x: t.x + shiftX,
      y: t.y + shiftY,
    }));
    dispatch({ type: "addItems", items: placed });
  };

  // Copy / cut: serialize selected items as a tagged JSON blob and write to the
  // system clipboard. We store the items keeping their absolute positions so
  // paste can re-center them on the current viewport.
  useEffect(() => {
    const inEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      return Boolean(
        el?.isContentEditable ||
          el?.tagName === "INPUT" ||
          el?.tagName === "TEXTAREA",
      );
    };

    const onCopy = (e: ClipboardEvent) => {
      if (inEditable(e.target)) return;
      if (state.selection.size === 0) return;
      const items = state.board.items.filter((it) =>
        state.selection.has(it.id),
      );
      e.clipboardData?.setData(
        "text/plain",
        JSON.stringify({ tag: CR_CLIPBOARD_TAG, items }),
      );
      e.preventDefault();
    };

    const onCut = (e: ClipboardEvent) => {
      if (inEditable(e.target)) return;
      if (state.selection.size === 0) return;
      const items = state.board.items.filter((it) =>
        state.selection.has(it.id),
      );
      e.clipboardData?.setData(
        "text/plain",
        JSON.stringify({ tag: CR_CLIPBOARD_TAG, items }),
      );
      e.preventDefault();
      dispatch({ type: "removeItems", ids: [...state.selection] });
    };

    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
    };
  });

  // Paste handler: image data → image item, URL → embed/link/image, plain text → text.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") {
        return; // let the input handle it
      }

      const cd = e.clipboardData;
      if (!cd) return;

      // 0. crboard items? Detect the tagged JSON payload and add copies
      //    centered on the current viewport. Stripped of id/z so the reducer
      //    assigns fresh ones.
      const text0 = cd.getData("text/plain");
      if (text0) {
        try {
          const parsed = JSON.parse(text0);
          if (
            parsed &&
            parsed.tag === CR_CLIPBOARD_TAG &&
            Array.isArray(parsed.items) &&
            parsed.items.length > 0
          ) {
            e.preventDefault();
            const items = parsed.items as Item[];
            // Translate the bbox of pasted items so it lands centered on the viewport.
            let minX = Infinity,
              minY = Infinity,
              maxX = -Infinity,
              maxY = -Infinity;
            for (const it of items) {
              if (it.x < minX) minX = it.x;
              if (it.y < minY) minY = it.y;
              if (it.x + it.w > maxX) maxX = it.x + it.w;
              if (it.y + it.h > maxY) maxY = it.y + it.h;
            }
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const c = worldCenter();
            const dx = c.x - cx;
            const dy = c.y - cy;
            const drafts: ItemDraft[] = items.map((it) => {
              // Strip id/z; reducer regenerates them on add.
              const stripped: Record<string, unknown> = { ...it };
              delete stripped.id;
              delete stripped.z;
              return {
                ...(stripped as ItemDraft),
                x: it.x + dx,
                y: it.y + dy,
              } as ItemDraft;
            });
            dispatch({ type: "addItems", items: drafts });
            return;
          }
        } catch {
          // Not JSON — fall through to the regular paste paths below.
        }
      }

      // 1. Image file in clipboard?
      for (const item of Array.from(cd.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            const src = await fileToDataUrl(file);
            const dims = await imgSize(src);
            const max = 480;
            const scale = Math.min(1, max / Math.max(dims.w, dims.h));
            const c = worldCenter();
            dispatch({
              type: "addItem",
              item: {
                type: "image",
                src,
                x: c.x - (dims.w * scale) / 2,
                y: c.y - (dims.h * scale) / 2,
                w: dims.w * scale,
                h: dims.h * scale,
              },
            });
            return;
          }
        }
      }

      // 2a. Multi-URL paste — if the clipboard text contains 2+ distinct
      //     URLs, treat it as a bulk import (e.g. emailing yourself a list
      //     of inspiration links). Each URL becomes the right item type and
      //     they shelf-pack into a grid.
      const text2 = cd.getData("text/plain");
      if (text2) {
        const all = extractAllUrls(text2);
        if (all.length >= 2) {
          e.preventDefault();
          bulkImport(all);
          return;
        }
      }

      // 2b. Single URL we can find in the clipboard — text/uri-list,
      //     text/plain (whole or extracted substring), or text/html href.
      const url = extractUrlFromClipboard(cd);
      if (url) {
        e.preventDefault();
        const c = worldCenter();
        dispatch({ type: "addItem", item: itemFromUrl(url, c) });
        return;
      }

      // 3. Plain text → text item.
      const text = cd.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const c = worldCenter();
      dispatch({
        type: "addItem",
        item: {
          type: "text",
          text,
          fontSize: 16,
          x: c.x - 110,
          y: c.y - 40,
          w: 220,
          h: 80,
        },
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  // Drag/drop image files onto the canvas + show a "drop here" overlay while
  // files are dragged from the OS.
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // dragover fires repeatedly during a drag; use a small counter to track
    // whether we're inside a file-drag at all (browsers send dragenter/leave
    // pairs that flicker as you cross child elements, so we count them).
    let depth = 0;
    // We accept three flavors of drag:
    //   1. Files dragged from the OS (Finder, etc.) — `Files` in types.
    //   2. Images dragged FROM another browser tab — types include text/html
    //      with an <img> tag inside.
    //   3. URLs dragged from address bars or web pages — text/uri-list /
    //      text/plain.
    // For (2) and (3), we don't show the "Drop image to add to board" overlay
    // (it'd flicker on every text drag). The drop still works.
    const isFileDrag = (e: DragEvent) =>
      !!e.dataTransfer && e.dataTransfer.types.includes("Files");
    const isUrlDrag = (e: DragEvent) =>
      !!e.dataTransfer &&
      (e.dataTransfer.types.includes("text/uri-list") ||
        e.dataTransfer.types.includes("text/html") ||
        e.dataTransfer.types.includes("text/plain"));

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e) || isUrlDrag(e)) e.preventDefault();
    };

    // Pull an image URL out of dragged HTML — covers the common "drag an image
    // from Pinterest / a webpage / etc." case. We prefer this over the page
    // URL because we want the image, not the page that contains it.
    const extractDraggedImage = (dt: DataTransfer): string | null => {
      const html = dt.getData("text/html");
      if (!html) return null;
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m && /^https?:\/\//i.test(m[1])) return m[1];
      return null;
    };

    const onDrop = async (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      const dt = e.dataTransfer;
      if (!dt) return;

      // 1. OS files.
      if (dt.files && dt.files.length > 0) {
        e.preventDefault();
        const c = worldCenterAt(e.clientX, e.clientY);
        const items: ItemDraft[] = [];
        let i = 0;
        for (const f of Array.from(dt.files)) {
          if (!f.type.startsWith("image/")) continue;
          const src = await fileToDataUrl(f);
          const dims = await imgSize(src);
          const max = 480;
          const scale = Math.min(1, max / Math.max(dims.w, dims.h));
          items.push({
            type: "image",
            src,
            alt: f.name,
            x: c.x - (dims.w * scale) / 2 + i * 24,
            y: c.y - (dims.h * scale) / 2 + i * 24,
            w: dims.w * scale,
            h: dims.h * scale,
          });
          i++;
        }
        if (items.length) dispatch({ type: "addItems", items });
        return;
      }

      // 2. Image dragged from a browser tab — text/html with <img>.
      const imgUrl = extractDraggedImage(dt);
      if (imgUrl) {
        e.preventDefault();
        const c = worldCenterAt(e.clientX, e.clientY);
        dispatch({ type: "addItem", item: itemFromUrl(imgUrl, c) });
        return;
      }

      // 3. Any URL via the standard clipboard helpers.
      const url = extractUrlFromClipboard(dt);
      if (url) {
        e.preventDefault();
        const c = worldCenterAt(e.clientX, e.clientY);
        dispatch({ type: "addItem", item: itemFromUrl(url, c) });
        return;
      }
    };

    const worldCenterAt = (sx: number, sy: number) => ({
      x: (sx - state.board.view.x) / state.board.view.zoom,
      y: (sy - state.board.view.y) / state.board.view.zoom,
    });

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas state={state} dispatch={dispatch} />
      <Toolbar
        state={state}
        dispatch={dispatch}
        saveStatus={saveStatus}
        backup={backupInfo}
        backupActions={backupActions}
        onOpenBulkImport={() => setBulkOpen(true)}
      />
      {state.board.items.length === 0 && <EmptyHint />}
      {dragging && (
        <div className="drop-overlay">
          <span>Drop image to add to board</span>
        </div>
      )}
      {bulkOpen && (
        <BulkImportModal
          onClose={() => setBulkOpen(false)}
          onImport={(urls) => {
            bulkImport(urls);
            setBulkOpen(false);
          }}
        />
      )}
      {searchOpen && (
        <SearchBar
          items={state.board.items}
          dispatch={dispatch}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
};

// Floating search overlay (Cmd+F). Searches text content, link/embed URLs,
// image alt text. Enter / Down cycles through matches and zooms+selects each
// in turn. Esc closes.
const SearchBar = ({
  items,
  dispatch,
  onClose,
}: {
  items: Item[];
  dispatch: React.Dispatch<Action>;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reset position whenever the query changes — first Enter goes to match 0.
  useEffect(() => {
    setIdx(-1);
  }, [query]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Item[];
    return items.filter((it) => itemMatches(it, q));
  }, [query, items]);

  const jumpTo = (m: Item) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    // Cap zoom-in at 1.0 so a small item doesn't get blown up to 8x just
    // because it fits.
    const padded = Math.max(1, m.w + 200) || 1;
    const paddedH = Math.max(1, m.h + 200) || 1;
    const zoom = clampZoom(Math.min(1, Math.min(vw / padded, vh / paddedH)));
    dispatch({
      type: "setView",
      view: { zoom, x: vw / 2 - cx * zoom, y: vh / 2 - cy * zoom },
    });
    dispatch({ type: "selectOnly", ids: [m.id] });
  };

  const cycle = (delta: number) => {
    if (matches.length === 0) return;
    const next =
      ((idx + delta) % matches.length + matches.length) % matches.length;
    setIdx(next);
    jumpTo(matches[next]);
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 56,
        right: 12,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: 4,
        background: "var(--chrome-bg)",
        border: "1px solid var(--border)",
        backdropFilter: "blur(8px)",
        zIndex: 1500,
        fontSize: 12,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find on board…"
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            cycle(idx === -1 ? 1 : e.shiftKey ? -1 : 1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            cycle(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            cycle(-1);
          }
        }}
        style={{
          width: 200,
          padding: "4px 8px",
          fontSize: 12,
          color: "var(--text)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          outline: "none",
        }}
      />
      <span
        style={{
          minWidth: 48,
          textAlign: "center",
          color: "var(--text-3)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {matches.length === 0
          ? query.trim()
            ? "0/0"
            : ""
          : `${(idx >= 0 ? idx : 0) + 1}/${matches.length}`}
      </span>
      <button
        onClick={() => cycle(-1)}
        title="Previous (↑)"
        disabled={matches.length === 0}
        style={chromeBtnStyle}
      >
        ↑
      </button>
      <button
        onClick={() => cycle(1)}
        title="Next (↓)"
        disabled={matches.length === 0}
        style={chromeBtnStyle}
      >
        ↓
      </button>
      <button onClick={onClose} title="Close (Esc)" style={chromeBtnStyle}>
        ×
      </button>
    </div>
  );
};

const chromeBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  fontSize: 12,
  color: "var(--text-2)",
  lineHeight: 1,
};

// Returns true if the item's searchable text contains the query.
const itemMatches = (item: Item, q: string): boolean => {
  if (item.type === "text") return item.text.toLowerCase().includes(q);
  if (item.type === "link")
    return (item.url + " " + (item.title ?? "")).toLowerCase().includes(q);
  if (item.type === "embed") return item.url.toLowerCase().includes(q);
  if (item.type === "image")
    return (item.alt ?? "").toLowerCase().includes(q);
  return false;
};

// Modal for pasting/typing a list of URLs. Shows a live count of how many
// URLs were detected so the user knows what they're about to import.
const BulkImportModal = ({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (urls: string[]) => void;
}) => {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on open.
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const urls = extractAllUrls(text);

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.3)",
        zIndex: 1500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow)",
          padding: 20,
          minWidth: 480,
          maxWidth: 640,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>Import links</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            {urls.length} URL{urls.length === 1 ? "" : "s"} detected
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.4 }}>
          Paste anything containing URLs — one per line, comma-separated, or
          an email body. Each will be added as the right kind of item
          (Instagram / X / image / link) and tiled into a grid.
        </div>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"https://www.instagram.com/p/...\nhttps://x.com/.../status/...\nhttps://youtube.com/watch?v=..."}
          spellCheck={false}
          rows={12}
          style={{
            width: "100%",
            padding: 10,
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            color: "var(--text)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
            minHeight: 200,
          }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onImport(urls)}
            disabled={urls.length === 0}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              border: "1px solid var(--text)",
              background: urls.length > 0 ? "var(--text)" : "var(--surface)",
              color: urls.length > 0 ? "var(--bg)" : "var(--text-faint)",
              cursor: urls.length > 0 ? "pointer" : "not-allowed",
            }}
          >
            Import {urls.length > 0 ? urls.length : ""}
          </button>
        </div>
      </div>
    </div>
  );
};

const EmptyHint = () => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      pointerEvents: "none",
      color: "var(--text-faint)",
      fontSize: 13,
      letterSpacing: "0.02em",
      gap: 6,
    }}
  >
    <div style={{ fontWeight: 600, color: "var(--text-3)" }}>Empty board</div>
    <div>Paste a URL · drop an image · click a tool below</div>
  </div>
);

const imgSize = (src: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = src;
  });

export default App;
