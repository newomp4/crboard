// Save / open .crboard JSON files.
//
// .crboard is just a JSON file with a tiny version header. We use the browser's
// download trick (a temporary <a> element) to save and an <input type="file">
// to open — no server, no library.

import type { Board } from "./types";

export const saveBoardFile = (board: Board) => {
  const json = JSON.stringify(board, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeName(board.name)}.crboard`;
  a.click();
  // Give the browser a tick to start the download before revoking the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const openBoardFile = (): Promise<Board | null> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".crboard,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        const board = JSON.parse(text);
        if (board && typeof board === "object" && board.version === 1) {
          resolve(board as Board);
        } else {
          alert("That doesn't look like a crboard file.");
          resolve(null);
        }
      } catch {
        alert("Could not read that file.");
        resolve(null);
      }
    };
    input.click();
  });

// Read a File (image) and return a data URL. Used for paste/drop handlers so
// images are stored inside the board itself, no external host needed.
export const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

const sanitizeName = (s: string) =>
  s.replace(/[^\w\-. ]+/g, "_").trim() || "board";
