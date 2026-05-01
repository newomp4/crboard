// Auto-backup to a user-chosen folder using the File System Access API.
//
// Why not just download a file every 10 min? Each download would pop the
// browser's "save file" dialog and dump into ~/Downloads with names like
// "crboard-autobackup (3).crboard" — the opposite of what the user asked for.
// Instead, we ask once via showDirectoryPicker(), keep the resulting handle
// in IndexedDB so we can resume across reloads, and write straight into the
// folder. Same filename every time → previous backup gets overwritten.
//
// Browser support: Chrome / Edge / Opera / Brave / Arc all support this.
// Safari and Firefox don't yet — pickBackupDir() reports unsupported and we
// keep the menu entry hidden.

import type { Board } from "./types";

const DB_NAME = "crboard-meta";
const STORE = "kv";
const HANDLE_KEY = "backupDir";

// IndexedDB stores any structured-cloneable value, including FileSystemHandles,
// which is what makes "remember this folder forever" possible.
const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const idbGet = async <T>(key: string): Promise<T | undefined> => {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
};

const idbSet = async (key: string, value: unknown): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const idbDel = async (key: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// File System Access API types aren't fully in the standard lib yet — narrow
// them locally so TS stays happy across browser versions.
type FSPermissionDescriptor = { mode: "read" | "readwrite" };
type FSDirHandleWithPerms = FileSystemDirectoryHandle & {
  queryPermission?: (d: FSPermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (d: FSPermissionDescriptor) => Promise<PermissionState>;
};
type WindowWithFS = Window & {
  showDirectoryPicker?: (opts?: {
    mode?: "read" | "readwrite";
    id?: string;
    startIn?:
      | "desktop"
      | "documents"
      | "downloads"
      | "music"
      | "pictures"
      | "videos";
  }) => Promise<FileSystemDirectoryHandle>;
};

export const isBackupSupported = (): boolean =>
  typeof window !== "undefined" &&
  "showDirectoryPicker" in (window as WindowWithFS);

// Show a folder picker (must be called from a user gesture). Stores the handle
// for next time. Returns null if the user cancels or the API isn't supported.
export const pickBackupDir =
  async (): Promise<FileSystemDirectoryHandle | null> => {
    const w = window as WindowWithFS;
    if (!w.showDirectoryPicker) {
      alert(
        "Auto-backup needs the File System Access API. Use Chrome, Edge, Brave, or Arc.",
      );
      return null;
    }
    try {
      const handle = await w.showDirectoryPicker({
        mode: "readwrite",
        id: "crboard-backup",
        startIn: "documents",
      });
      await idbSet(HANDLE_KEY, handle);
      return handle;
    } catch {
      // User cancelled the picker — not an error.
      return null;
    }
  };

// On startup we try to silently resume the previous backup folder. If the user
// already granted persistent permission, this Just Works; otherwise it returns
// null and the menu re-prompts on the next user click.
export const loadSavedBackupDir =
  async (): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const h = await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
      if (!h) return null;
      const wp = h as FSDirHandleWithPerms;
      if (!wp.queryPermission) return h; // older API — assume granted
      const perm = await wp.queryPermission({ mode: "readwrite" });
      return perm === "granted" ? h : null;
    } catch {
      return null;
    }
  };

// Re-prompt for permission when the silent restore returned null. Must be
// invoked from a user gesture. Returns true on success.
export const requestBackupDirPermission = async (
  handle: FileSystemDirectoryHandle,
): Promise<boolean> => {
  const wp = handle as FSDirHandleWithPerms;
  if (!wp.requestPermission) return true;
  try {
    const perm = await wp.requestPermission({ mode: "readwrite" });
    return perm === "granted";
  } catch {
    return false;
  }
};

export const clearBackupDir = async (): Promise<void> => {
  await idbDel(HANDLE_KEY);
};

// Write the current board to a single fixed filename. createWritable() →
// write() → close() truncates the existing file, so each backup replaces the
// previous one — exactly the "delete the old one" behavior the user asked for.
const FILENAME = "crboard-autobackup.crboard";

export const writeBackup = async (
  handle: FileSystemDirectoryHandle,
  board: Board,
): Promise<void> => {
  const fileHandle = await handle.getFileHandle(FILENAME, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(board, null, 2));
  await writable.close();
};

export const backupFilename = FILENAME;
