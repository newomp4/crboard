import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Production builds are always destined for GitHub Pages (/crboard/).
  // The dev server stays at / so localhost:5173 works normally.
  base: mode === "production" ? "/crboard/" : "/",
  server: {
    port: 5173,
  },
}));
